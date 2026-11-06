import { describe, expect, it } from 'vitest';
import { checkGame } from '../../../apps/api/src/research/chess.js';
import { parsePgnGames } from '../../../apps/api/src/sources/lichess/pgn.js';
import { fixture } from '../sources/helpers.js';

const FOOLS_MATE = (result: string) => `[Result "${result}"]\n\n1. f3 e5 2. g4 Qh4# ${result}\n`;
// Sam Loyd's ten-move stalemate.
const STALEMATE = (result: string) =>
  `[Result "${result}"]\n\n1. e3 a5 2. Qh5 Ra6 3. Qxa5 h5 4. h4 Rah6 5. Qxc7 f6 6. Qxd7+ Kf7 7. Qxb7 Qd3 8. Qxb8 Qh7 9. Qxc8 Kg6 10. Qe6 ${result}\n`;
// Scholar's mate with engine evaluations; Black's 3...Nf6?? allows mate in one.
const SCHOLARS = `[Result "1-0"]\n\n1. e4 { [%eval 0.2] } e5 { [%eval 0.2] } 2. Qh5 { [%eval 0.3] } Nc6 { [%eval 0.3] } 3. Bc4 { [%eval 0.4] } Nf6?? { [%eval #1] } 4. Qxf7# 1-0\n`;

describe('checkGame', () => {
  it('accepts a checkmate whose result agrees', () => {
    expect(checkGame(FOOLS_MATE('0-1'), '0-1')).toMatchObject({ ok: true, plies: 4 });
  });

  it('rejects a checkmate whose result tag says the opposite', () => {
    expect(checkGame(FOOLS_MATE('1-0'), '1-0')).toMatchObject({
      ok: false,
      code: 'result_mismatch',
    });
  });

  it('rejects a draw result on a checkmate', () => {
    expect(checkGame(FOOLS_MATE('1/2-1/2'), '1/2-1/2')).toMatchObject({
      ok: false,
      code: 'result_mismatch',
    });
  });

  it('accepts a stalemate scored as a draw and rejects it scored as a win', () => {
    expect(checkGame(STALEMATE('1/2-1/2'), '1/2-1/2').ok).toBe(true);
    expect(checkGame(STALEMATE('1-0'), '1-0')).toMatchObject({
      ok: false,
      code: 'result_mismatch',
    });
  });

  it('cannot judge resignations or draws by agreement, so any result is accepted for an unfinished position', () => {
    const pgn = '[Result "0-1"]\n\n1. e4 e5 2. Nf3 Nc6 0-1\n';
    expect(checkGame(pgn, '0-1').ok).toBe(true);
    expect(checkGame(pgn.replace('0-1', '1/2-1/2'), '1/2-1/2').ok).toBe(true);
  });

  it('rejects an illegal move', () => {
    expect(checkGame('[Result "1-0"]\n\n1. e4 e4 1-0\n', '1-0')).toMatchObject({
      ok: false,
      code: 'pgn_invalid',
    });
    expect(checkGame('[Result "1-0"]\n\n1. e5 1-0\n', '1-0')).toMatchObject({
      ok: false,
      code: 'pgn_invalid',
    });
  });

  it('reports a mate appearing as a key moment', () => {
    const r = checkGame(SCHOLARS, '1-0');
    expect(r).toMatchObject({ ok: true, hasEvals: true });
    if (!r.ok) return;
    expect(r.moments).toHaveLength(1);
    expect(r.moments[0]).toMatchObject({
      ply: 6,
      moveNumber: 3,
      side: 'black',
      san: 'Nf6',
      mateAppears: true,
      evalBefore: 0.4,
      evalAfter: 10,
    });
  });

  it('keeps only the largest swings, in game order', () => {
    const pgn =
      '[Result "*"]\n\n1. e4 { [%eval 0.0] } e5 { [%eval 2.0] } 2. Nf3 { [%eval -1.0] } Nc6 { [%eval 1.0] } 3. Bb5 { [%eval 1.1] } a6 { [%eval 5.0] } 4. Ba4 { [%eval 5.2] } Nf6 { [%eval -2.0] } *\n';
    const r = checkGame(pgn, '*', 1.5, 2);
    expect(r.ok && r.moments.map((m) => m.ply)).toEqual([6, 8]); // swings 3.9 and 7.2
  });

  it('reports no evaluations when the PGN has none', () => {
    expect(checkGame('[Result "*"]\n\n1. e4 e5 *\n', '*')).toMatchObject({
      ok: true,
      hasEvals: false,
      moments: [],
    });
  });

  it('replays every game of the recorded Lichess round', () => {
    for (const g of parsePgnGames(fixture('round.pgn'))) {
      const r = checkGame(g.pgn, g.headers['Result'] as '1-0');
      expect(r.ok, `${g.headers['White']} - ${g.headers['Black']}`).toBe(true);
      if (r.ok) expect(r.hasEvals).toBe(true);
    }
  });
});
