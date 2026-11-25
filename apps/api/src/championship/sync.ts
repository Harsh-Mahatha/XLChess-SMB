import type { PrismaClient } from '@prisma/client';
import {
  FEED_OUTAGE_ALERT_HOURS,
  detectPhase,
  makeFlag,
  matchScore,
  uniqueWinner,
  type ChampionshipPhase,
  type ChessEvent,
  type ChessGame,
  type EventStatus,
  type FlagDraft,
  type GamePlayer,
  type SourceReliability,
  type Sourced,
  type SourcesRegistry,
} from '@smb/shared';
import type { Logger } from 'pino';
import { assessGames } from '../research/games.js';
import { PlayerDirectory } from '../research/identity.js';
import { reliabilityFrom } from '../research/package.js';
import { SourceError } from '../sources/errors.js';
import type { SourceGateway } from '../sources/gateway.js';
import type { ContextResolvers } from '../scheduling/context.js';
import { emitPendingGameEvents, type EmitSummary } from './emit.js';
import { reconcileFlags } from './flags.js';
import { writeChampionshipLog } from './log.js';

export interface SyncDeps {
  db: PrismaClient;
  gateway: SourceGateway;
  registry?: SourcesRegistry;
  resolvers?: ContextResolvers;
  logger: Logger;
}

export interface SyncSummary {
  skipped?: 'no_cycle' | 'not_due';
  cycleId?: string;
  cycleKey?: string;
  phase?: ChampionshipPhase;
  previousPhase?: ChampionshipPhase;
  lastSyncStatus: 'ok' | 'source_error' | 'not_due';
  observedGames?: number;
  corroboratedGames?: number;
  flagsOpened?: number;
  flagsCleared?: number;
  emit?: EmitSummary;
}

const CADENCE_MS = {
  preFar: 60 * 60_000, // > 3 days before start: 60 min
  preNear: 5 * 60_000, // <= 3 days before start: 5 min
  tournament: 2 * 60_000, // during tournament: 2 min
} as const;

const STATUS_RANK: Record<EventStatus, number> = {
  upcoming: 1,
  in_progress: 2,
  completed: 3,
};

function isSyncDue(
  phase: ChampionshipPhase,
  scheduledStart: Date,
  lastSyncedAt: Date | null,
  now: Date,
): boolean {
  if (phase === 'post_tournament') return false;
  if (!lastSyncedAt) return true;

  let intervalMs: number;
  if (phase === 'tournament') {
    intervalMs = CADENCE_MS.tournament;
  } else {
    const msUntilStart = scheduledStart.getTime() - now.getTime();
    intervalMs = msUntilStart <= 3 * 86_400_000 ? CADENCE_MS.preNear : CADENCE_MS.preFar;
  }
  return now.getTime() - lastSyncedAt.getTime() >= intervalMs;
}

function mostAdvancedStatus(events: Sourced<ChessEvent>[]): EventStatus | null {
  let best: EventStatus | null = null;
  for (const ev of events) {
    if (!best || STATUS_RANK[ev.data.status] > STATUS_RANK[best]) {
      best = ev.data.status;
    }
  }
  return best;
}

async function buildReliabilityLookup(
  db: PrismaClient,
  registry?: SourcesRegistry,
): Promise<(sourceId: string) => SourceReliability> {
  if (registry) return reliabilityFrom(registry);
  const rows = await db.data_sources.findMany({
    where: { kind: 'data' },
    select: { id: true, config: true },
  });
  const map = new Map<string, SourceReliability>();
  for (const r of rows) {
    const rel = (r.config as { reliability?: SourceReliability } | null)?.reliability;
    if (rel) map.set(r.id, rel);
  }
  return (id) => map.get(id) ?? 'structured_feed';
}

export async function syncChampionship(
  deps: SyncDeps,
  opts?: { now?: Date; force?: boolean },
): Promise<SyncSummary> {
  const now = opts?.now ?? new Date();
  const force = opts?.force ?? false;

  const cycle = await deps.db.championship_cycles.findFirst({
    where: { post_type_id: '1.1', is_current: true },
  });
  if (!cycle) {
    return { skipped: 'no_cycle', lastSyncStatus: 'not_due' };
  }

  const currentPhase = cycle.phase as ChampionshipPhase;
  if (!force && !isSyncDue(currentPhase, cycle.scheduled_start, cycle.last_synced_at, now)) {
    await deps.db.championship_cycles.update({
      where: { id: cycle.id },
      data: { last_sync_status: 'not_due' },
    });
    return {
      skipped: 'not_due',
      cycleId: cycle.id,
      cycleKey: cycle.cycle_key,
      phase: currentPhase,
      lastSyncStatus: 'not_due',
    };
  }

  // 2. Fetch outside any long transaction (never D1).
  const sourceRefs = (cycle.source_event_refs ?? {}) as Record<string, string>;
  // Process D3 first if present, then remaining source ids deterministically.
  const sourceIds = Object.keys(sourceRefs)
    .filter((id) => id !== 'D1')
    .sort((a, b) => (a === 'D3' ? -1 : b === 'D3' ? 1 : a.localeCompare(b)));

  const fetchedEvents: Sourced<ChessEvent>[] = [];
  const fetchedGames: Sourced<ChessGame>[] = [];
  const sourceErrors: { sourceId: string; capability: string; code: string; message: string }[] =
    [];
  let callsAttempted = 0;
  let callsSucceeded = 0;

  for (const sourceId of sourceIds) {
    const ref = sourceRefs[sourceId]!;
    const caps = deps.gateway.capabilitiesOf(sourceId);
    if (caps.includes('events')) {
      callsAttempted++;
      try {
        const res = await deps.gateway.fetch(sourceId, 'events', { externalId: ref });
        fetchedEvents.push(...res.items);
        callsSucceeded++;
      } catch (err) {
        if (!(err instanceof SourceError)) throw err;
        sourceErrors.push({ sourceId, capability: 'events', code: err.code, message: err.message });
      }
    }
    if (caps.includes('games')) {
      callsAttempted++;
      try {
        const res = await deps.gateway.fetch(sourceId, 'games', { eventExternalId: ref });
        fetchedGames.push(...res.items);
        callsSucceeded++;
      } catch (err) {
        if (!(err instanceof SourceError)) throw err;
        sourceErrors.push({ sourceId, capability: 'games', code: err.code, message: err.message });
      }
    }
  }

  const allFailed = callsAttempted > 0 && callsSucceeded === 0;
  if (allFailed) {
    const outageRes = await deps.db.$transaction(async (tx) => {
      await tx.$executeRaw`select pg_advisory_xact_lock(hashtext(${'smb.championship:' + cycle.cycle_key}))`;
      await tx.championship_cycles.update({
        where: { id: cycle.id },
        data: {
          last_synced_at: now,
          last_sync_status: 'source_error',
        },
      });
      await writeChampionshipLog(tx, {
        cycleId: cycle.id,
        kind: 'sync_failed',
        actor: 'system',
        message: `Sync failed for all source calls: ${sourceErrors.map((e) => `${e.sourceId}/${e.capability}:${e.code}`).join(', ')}`,
        detail: { errors: sourceErrors },
        at: now,
      });

      const outageDrafts: FlagDraft[] = [];
      if (
        cycle.phase === 'tournament' &&
        cycle.last_feed_ok_at !== null &&
        now.getTime() - cycle.last_feed_ok_at.getTime() > FEED_OUTAGE_ALERT_HOURS * 3_600_000
      ) {
        outageDrafts.push(
          makeFlag(
            'feed_unavailable',
            `Approved feeds have been unavailable for more than ${FEED_OUTAGE_ALERT_HOURS}h (last ok at ${cycle.last_feed_ok_at.toISOString()})`,
            { detail: { lastFeedOkAt: cycle.last_feed_ok_at.toISOString() } },
          ),
        );
      }
      return reconcileFlags(tx, cycle.id, outageDrafts, now, ['feed_unavailable']);
    });

    return {
      cycleId: cycle.id,
      cycleKey: cycle.cycle_key,
      phase: currentPhase,
      lastSyncStatus: 'source_error',
      flagsOpened: outageRes.opened,
      flagsCleared: outageRes.cleared,
    };
  }

  const feedStatus = mostAdvancedStatus(fetchedEvents);
  const feedOk = fetchedEvents.length > 0 || fetchedGames.length > 0;

  // 4. Identity check.
  const playerA = cycle.player_a as unknown as GamePlayer;
  const playerB = cycle.player_b as unknown as GamePlayer;
  const directory = new PlayerDirectory([
    playerA,
    playerB,
    ...fetchedGames.flatMap((g) => [g.data.white, g.data.black]),
  ]);
  const keyA = directory.keyOf(playerA);
  const keyB = directory.keyOf(playerB);

  const validGames: Sourced<ChessGame>[] = [];
  const identityDrafts: FlagDraft[] = [];

  for (const g of fetchedGames) {
    const wKey = directory.keyOf(g.data.white);
    const bKey = directory.keyOf(g.data.black);
    const matchesPlayers = (wKey === keyA && bKey === keyB) || (wKey === keyB && bKey === keyA);
    if (!matchesPlayers) {
      const parsedNum = Number.parseInt(g.data.round ?? '', 10);
      const gameNumber = Number.isFinite(parsedNum) && parsedNum > 0 ? parsedNum : undefined;
      identityDrafts.push(
        makeFlag(
          'identity_mismatch',
          `Feed game${gameNumber ? ` ${gameNumber}` : ''} (${g.data.white.name} vs ${g.data.black.name}) does not match registered players (${playerA.name} vs ${playerB.name})`,
          {
            gameNumber,
            detail: {
              sourceId: g.provenance.sourceId,
              round: g.data.round ?? null,
              white: g.data.white,
              black: g.data.black,
            },
          },
        ),
      );
      continue;
    }
    validGames.push(g);
  }

  const reliabilityOf = await buildReliabilityLookup(deps.db, deps.registry);

  // Build round metadata map from fetched events (prefer D3).
  const roundMetaById = new Map<string, { name: string; url: string }>();
  for (const ev of fetchedEvents) {
    for (const r of ev.data.rounds) {
      if (!roundMetaById.has(r.externalId)) {
        roundMetaById.set(r.externalId, { name: r.name, url: r.url });
      }
    }
  }

  // 5-8. State changes in one transaction.
  const txSummary = await deps.db.$transaction(async (tx) => {
    await tx.$executeRaw`select pg_advisory_xact_lock(hashtext(${'smb.championship:' + cycle.cycle_key}))`;

    const freshCycle = await tx.championship_cycles.findUniqueOrThrow({ where: { id: cycle.id } });
    const games = await tx.championship_games.findMany({
      where: { cycle_id: cycle.id },
      orderBy: [{ kind: 'asc' }, { game_number: 'asc' }],
    });

    const classicalByNumber = new Map(
      games.filter((g) => g.kind === 'classical').map((g) => [g.game_number, g]),
    );

    if (sourceErrors.length > 0) {
      await writeChampionshipLog(tx, {
        cycleId: cycle.id,
        kind: 'sync_failed',
        actor: 'system',
        message: `Partial source failure during sync: ${sourceErrors.map((e) => `${e.sourceId}/${e.capability}:${e.code}`).join(', ')}`,
        detail: { errors: sourceErrors },
        at: now,
      });
    }

    let observedGames = 0;
    const conflictDrafts: FlagDraft[] = [];

    // Group valid games by classical game_number.
    const validByNumber = new Map<number, Sourced<ChessGame>[]>();
    for (const fg of validGames) {
      const n = Number.parseInt(fg.data.round ?? '', 10);
      if (!Number.isFinite(n) || n <= 0) continue;
      validByNumber.set(n, [...(validByNumber.get(n) ?? []), fg]);
    }

    for (const [gameNumber, feedItems] of validByNumber) {
      const row = classicalByNumber.get(gameNumber);
      if (!row) continue;

      if (row.state === 'confirmed') {
        const mismatch = feedItems.find(
          (fg) => fg.data.result !== '*' && fg.data.result !== row.result,
        );
        if (mismatch) {
          conflictDrafts.push(
            makeFlag(
              'game_conflict',
              `Game ${gameNumber}: feed ${mismatch.provenance.sourceId} reports ${mismatch.data.result} while confirmed result is ${row.result}`,
              {
                gameNumber,
                detail: {
                  gameNumber,
                  confirmedResult: row.result,
                  feedResult: mismatch.data.result,
                  sourceId: mismatch.provenance.sourceId,
                },
              },
            ),
          );
        }
        continue;
      }

      // Prefer D3 for metadata / PGN, otherwise first item.
      const primary = feedItems.find((i) => i.provenance.sourceId === 'D3') ?? feedItems[0]!;
      const d3Item = feedItems.find((i) => i.provenance.sourceId === 'D3');
      const whitePlayer = directory.keyOf(primary.data.white) === keyA ? 'a' : 'b';
      const rMeta = primary.data.roundExternalId
        ? roundMetaById.get(primary.data.roundExternalId)
        : undefined;

      const isFinal = primary.data.result !== '*';
      const nextState = isFinal ? 'result_observed' : 'in_progress';
      const nextResult = isFinal ? primary.data.result : null;
      const playedAt = primary.data.playedAt ? new Date(primary.data.playedAt) : row.played_at;
      const observedAt = isFinal ? (row.observed_at ?? now) : row.observed_at;

      const updated = await tx.championship_games.update({
        where: { id: row.id },
        data: {
          white_player: whitePlayer,
          d3_game_id: d3Item?.data.externalId ?? row.d3_game_id,
          d3_round_id: d3Item?.data.roundExternalId ?? row.d3_round_id,
          round_label: primary.data.round ?? row.round_label,
          round_name: rMeta?.name ?? row.round_name,
          round_url: rMeta?.url ?? primary.data.url ?? row.round_url,
          pgn: primary.data.pgn,
          played_at: playedAt,
          observed_at: observedAt,
          state: nextState,
          result: nextResult,
        },
      });
      classicalByNumber.set(gameNumber, updated);

      if (isFinal && (row.state !== 'result_observed' || row.result !== nextResult)) {
        observedGames++;
        await writeChampionshipLog(tx, {
          cycleId: cycle.id,
          kind: 'game_observed',
          actor: 'system',
          message: `Game ${gameNumber} result observed: ${nextResult} (${primary.provenance.sourceId})`,
          detail: {
            gameNumber,
            result: nextResult,
            sourceId: primary.provenance.sourceId,
            previousState: row.state,
            previousResult: row.result,
          },
          at: now,
        });
      }
    }

    // 6. Corroboration (D3(b)): >= 2 independent non-D1 sources agreeing & valid PGN.
    let corroboratedGames = 0;
    const issues: { code: 'pgn_invalid' | 'result_mismatch'; url: string; detail: string }[] = [];
    const assessed = assessGames(validGames, reliabilityOf, directory, issues);
    for (const ag of assessed) {
      if (ag.roundNo === null) continue;
      const row = classicalByNumber.get(ag.roundNo);
      if (!row || row.state === 'confirmed') continue;
      if (ag.assessment.verification !== 'verified' || !ag.result || ag.result === '*') continue;

      const distinctNonD1 = new Set(
        ag.records.map((r) => r.provenance.sourceId).filter((id) => id !== 'D1'),
      );
      if (distinctNonD1.size < 2) continue;

      const updated = await tx.championship_games.update({
        where: { id: row.id },
        data: {
          state: 'confirmed',
          result: ag.result,
          confirmed_at: now,
          confirmed_by: 'system',
          confirmation_basis: 'corroborated',
        },
      });
      classicalByNumber.set(ag.roundNo, updated);
      corroboratedGames++;

      await writeChampionshipLog(tx, {
        cycleId: cycle.id,
        kind: 'game_confirmed',
        actor: 'system',
        message: `Game ${ag.roundNo} confirmed as ${ag.result} (corroborated by ${[...distinctNonD1].sort().join(', ')})`,
        detail: {
          kind: 'classical',
          gameNumber: ag.roundNo,
          result: ag.result,
          basis: 'corroborated',
          sources: [...distinctNonD1].sort(),
        },
        at: now,
      });
    }

    // 7. Detect phase (at most 2 steps: pre -> tournament -> post).
    const allRowsNow = [
      ...classicalByNumber.values(),
      ...games.filter((g) => g.kind === 'tiebreak'),
    ];
    const classicalRows = [...classicalByNumber.values()];
    const classicalScore = matchScore(
      classicalRows.map((g) => ({
        kind: 'classical',
        state: g.state as 'scheduled' | 'in_progress' | 'result_observed' | 'confirmed',
        result: g.result as '1-0' | '0-1' | '1/2-1/2' | null,
        whitePlayer: g.white_player as 'a' | 'b' | null,
      })),
      'classical',
    );
    const anyGameObserved = allRowsNow.some((g) => g.state !== 'scheduled');
    const classicalSummary = {
      total: freshCycle.total_games,
      confirmed: classicalRows.filter((g) => g.state === 'confirmed').length,
      observedFinal: classicalRows.filter((g) => g.state === 'result_observed').length,
      unconfirmedNumbers: classicalRows
        .filter((g) => g.state !== 'confirmed')
        .map((g) => g.game_number),
    };

    const earliestPlayed = classicalRows
      .map((g) => g.played_at)
      .filter((d): d is Date => d !== null)
      .sort((a, b) => a.getTime() - b.getTime())[0];

    let phaseCursor = freshCycle.phase as ChampionshipPhase;
    let confirmedStart = freshCycle.confirmed_start;
    let confirmedEnd = freshCycle.confirmed_end;
    let winner = freshCycle.winner;
    let latestFlags: FlagDraft[] = [];
    const lastFeedOkAt = feedOk ? now : freshCycle.last_feed_ok_at;

    for (let step = 0; step < 2; step++) {
      const decision = detectPhase({
        now,
        phase: phaseCursor,
        locked: freshCycle.phase_locked,
        scheduledStart: freshCycle.scheduled_start,
        scheduledEnd: freshCycle.scheduled_end,
        feedStatus,
        feedOk,
        anyGameObserved,
        classical: classicalSummary,
        score: { a: classicalScore.a, b: classicalScore.b },
        lastFeedOkAt,
      });
      latestFlags = decision.flags;

      if (decision.next === phaseCursor) {
        if (freshCycle.phase_locked && decision.reasons.length > 0 && step === 0) {
          await writeChampionshipLog(tx, {
            cycleId: cycle.id,
            kind: 'edited',
            actor: 'system',
            message: decision.reasons.join('; '),
            detail: { locked: true, phase: phaseCursor, reasons: decision.reasons },
            at: now,
          });
        }
        break;
      }

      const prev = phaseCursor;
      phaseCursor = decision.next;
      if (phaseCursor === 'tournament') {
        confirmedStart =
          confirmedStart ??
          (earliestPlayed && earliestPlayed.getTime() < now.getTime() ? earliestPlayed : now);
      } else if (phaseCursor === 'post_tournament') {
        confirmedStart = confirmedStart ?? now;
        confirmedEnd = now;
        winner = uniqueWinner({ a: classicalScore.a, b: classicalScore.b });
      }

      await writeChampionshipLog(tx, {
        cycleId: cycle.id,
        kind: 'phase_changed',
        actor: 'system',
        message: `Phase changed from ${prev} to ${phaseCursor}: ${decision.reasons.join('; ')}`,
        detail: { from: prev, to: phaseCursor, reasons: decision.reasons },
        at: now,
      });
    }

    await tx.championship_cycles.update({
      where: { id: cycle.id },
      data: {
        phase: phaseCursor,
        confirmed_start: confirmedStart,
        confirmed_end: confirmedEnd,
        winner,
        last_synced_at: now,
        last_sync_status: 'ok',
        ...(feedOk ? { last_feed_ok_at: now } : {}),
        ...(feedStatus ? { last_feed_status: feedStatus } : {}),
      },
    });

    // 8. Flags.
    const allDrafts = [...identityDrafts, ...conflictDrafts, ...latestFlags];
    const flagResult = await reconcileFlags(tx, cycle.id, allDrafts, now);

    return {
      previousPhase: freshCycle.phase as ChampionshipPhase,
      phase: phaseCursor,
      observedGames,
      corroboratedGames,
      flagsOpened: flagResult.opened,
      flagsCleared: flagResult.cleared,
    };
  });

  // 9. Emit pending game events after commit.
  const emit = await emitPendingGameEvents({ db: deps.db, now, logger: deps.logger }, cycle.id);

  return {
    cycleId: cycle.id,
    cycleKey: cycle.cycle_key,
    previousPhase: txSummary.previousPhase,
    phase: txSummary.phase,
    lastSyncStatus: 'ok',
    observedGames: txSummary.observedGames,
    corroboratedGames: txSummary.corroboratedGames,
    flagsOpened: txSummary.flagsOpened,
    flagsCleared: txSummary.flagsCleared,
    emit,
  };
}
