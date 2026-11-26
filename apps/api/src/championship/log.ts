import type { Prisma, PrismaClient } from '@prisma/client';

export type ChampionshipLogKind =
  | 'registered'
  | 'phase_changed'
  | 'game_observed'
  | 'game_confirmed'
  | 'game_corrected'
  | 'concluded'
  | 'forced_phase'
  | 'unlocked'
  | 'flag_opened'
  | 'flag_cleared'
  | 'flag_resolved'
  | 'emitted'
  | 'emission_skipped'
  | 'sync_failed'
  | 'edited'
  /** 1.16: a feed game that maps to no championship game (logged once per game). */
  | 'unmapped_feed_game'
  /** 1.16: the feed shows an observed game as unfinished again (the observation is kept). */
  | 'feed_regressed_game';

export interface ChampionshipLogEntry {
  cycleId: string;
  kind: ChampionshipLogKind;
  actor: string;
  message: string;
  detail?: Record<string, unknown>;
  at?: Date;
}

export async function writeChampionshipLog(
  tx: Prisma.TransactionClient | PrismaClient,
  entry: ChampionshipLogEntry,
): Promise<void> {
  await tx.championship_log.create({
    data: {
      cycle_id: entry.cycleId,
      kind: entry.kind,
      actor: entry.actor,
      message: entry.message,
      detail: (entry.detail ?? {}) as Prisma.InputJsonValue,
      ...(entry.at ? { at: entry.at } : {}),
    },
  });
}
