import type { PrismaClient } from '@prisma/client';
import {
  PostTypeConfig,
  gameIdentityKey,
  matchScore,
  resolvePhase,
  type EventSourceRef,
  type GameCompletedEvent,
  type GamePlayer,
  type ScoredGame,
} from '@smb/shared';
import type { Logger } from 'pino';
import { ingestEvent } from '../events/ingest.js';
import { EventIdentityConflict, type IngestResult } from '../events/types.js';
import { writeChampionshipLog } from './log.js';

export const CHAMPIONSHIP_DETECTOR_ID = 'championship:1.1';

export interface EmitSummary {
  checked: number;
  created: number;
  duplicates: number;
  held: number;
  staleSkipped: number;
  refused: number;
  blocked: boolean;
}

type CycleRow = NonNullable<Awaited<ReturnType<PrismaClient['championship_cycles']['findUnique']>>>;
type GameRow = Awaited<ReturnType<PrismaClient['championship_games']['findMany']>>[number];

const scored = (g: GameRow): ScoredGame => ({
  kind: g.kind as 'classical' | 'tiebreak',
  state: g.state as ScoredGame['state'],
  result: g.result as ScoredGame['result'],
  whitePlayer: g.white_player as 'a' | 'b' | null,
});

/**
 * The normalised game-completion event for a confirmed game (1.16). `scoreAfter` counts this game and
 * every confirmed game before it: classical games only for a classical game, classical plus earlier
 * tiebreaks for a tiebreak.
 */
export function buildGameCompletedEvent(
  cycle: CycleRow,
  game: GameRow,
  allGames: GameRow[],
): GameCompletedEvent {
  if (game.state !== 'confirmed' || !game.result || !game.confirmed_at) {
    throw new Error(`Game ${game.idempotency_key} is not confirmed`);
  }
  const kind = game.kind as 'classical' | 'tiebreak';
  const counted = allGames.filter((g) =>
    kind === 'classical'
      ? g.kind === 'classical' && g.game_number <= game.game_number
      : g.kind === 'classical' || (g.kind === 'tiebreak' && g.game_number <= game.game_number),
  );
  const score = matchScore(counted.map(scored));

  const a = cycle.player_a as unknown as GamePlayer;
  const b = cycle.player_b as unknown as GamePlayer;
  const whiteIsA = (game.white_player ?? 'a') === 'a';
  const prefix = kind === 'tiebreak' ? 'tiebreak' : 'game';

  const sources: EventSourceRef[] = [
    { sourceId: 'D1', externalId: `${cycle.cycle_key}:${prefix}-${game.game_number}` },
  ];
  if (game.d3_game_id) {
    let url: string | undefined;
    try {
      url = game.round_url ? new URL(game.round_url).toString() : undefined;
    } catch {
      url = undefined;
    }
    sources.push({ sourceId: 'D3', externalId: game.d3_game_id, ...(url ? { url } : {}) });
  }
  const refs = (cycle.source_event_refs ?? {}) as Record<string, string>;
  for (const s of game.observed_sources) {
    if (s === 'D1' || s === 'D3' || !refs[s]) continue;
    sources.push({ sourceId: s, externalId: refs[s] });
  }

  const completedAt = game.played_at ?? game.observed_at ?? game.confirmed_at;
  return {
    kind: 'game_completed',
    identityKey: gameIdentityKey(cycle.cycle_key, kind, game.game_number),
    championship: { postTypeId: cycle.post_type_id, cycleKey: cycle.cycle_key, title: cycle.title },
    game: {
      kind,
      number: game.game_number,
      ...(game.round_label ? { roundLabel: game.round_label } : {}),
    },
    players: { white: whiteIsA ? a : b, black: whiteIsA ? b : a },
    result: game.result as GameCompletedEvent['result'],
    scoreAfter: { a: score.a, b: score.b, basis: kind === 'classical' ? 'classical' : 'overall' },
    completedAt: completedAt.toISOString(),
    confirmedAt: game.confirmed_at.toISOString(),
    verification: (game.confirmation_basis ??
      'official_entry') as GameCompletedEvent['verification'],
    sources,
  };
}

/**
 * Outbox emitter for confirmed championship games:
 *  - blocked by any open blocking flag
 *  - D9: holds a confirmed game if any earlier classical (or tiebreak) game is unconfirmed
 *  - D8: records games older than `tournament.staleAfterMinutes` as `stale_skipped` without posting
 *  - otherwise records the game-completion event (1.16) and opens its `game_completed` opportunity (1.14)
 */
export async function emitPendingGameEvents(
  deps: { db: PrismaClient; now?: Date; logger?: Logger },
  cycleId: string,
): Promise<EmitSummary> {
  const now = deps.now ?? new Date();
  const summary: EmitSummary = {
    checked: 0,
    created: 0,
    duplicates: 0,
    held: 0,
    staleSkipped: 0,
    refused: 0,
    blocked: false,
  };

  const cycle = await deps.db.championship_cycles.findUnique({
    where: { id: cycleId },
  });
  if (!cycle) return summary;

  const blockingCount = await deps.db.championship_flags.count({
    where: { cycle_id: cycleId, status: 'open', severity: 'blocking' },
  });
  if (blockingCount > 0) {
    summary.blocked = true;
    return summary;
  }

  const activeConfig = await deps.db.post_configs.findFirst({
    where: { post_type_id: cycle.post_type_id, is_active: true },
  });
  let staleAfterMinutes = 360;
  if (activeConfig) {
    const parsed = PostTypeConfig.parse(activeConfig.config_json);
    staleAfterMinutes = resolvePhase(parsed, 'tournament').staleAfterMinutes;
  }

  const allGames = await deps.db.championship_games.findMany({
    where: { cycle_id: cycleId },
    orderBy: [{ kind: 'asc' }, { game_number: 'asc' }],
  });

  const pending = allGames.filter(
    (g) => g.state === 'confirmed' && (g.post_status === 'none' || g.post_status === 'held'),
  );
  summary.checked = pending.length;
  if (pending.length === 0) return summary;

  const sourceRefs = (cycle.source_event_refs ?? {}) as Record<string, string>;

  for (const game of pending) {
    const hasEarlierUnconfirmed = allGames.some((other) => {
      if (other.state === 'confirmed') return false;
      if (game.kind === 'classical') {
        return other.kind === 'classical' && other.game_number < game.game_number;
      }
      return (
        other.kind === 'classical' ||
        (other.kind === 'tiebreak' && other.game_number < game.game_number)
      );
    });

    if (hasEarlierUnconfirmed) {
      if (game.post_status !== 'held') {
        await deps.db.championship_games.update({
          where: { id: game.id },
          data: { post_status: 'held' },
        });
      }
      summary.held++;
      continue;
    }

    const prefix = game.kind === 'tiebreak' ? 'tiebreak' : 'game';
    const label =
      game.kind === 'tiebreak' ? `Tiebreak ${game.game_number}` : `Game ${game.game_number}`;
    const payload = buildGameCompletedEvent(cycle, game, allGames);

    const referenceTime = game.played_at ?? game.observed_at ?? game.confirmed_at!;
    const ageMs = now.getTime() - referenceTime.getTime();
    if (ageMs > staleAfterMinutes * 60_000) {
      // The ledger still records every confirmed game, so a later correction has a row to update.
      await ingest(deps, cycle.post_type_id, payload, { recordAs: 'stale_skipped' }, now);
      await deps.db.$transaction(async (tx) => {
        await tx.championship_games.update({
          where: { id: game.id },
          data: { post_status: 'stale_skipped' },
        });
        await writeChampionshipLog(tx, {
          cycleId,
          kind: 'emission_skipped',
          actor: 'system',
          message: `${label} skipped as stale (${Math.floor(ageMs / 60_000)}m old > ${staleAfterMinutes}m)`,
          detail: {
            kind: game.kind,
            gameNumber: game.game_number,
            ageMinutes: Math.floor(ageMs / 60_000),
            staleAfterMinutes,
            referenceTime: referenceTime.toISOString(),
          },
          at: now,
        });
      });
      summary.staleSkipped++;
      continue;
    }

    const slot = `${prefix}-${game.game_number}:result`;
    const gameExternalId = `${cycle.cycle_key}:${prefix}-${game.game_number}`;
    const basis = game.confirmation_basis ?? 'official_entry';
    const reason = `${label} of ${cycle.title} confirmed (${game.result}), basis ${basis}`;

    let res: IngestResult;
    try {
      res = await ingest(
        deps,
        cycle.post_type_id,
        payload,
        {
          trigger: {
            kind: 'event',
            postTypeId: cycle.post_type_id,
            event: 'game_completed',
            occurredAt: game.confirmed_at!,
            slot,
            context: {
              phase: 'tournament',
              eventKey: cycle.cycle_key,
              subject: {
                eventRefs: { ...sourceRefs, D1: cycle.cycle_key },
                gameRef: { sourceId: 'D1', externalId: gameExternalId },
              },
            },
            reason,
          },
        },
        now,
      );
    } catch (err) {
      if (!(err instanceof EventIdentityConflict)) throw err;
      deps.logger?.error(
        { cycleId, identityKey: err.identityKey },
        'Championship game event differs from its recorded facts without a correction',
      );
      await writeChampionshipLog(deps.db, {
        cycleId,
        kind: 'emission_skipped',
        actor: 'system',
        message: `${label} emission refused: ${err.message}`,
        detail: {
          kind: game.kind,
          gameNumber: game.game_number,
          code: 'identity_conflict',
        },
        at: now,
      });
      summary.refused++;
      continue;
    }

    const open = 'open' in res ? res.open : undefined;
    if (res.opportunityId) {
      const outcome =
        res.status === 'created' && open?.status === 'created' ? 'created' : 'duplicate';
      await deps.db.$transaction(async (tx) => {
        await tx.championship_games.update({
          where: { id: game.id },
          data: {
            opportunity_id: res.opportunityId,
            post_status: 'opportunity_created',
          },
        });
        await writeChampionshipLog(tx, {
          cycleId,
          kind: 'emitted',
          actor: 'system',
          message: `${label} emitted opportunity (${outcome})`,
          detail: {
            kind: game.kind,
            gameNumber: game.game_number,
            opportunityId: res.opportunityId,
            dedupeKey: open && open.status !== 'refused' ? open.dedupeKey : null,
            detectedEventId: res.eventId,
            eventVersion: res.version,
            outcome,
          },
          at: now,
        });
      });
      if (open?.status === 'created') summary.created++;
      else summary.duplicates++;
    } else {
      const code = open?.status === 'refused' ? open.code : 'not_opened';
      const message = open?.status === 'refused' ? open.message : 'No opportunity was opened';
      deps.logger?.warn(
        { cycleId, kind: game.kind, gameNumber: game.game_number, code, message },
        'Championship game emission refused by scheduler',
      );
      await writeChampionshipLog(deps.db, {
        cycleId,
        kind: 'emission_skipped',
        actor: 'system',
        message: `${label} emission refused: ${code} (${message})`,
        detail: {
          kind: game.kind,
          gameNumber: game.game_number,
          code,
          reason: message,
          detectedEventId: res.eventId,
        },
        at: now,
      });
      summary.refused++;
    }
  }

  return summary;
}

function ingest(
  deps: { db: PrismaClient; logger?: Logger },
  postTypeId: string,
  payload: GameCompletedEvent,
  extra: Pick<Parameters<typeof ingestEvent>[1], 'trigger' | 'recordAs' | 'reason'>,
  now: Date,
  actor = 'system',
): Promise<IngestResult> {
  return ingestEvent(
    { db: deps.db, now, logger: deps.logger },
    { detectorId: CHAMPIONSHIP_DETECTOR_ID, postTypeId, payload, actor, ...extra },
  );
}

/**
 * After an administrator corrects a confirmed game (1.16 D6): records a new version of its event and of
 * every later emitted event whose score changed. Opportunities are never re-opened; each keeps the
 * version it was built from, so 1.17 can tell that its facts changed.
 */
export async function recordCorrection(
  deps: { db: PrismaClient; now?: Date; logger?: Logger },
  cycleId: string,
  corrected: { kind: string; number: number },
  actor: string,
  reason: string,
): Promise<{ eventId: string; version: number }[]> {
  const now = deps.now ?? new Date();
  const cycle = await deps.db.championship_cycles.findUnique({ where: { id: cycleId } });
  if (!cycle) return [];
  const allGames = await deps.db.championship_games.findMany({
    where: { cycle_id: cycleId },
    orderBy: [{ kind: 'asc' }, { game_number: 'asc' }],
  });
  const identity = gameIdentityKey(
    cycle.cycle_key,
    corrected.kind as 'classical' | 'tiebreak',
    corrected.number,
  );

  const affected = allGames.filter((g) => {
    if (g.state !== 'confirmed') return false;
    if (g.kind === corrected.kind && g.game_number === corrected.number) return true;
    if (corrected.kind === 'classical') {
      // Classical scores feed later classical games and every tiebreak ("overall").
      return g.kind === 'tiebreak' || g.game_number > corrected.number;
    }
    return g.kind === 'tiebreak' && g.game_number > corrected.number;
  });

  const out: { eventId: string; version: number }[] = [];
  for (const g of affected) {
    const key = g.idempotency_key;
    const ledger = await deps.db.detected_events.findUnique({ where: { identity_key: key } });
    if (!ledger) continue; // never emitted: the next emit records the corrected facts as version 1
    const payload = buildGameCompletedEvent(cycle, g, allGames);
    const res = await ingest(
      deps,
      cycle.post_type_id,
      payload,
      {
        reason:
          key === identity ? reason : `score_recomputed_after_correction:${identity} (${reason})`,
      },
      now,
      actor,
    );
    if (res.status === 'corrected') out.push({ eventId: res.eventId, version: res.version });
  }
  return out;
}
