import { describe, expect, it } from 'vitest';
import { clinched, matchScore, uniqueWinner, type ScoredGame } from '@smb/shared';

describe('championship scoring', () => {
  const games: ScoredGame[] = [
    { kind: 'classical', state: 'confirmed', result: '1-0', whitePlayer: 'a' }, // A +1
    { kind: 'classical', state: 'confirmed', result: '1/2-1/2', whitePlayer: 'b' }, // A +0.5, B +0.5
    { kind: 'classical', state: 'confirmed', result: '0-1', whitePlayer: 'b' }, // A +1 (B was white and lost)
    { kind: 'classical', state: 'result_observed', result: '0-1', whitePlayer: 'a' }, // ignored
    { kind: 'classical', state: 'in_progress', result: null, whitePlayer: 'b' }, // ignored
    { kind: 'classical', state: 'scheduled', result: null, whitePlayer: null }, // ignored
    { kind: 'tiebreak', state: 'confirmed', result: '0-1', whitePlayer: 'a' }, // B +1 (tiebreak)
  ];

  it('counts only confirmed games and respects whitePlayer', () => {
    expect(matchScore(games, 'classical')).toEqual({ a: 2.5, b: 0.5, confirmed: 3 });
    expect(matchScore(games, 'tiebreak')).toEqual({ a: 0, b: 1, confirmed: 1 });
    expect(matchScore(games)).toEqual({ a: 2.5, b: 1.5, confirmed: 4 });
  });

  it('clinched requires strictly more than half of totalGames', () => {
    expect(clinched({ a: 7.5, b: 2.5 }, 14)).toBe('a');
    expect(clinched({ a: 7.0, b: 3.0 }, 14)).toBeNull();
    expect(clinched({ a: 3.0, b: 7.5 }, 14)).toBe('b');
  });

  it('uniqueWinner returns null on ties and the leader otherwise', () => {
    expect(uniqueWinner({ a: 7, b: 7 })).toBeNull();
    expect(uniqueWinner({ a: 7.5, b: 6.5 })).toBe('a');
    expect(uniqueWinner({ a: 6.5, b: 7.5 })).toBe('b');
  });
});
