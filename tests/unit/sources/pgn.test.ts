import { describe, expect, it } from 'vitest';
import { parsePgnGames } from '../../../apps/api/src/sources/lichess/pgn.js';
import { fixture } from './helpers.js';

describe('parsePgnGames', () => {
  it('splits a round into games and reads tags, keeping each game verbatim', () => {
    const games = parsePgnGames(fixture('round.pgn'));
    expect(games).toHaveLength(3);
    const g = games[0]!;
    expect(g.headers['White']).toBe('Marianna Feldmann');
    expect(g.headers['Result']).toBe('0-1');
    expect(g.headers['BlackElo']).toBe('1726');
    expect(g.pgn.startsWith('[Event ')).toBe(true);
    expect(g.pgn).toContain('1. e4');
    // No game's text leaks into the next one.
    expect(games.every((x) => (x.pgn.match(/\[Event "/g) ?? []).length === 1)).toBe(true);
  });

  it('unescapes quotes and backslashes in tag values', () => {
    const [g] = parsePgnGames('[Event "a \\"quoted\\" \\\\ name"]\n[Result "*"]\n\n*\n');
    expect(g!.headers['Event']).toBe('a "quoted" \\ name');
  });

  it('handles CRLF input', () => {
    const games = parsePgnGames(
      '[Event "A"]\r\n[Result "*"]\r\n\r\n*\r\n\r\n[Event "B"]\r\n[Result "*"]\r\n\r\n*\r\n',
    );
    expect(games.map((g) => g.headers['Event'])).toEqual(['A', 'B']);
  });

  it('returns no games for empty text', () => {
    expect(parsePgnGames('  \n')).toEqual([]);
  });

  it.each([['<html>rate limited</html>'], ['[Event "A"\n\n*'], ['{"error":"x"}']])(
    'rejects text that is not PGN: %s',
    (text) => {
      expect(() => parsePgnGames(text)).toThrow();
    },
  );
});
