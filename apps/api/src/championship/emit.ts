import type { PrismaClient } from '@prisma/client';
import { PostTypeConfig, resolvePhase } from '@smb/shared';
import type { Logger } from 'pino';
import { openEventOpportunity } from '../scheduling/open.js';
import { writeChampionshipLog } from './log.js';

export interface EmitSummary {
  checked: number;
  created: number;
  duplicates: number;
  held: number;
  staleSkipped: number;
  refused: number;
  blocked: boolean;
}

/**
 * Outbox emitter for confirmed championship games:
 *  - blocked by any open blocking flag
 *  - D9: holds a confirmed game if any earlier classical (or tiebreak) game is unconfirmed
 *  - D8: marks games older than `tournament.staleAfterMinutes` as `stale_skipped` without posting
 *  - otherwise opens an event opportunity (`game_completed`) via module 1.14
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

    const referenceTime = game.played_at ?? game.observed_at ?? game.confirmed_at!;
    const ageMs = now.getTime() - referenceTime.getTime();
    if (ageMs > staleAfterMinutes * 60_000) {
      await deps.db.$transaction(async (tx) => {
        await tx.championship_games.update({
          where: { id: game.id },
          data: { post_status: 'stale_skipped' },
        });
        await writeChampionshipLog(tx, {
          cycleId,
          kind: 'emission_skipped',
          actor: 'system',
          message: `${game.kind === 'tiebreak' ? 'Tiebreak' : 'Game'} ${game.game_number} skipped as stale (${Math.floor(ageMs / 60_000)}m old > ${staleAfterMinutes}m)`,
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

    const prefix = game.kind === 'tiebreak' ? 'tiebreak' : 'game';
    const slot = `${prefix}-${game.game_number}:result`;
    const gameExternalId = `${cycle.cycle_key}:${prefix}-${game.game_number}`;
    const basis = game.confirmation_basis ?? 'official_entry';
    const label =
      game.kind === 'tiebreak' ? `Tiebreak ${game.game_number}` : `Game ${game.game_number}`;
    const reason = `${label} of ${cycle.title} confirmed (${game.result}), basis ${basis}`;

    const res = await openEventOpportunity(
      { db: deps.db, now },
      {
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
    );

    if (res.status === 'created' || res.status === 'duplicate') {
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
          message: `${label} emitted opportunity (${res.status})`,
          detail: {
            kind: game.kind,
            gameNumber: game.game_number,
            opportunityId: res.opportunityId,
            dedupeKey: res.dedupeKey,
            outcome: res.status,
          },
          at: now,
        });
      });
      if (res.status === 'created') summary.created++;
      else summary.duplicates++;
    } else {
      deps.logger?.warn(
        {
          cycleId,
          kind: game.kind,
          gameNumber: game.game_number,
          code: res.code,
          message: res.message,
        },
        'Championship game emission refused by scheduler',
      );
      await writeChampionshipLog(deps.db, {
        cycleId,
        kind: 'emission_skipped',
        actor: 'system',
        message: `${label} emission refused: ${res.code} (${res.message})`,
        detail: {
          kind: game.kind,
          gameNumber: game.game_number,
          code: res.code,
          reason: res.message,
        },
        at: now,
      });
      summary.refused++;
    }
  }

  return summary;
}
