import type { GameKind, GameState } from './flags.js';

export interface ScoredGame {
  kind: GameKind;
  state: GameState;
  result: '1-0' | '0-1' | '1/2-1/2' | null;
  whitePlayer: 'a' | 'b' | null;
}

export interface MatchScore {
  a: number;
  b: number;
  confirmed: number;
}

/**
 * Computes the confirmed match score.
 * Only `confirmed` games with a final result count; observed results never enter the score.
 */
export function matchScore(games: ScoredGame[], kind?: GameKind): MatchScore {
  let a = 0;
  let b = 0;
  let confirmed = 0;

  for (const g of games) {
    if (kind !== undefined && g.kind !== kind) continue;
    if (g.state !== 'confirmed' || g.result === null) continue;
    confirmed++;
    const white = g.whitePlayer ?? 'a';
    if (g.result === '1/2-1/2') {
      a += 0.5;
      b += 0.5;
    } else if (g.result === '1-0') {
      if (white === 'a') a += 1;
      else b += 1;
    } else if (g.result === '0-1') {
      if (white === 'a') b += 1;
      else a += 1;
    }
  }

  return { a, b, confirmed };
}

/** Returns `'a'` or `'b'` if a player has strictly more than half of `totalGames` points, else `null`. */
export function clinched(score: { a: number; b: number }, totalGames: number): 'a' | 'b' | null {
  const half = totalGames / 2;
  if (score.a > half && score.a > score.b) return 'a';
  if (score.b > half && score.b > score.a) return 'b';
  return null;
}

/** Returns `'a'` or `'b'` if one player has strictly more points than the other, else `null`. */
export function uniqueWinner(score: { a: number; b: number }): 'a' | 'b' | null {
  if (score.a > score.b) return 'a';
  if (score.b > score.a) return 'b';
  return null;
}
