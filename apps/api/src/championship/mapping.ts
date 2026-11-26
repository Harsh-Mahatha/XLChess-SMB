import type { ChampionshipPhase, ChessEvent, ChessGame, GameKind } from '@smb/shared';

/**
 * Feed game → championship game row (1.16 D8). Order:
 *  1. a row bound to this D3 game id;
 *  2. the only row bound to this D3 round id;
 *  3. a classical game from a Round tag of the form "7" or "7.1".
 * Anything else (tiebreak labels, other boards, blank labels) maps to null and is never guessed:
 * an administrator binds tiebreak rounds with PATCH /v1/championships/:id/games/tiebreak/:n.
 */
export interface GameRowBinding {
  kind: string;
  game_number: number;
  d3_game_id: string | null;
  d3_round_id: string | null;
}

export interface MappedGame {
  kind: GameKind;
  number: number;
}

const CLASSICAL_LABEL = /^(\d+)(?:\.1)?$/;

export function mapFeedGame(game: ChessGame, rows: GameRowBinding[]): MappedGame | null {
  const asMapped = (r: GameRowBinding): MappedGame => ({
    kind: r.kind as GameKind,
    number: r.game_number,
  });

  if (game.sourceId === 'D3') {
    const byGame = rows.find((r) => r.d3_game_id !== null && r.d3_game_id === game.externalId);
    if (byGame) return asMapped(byGame);
    if (game.roundExternalId) {
      const byRound = rows.filter(
        (r) => r.d3_round_id !== null && r.d3_round_id === game.roundExternalId,
      );
      if (byRound.length === 1) return asMapped(byRound[0]!);
    }
  }

  const m = CLASSICAL_LABEL.exec((game.round ?? '').trim());
  if (!m) return null;
  const n = Number.parseInt(m[1]!, 10);
  const row = rows.find((r) => r.kind === 'classical' && r.game_number === n);
  return row ? asMapped(row) : null;
}

export const mappedKey = (m: MappedGame): string => `${m.kind}:${m.number}`;

// ---------------------------------------------------------------------------------------------
// Cadence (1.16 D9)
// ---------------------------------------------------------------------------------------------

export const CADENCE_MS = {
  preFar: 60 * 60_000, // > 3 days before start
  preNear: 5 * 60_000, // <= 3 days before start
  live: 2 * 60_000, // tournament: a round is live, just finished, or starts within 30 min
  between: 15 * 60_000, // tournament: rest days and nights
} as const;

/** A round counts as "live" for this long after it finished, so results are re-read for corroboration. */
export const RECENT_ROUND_MS = 30 * 60_000;
/** Polling speeds up this long before the next round starts. */
export const PRE_ROUND_MS = 30 * 60_000;

export interface RoundTiming {
  nextRoundAt: Date | null;
  anyRoundLive: boolean;
}

/** How often to sync. null = never (post_tournament). */
export function syncCadenceMs(
  phase: ChampionshipPhase,
  scheduledStart: Date,
  now: Date,
  rounds: RoundTiming,
): number | null {
  if (phase === 'post_tournament') return null;
  if (phase === 'tournament') {
    if (rounds.anyRoundLive) return CADENCE_MS.live;
    if (rounds.nextRoundAt && now.getTime() >= rounds.nextRoundAt.getTime() - PRE_ROUND_MS) {
      return CADENCE_MS.live;
    }
    return CADENCE_MS.between;
  }
  const msUntilStart = scheduledStart.getTime() - now.getTime();
  return msUntilStart <= 3 * 86_400_000 ? CADENCE_MS.preNear : CADENCE_MS.preFar;
}

export function isSyncDue(
  phase: ChampionshipPhase,
  scheduledStart: Date,
  lastSyncedAt: Date | null,
  now: Date,
  rounds: RoundTiming = { nextRoundAt: null, anyRoundLive: false },
): boolean {
  const cadence = syncCadenceMs(phase, scheduledStart, now, rounds);
  if (cadence === null) return false;
  if (!lastSyncedAt) return true;
  return now.getTime() - lastSyncedAt.getTime() >= cadence;
}

const isRecent = (iso: string | undefined, now: Date): boolean =>
  iso !== undefined && now.getTime() - new Date(iso).getTime() <= RECENT_ROUND_MS;

/** Round timing from the provider's event: live or just-finished rounds, and the next scheduled start. */
export function roundTiming(event: ChessEvent | undefined, now: Date): RoundTiming {
  if (!event) return { nextRoundAt: null, anyRoundLive: false };
  let next: Date | null = null;
  let live = false;
  for (const r of event.rounds) {
    if (r.status === 'in_progress') live = true;
    if (r.status === 'completed' && isRecent(r.finishedAt, now)) live = true;
    if (r.status === 'upcoming' && r.startsAt) {
      const at = new Date(r.startsAt);
      if (!next || at < next) next = at;
    }
  }
  return { nextRoundAt: next, anyRoundLive: live };
}

/** At most this many per-round game requests per source and sync. */
export const MAX_ROUNDS_PER_SYNC = 6;

/**
 * Rounds whose games are worth fetching during the tournament: live rounds, rounds that finished
 * within the last 30 min, and rounds bound to a game that is still unconfirmed.
 * An empty list means no games request at all (rest day).
 */
export function roundsToFetch(
  event: ChessEvent,
  now: Date,
  unconfirmedBoundRoundIds: Set<string>,
): string[] {
  const picked: string[] = [];
  for (const r of event.rounds) {
    const wanted =
      r.status === 'in_progress' ||
      (r.status === 'completed' && isRecent(r.finishedAt, now)) ||
      unconfirmedBoundRoundIds.has(r.externalId);
    if (wanted) picked.push(r.externalId);
  }
  // Bound rounds the event no longer lists (renamed or regrouped) are still re-read.
  for (const id of unconfirmedBoundRoundIds) if (!picked.includes(id)) picked.push(id);
  return picked.slice(-MAX_ROUNDS_PER_SYNC);
}
