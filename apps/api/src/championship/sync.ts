import type { PrismaClient } from '@prisma/client';
import {
  FEED_OUTAGE_ALERT_HOURS,
  FLAG_KINDS,
  detectPhase,
  makeFlag,
  matchScore,
  uniqueWinner,
  type ChampionshipPhase,
  type ChessEvent,
  type ChessGame,
  type EventStatus,
  type FlagDraft,
  type FlagKind,
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
import {
  isSyncDue,
  mapFeedGame,
  mappedKey,
  roundTiming,
  roundsToFetch,
  type MappedGame,
} from './mapping.js';

/** Default corroboration stability window (1.16 D7c). */
export const DEFAULT_STABILITY_SECONDS = 120;

export interface SyncDeps {
  db: PrismaClient;
  gateway: SourceGateway;
  registry?: SourcesRegistry;
  resolvers?: ContextResolvers;
  logger: Logger;
  /** Two sources must agree for at least this long before a game is corroborated. Default 120. */
  stabilitySeconds?: number;
}

export interface SyncSummary {
  skipped?: 'no_cycle' | 'not_due';
  cycleId?: string;
  cycleKey?: string;
  phase?: ChampionshipPhase;
  previousPhase?: ChampionshipPhase;
  lastSyncStatus: 'ok' | 'source_error' | 'not_due';
  /** Provider calls that failed (a partial failure when lastSyncStatus is 'ok'). */
  sourceErrors?: number;
  /** Provider calls made. */
  calls?: number;
  observedGames?: number;
  corroboratedGames?: number;
  unmappedGames?: number;
  flagsOpened?: number;
  flagsCleared?: number;
  emit?: EmitSummary;
}

const STATUS_RANK: Record<EventStatus, number> = {
  upcoming: 1,
  in_progress: 2,
  completed: 3,
};

/** Flags derived from feed games. They are kept, not cleared, when no games could be read. */
const GAME_FLAG_KINDS: FlagKind[] = ['identity_mismatch', 'game_conflict', 'observation_changed'];

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

const label = (m: MappedGame) =>
  m.kind === 'tiebreak' ? `Tiebreak ${m.number}` : `Game ${m.number}`;

export async function syncChampionship(
  deps: SyncDeps,
  opts?: { now?: Date; force?: boolean },
): Promise<SyncSummary> {
  const now = opts?.now ?? new Date();
  const force = opts?.force ?? false;
  const stabilityMs = (deps.stabilitySeconds ?? DEFAULT_STABILITY_SECONDS) * 1000;

  const cycle = await deps.db.championship_cycles.findFirst({
    where: { post_type_id: '1.1', is_current: true },
  });
  if (!cycle) {
    return { skipped: 'no_cycle', lastSyncStatus: 'not_due' };
  }

  const currentPhase = cycle.phase as ChampionshipPhase;
  const timing = { nextRoundAt: cycle.next_round_at, anyRoundLive: cycle.any_round_live };
  if (
    !force &&
    !isSyncDue(currentPhase, cycle.scheduled_start, cycle.last_synced_at, now, timing)
  ) {
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

  // Rounds that must be re-read during the tournament even when not live (1.16 D9):
  // rounds of unconfirmed observed games, and rounds behind open game flags.
  const knownRows = await deps.db.championship_games.findMany({
    where: { cycle_id: cycle.id },
    select: { game_number: true, state: true, d3_round_id: true },
  });
  const openGameFlags = await deps.db.championship_flags.findMany({
    where: { cycle_id: cycle.id, status: 'open', kind: { in: GAME_FLAG_KINDS } },
    select: { game_number: true, detail: true },
  });
  const rereadRoundIds = new Set<string>();
  for (const r of knownRows) {
    if (r.d3_round_id && (r.state === 'in_progress' || r.state === 'result_observed')) {
      rereadRoundIds.add(r.d3_round_id);
    }
  }
  for (const f of openGameFlags) {
    const roundId = (f.detail as { roundExternalId?: unknown } | null)?.roundExternalId;
    if (typeof roundId === 'string') rereadRoundIds.add(roundId);
    const row = knownRows.find((r) => r.game_number === f.game_number && r.d3_round_id);
    if (row?.d3_round_id) rereadRoundIds.add(row.d3_round_id);
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
  let gamesCallsSucceeded = 0;

  const fetchGames = async (sourceId: string, query: Record<string, string>) => {
    callsAttempted++;
    try {
      const res = await deps.gateway.fetch(sourceId, 'games', query);
      fetchedGames.push(...res.items);
      callsSucceeded++;
      gamesCallsSucceeded++;
    } catch (err) {
      if (!(err instanceof SourceError)) throw err;
      sourceErrors.push({ sourceId, capability: 'games', code: err.code, message: err.message });
    }
  };

  for (const sourceId of sourceIds) {
    const ref = sourceRefs[sourceId]!;
    const caps = deps.gateway.capabilitiesOf(sourceId);
    let event: ChessEvent | undefined;
    if (caps.includes('events')) {
      callsAttempted++;
      try {
        const res = await deps.gateway.fetch(sourceId, 'events', { externalId: ref });
        fetchedEvents.push(...res.items);
        event = res.items[0]?.data;
        callsSucceeded++;
      } catch (err) {
        if (!(err instanceof SourceError)) throw err;
        sourceErrors.push({ sourceId, capability: 'events', code: err.code, message: err.message });
      }
    }
    if (!caps.includes('games')) continue;

    // During the tournament, read only the rounds that matter (D9). Otherwise, or without a
    // usable event, read the whole event.
    if (currentPhase === 'tournament' && event && event.rounds.length > 0) {
      const reread = sourceId === 'D3' ? rereadRoundIds : new Set<string>();
      for (const roundId of roundsToFetch(event, now, reread)) {
        await fetchGames(sourceId, { roundExternalId: roundId });
      }
    } else {
      await fetchGames(sourceId, { eventExternalId: ref });
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
      sourceErrors: sourceErrors.length,
      calls: callsAttempted,
      flagsOpened: outageRes.opened,
      flagsCleared: outageRes.cleared,
    };
  }

  // Per-round requests can return the same game twice: keep one record per source and game.
  const uniqueGames = [
    ...new Map(
      fetchedGames.map((g) => [`${g.provenance.sourceId}:${g.data.externalId}`, g]),
    ).values(),
  ];

  const feedStatus = mostAdvancedStatus(fetchedEvents);
  const feedOk = fetchedEvents.length > 0 || uniqueGames.length > 0;
  const primaryEvent =
    fetchedEvents.find((e) => e.provenance.sourceId === 'D3')?.data ?? fetchedEvents[0]?.data;
  const newTiming = primaryEvent ? roundTiming(primaryEvent, now) : timing;

  // 4. Identity check.
  const playerA = cycle.player_a as unknown as GamePlayer;
  const playerB = cycle.player_b as unknown as GamePlayer;
  const directory = new PlayerDirectory([
    playerA,
    playerB,
    ...uniqueGames.flatMap((g) => [g.data.white, g.data.black]),
  ]);
  const keyA = directory.keyOf(playerA);
  const keyB = directory.keyOf(playerB);

  const validGames: Sourced<ChessGame>[] = [];
  const identityDrafts: FlagDraft[] = [];

  for (const g of uniqueGames) {
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
              roundExternalId: g.data.roundExternalId ?? null,
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

    const rowsByKey = new Map(games.map((g) => [`${g.kind}:${g.game_number}`, g]));

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
    const changedKeys = new Set<string>();

    // Map feed games to rows (D8). Unmapped games are logged once per cycle and never guessed.
    const validByKey = new Map<string, { mapped: MappedGame; items: Sourced<ChessGame>[] }>();
    const unmapped: Sourced<ChessGame>[] = [];
    for (const fg of validGames) {
      const mapped = mapFeedGame(fg.data, games);
      if (!mapped) {
        unmapped.push(fg);
        continue;
      }
      const key = mappedKey(mapped);
      const entry = validByKey.get(key) ?? { mapped, items: [] };
      entry.items.push(fg);
      validByKey.set(key, entry);
    }

    let unmappedGames = 0;
    if (unmapped.length > 0) {
      const logged = await tx.championship_log.findMany({
        where: { cycle_id: cycle.id, kind: 'unmapped_feed_game' },
        select: { detail: true },
      });
      const seen = new Set(
        logged.map((l) => {
          const d = l.detail as { sourceId?: string; externalId?: string };
          return `${d.sourceId}:${d.externalId}`;
        }),
      );
      for (const fg of unmapped) {
        const id = `${fg.provenance.sourceId}:${fg.data.externalId}`;
        if (seen.has(id)) continue;
        seen.add(id);
        unmappedGames++;
        await writeChampionshipLog(tx, {
          cycleId: cycle.id,
          kind: 'unmapped_feed_game',
          actor: 'system',
          message: `Feed game ${fg.data.externalId} (round "${fg.data.round ?? ''}", ${fg.data.white.name} vs ${fg.data.black.name}) does not map to a championship game; bind it to a game if it belongs to the match`,
          detail: {
            sourceId: fg.provenance.sourceId,
            externalId: fg.data.externalId,
            round: fg.data.round ?? null,
            roundExternalId: fg.data.roundExternalId ?? null,
            result: fg.data.result,
          },
          at: now,
        });
      }
    }

    for (const [key, { mapped, items: feedItems }] of validByKey) {
      const row = rowsByKey.get(key);
      if (!row) continue;

      const finals = feedItems.filter((i) => i.data.result !== '*');

      if (row.state === 'confirmed') {
        const mismatch = finals.find((fg) => fg.data.result !== row.result);
        if (mismatch) {
          conflictDrafts.push(
            makeFlag(
              'game_conflict',
              `${label(mapped)}: feed ${mismatch.provenance.sourceId} reports ${mismatch.data.result} while confirmed result is ${row.result}`,
              {
                gameNumber: mapped.number,
                detail: {
                  kind: mapped.kind,
                  gameNumber: mapped.number,
                  confirmedResult: row.result,
                  feedResult: mismatch.data.result,
                  sourceId: mismatch.provenance.sourceId,
                  roundExternalId: mismatch.data.roundExternalId ?? null,
                },
              },
            ),
          );
        }
        continue;
      }

      const finalSources = [...new Set(finals.map((f) => f.provenance.sourceId))].sort();

      if (row.state === 'result_observed') {
        // D7a: an observed result is sticky. A feed showing the game unfinished again is logged once.
        if (finals.length === 0) {
          if (!row.feed_regressed_at) {
            const updated = await tx.championship_games.update({
              where: { id: row.id },
              data: { feed_regressed_at: now },
            });
            rowsByKey.set(key, updated);
            await writeChampionshipLog(tx, {
              cycleId: cycle.id,
              kind: 'feed_regressed_game',
              actor: 'system',
              message: `${label(mapped)}: feed shows the game unfinished again; keeping the observed result ${row.result}`,
              detail: {
                kind: mapped.kind,
                gameNumber: mapped.number,
                observedResult: row.result,
                sources: [...new Set(feedItems.map((i) => i.provenance.sourceId))].sort(),
              },
              at: now,
            });
          }
          continue;
        }

        // D7b: a feed reporting a different final result never overwrites the observation.
        const disagreeing = finals.filter((f) => f.data.result !== row.result);
        if (disagreeing.length > 0) {
          changedKeys.add(key);
          conflictDrafts.push(
            makeFlag(
              'observation_changed',
              `${label(mapped)}: ${disagreeing.map((d) => `${d.provenance.sourceId} reports ${d.data.result}`).join(', ')} but ${row.result} was observed; confirm the official result`,
              {
                gameNumber: mapped.number,
                detail: {
                  kind: mapped.kind,
                  gameNumber: mapped.number,
                  observedResult: row.result,
                  reports: disagreeing.map((d) => ({
                    sourceId: d.provenance.sourceId,
                    result: d.data.result,
                  })),
                  roundExternalId: disagreeing[0]!.data.roundExternalId ?? null,
                },
              },
            ),
          );
          const updated = await tx.championship_games.update({
            where: { id: row.id },
            data: {
              observed_result_since: now, // D7c: stability restarts after any disagreement
              observed_sources: [...new Set([...row.observed_sources, ...finalSources])].sort(),
              feed_regressed_at: null,
            },
          });
          rowsByKey.set(key, updated);
          continue;
        }

        // Feeds agree with the observation.
        const updated = await tx.championship_games.update({
          where: { id: row.id },
          data: {
            observed_sources: [...new Set([...row.observed_sources, ...finalSources])].sort(),
            observed_result_since: row.observed_result_since ?? now,
            feed_regressed_at: null,
          },
        });
        rowsByKey.set(key, updated);
        continue;
      }

      // scheduled or in_progress
      const d3Item = feedItems.find((i) => i.provenance.sourceId === 'D3');
      const primary =
        finals.find((i) => i.provenance.sourceId === 'D3') ?? finals[0] ?? d3Item ?? feedItems[0]!;
      const whitePlayer = directory.keyOf(primary.data.white) === keyA ? 'a' : 'b';
      const rMeta = primary.data.roundExternalId
        ? roundMetaById.get(primary.data.roundExternalId)
        : undefined;

      const isFinal = finals.length > 0;
      const nextResult = isFinal ? primary.data.result : null;
      const disagreeing = finals.filter((f) => f.data.result !== nextResult);
      if (disagreeing.length > 0) {
        changedKeys.add(key);
        conflictDrafts.push(
          makeFlag(
            'observation_changed',
            `${label(mapped)}: feeds disagree on the result (${finals.map((f) => `${f.provenance.sourceId} ${f.data.result}`).join(', ')}); confirm the official result`,
            {
              gameNumber: mapped.number,
              detail: {
                kind: mapped.kind,
                gameNumber: mapped.number,
                observedResult: nextResult,
                reports: finals.map((d) => ({
                  sourceId: d.provenance.sourceId,
                  result: d.data.result,
                })),
                roundExternalId: primary.data.roundExternalId ?? null,
              },
            },
          ),
        );
      }
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
          state: isFinal ? 'result_observed' : 'in_progress',
          result: nextResult,
          ...(isFinal
            ? {
                observed_result_since: now,
                observed_sources: finalSources,
                feed_regressed_at: null,
              }
            : {}),
        },
      });
      rowsByKey.set(key, updated);

      if (isFinal) {
        observedGames++;
        await writeChampionshipLog(tx, {
          cycleId: cycle.id,
          kind: 'game_observed',
          actor: 'system',
          message: `${label(mapped)} result observed: ${nextResult} (${primary.provenance.sourceId})`,
          detail: {
            kind: mapped.kind,
            gameNumber: mapped.number,
            result: nextResult,
            sourceId: primary.provenance.sourceId,
            sources: finalSources,
            previousState: row.state,
            previousResult: row.result,
          },
          at: now,
        });
      }
    }

    // 6. Corroboration (D3(b)): >= 2 independent non-D1 sources agreeing & valid PGN, stable for
    // at least the stability window (1.16 D7c). Classical games only; tiebreaks need an administrator.
    let corroboratedGames = 0;
    const issues: { code: 'pgn_invalid' | 'result_mismatch'; url: string; detail: string }[] = [];
    const classicalFeed = [...validByKey.values()]
      .filter((e) => e.mapped.kind === 'classical')
      .flatMap((e) => e.items);
    const assessed = assessGames(classicalFeed, reliabilityOf, directory, issues);
    for (const ag of assessed) {
      if (ag.roundNo === null) continue;
      const key = `classical:${ag.roundNo}`;
      const row = rowsByKey.get(key);
      if (!row || row.state !== 'result_observed') continue;
      if (changedKeys.has(key)) continue;
      if (ag.assessment.verification !== 'verified' || !ag.result || ag.result === '*') continue;
      if (ag.result !== row.result) continue;
      if (
        !row.observed_result_since ||
        now.getTime() - row.observed_result_since.getTime() < stabilityMs
      ) {
        continue;
      }

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
      rowsByKey.set(key, updated);
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
    const allRowsNow = [...rowsByKey.values()];
    const classicalRows = allRowsNow
      .filter((g) => g.kind === 'classical')
      .sort((a, b) => a.game_number - b.game_number);
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
        next_round_at: newTiming.nextRoundAt,
        any_round_live: newTiming.anyRoundLive,
        ...(feedOk ? { last_feed_ok_at: now } : {}),
        ...(feedStatus ? { last_feed_status: feedStatus } : {}),
      },
    });

    // 8. Flags. Game-derived flags are only re-evaluated when games could be read this sync.
    const allDrafts = [...identityDrafts, ...conflictDrafts, ...latestFlags];
    const onlyKinds =
      gamesCallsSucceeded > 0 ? undefined : FLAG_KINDS.filter((k) => !GAME_FLAG_KINDS.includes(k));
    const flagResult = await reconcileFlags(tx, cycle.id, allDrafts, now, onlyKinds);

    return {
      previousPhase: freshCycle.phase as ChampionshipPhase,
      phase: phaseCursor,
      observedGames,
      corroboratedGames,
      unmappedGames,
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
    sourceErrors: sourceErrors.length,
    calls: callsAttempted,
    observedGames: txSummary.observedGames,
    corroboratedGames: txSummary.corroboratedGames,
    unmappedGames: txSummary.unmappedGames,
    flagsOpened: txSummary.flagsOpened,
    flagsCleared: txSummary.flagsCleared,
    emit,
  };
}
