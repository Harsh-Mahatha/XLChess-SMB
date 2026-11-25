import { describe, expect, it } from 'vitest';
import {
  OFFICIAL_SOURCE_ID,
  mapConfirmedGame,
  mapCycleToEvent,
  mapCycleToNews,
  mapCycleToPlayers,
  type OfficialCycleRow,
  type OfficialGameRow,
} from '../../../apps/api/src/sources/official/adapter.js';

function cycleRow(overrides: Partial<OfficialCycleRow> = {}): OfficialCycleRow {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    cycle_key: 'world-championship-2026',
    title: 'FIDE World Championship 2026',
    official_url: 'https://www.fide.com/wcc-2026',
    venue: 'Singapore',
    scheduled_start: new Date('2026-11-20T09:00:00Z'),
    scheduled_end: new Date('2026-12-08T09:00:00Z'),
    total_games: 14,
    player_a: { name: 'Gukesh D', fideId: '46616543', title: 'GM', federation: 'IND' },
    player_b: { name: 'Ding Liren', fideId: '8603677', title: 'GM', federation: 'CHN' },
    confirmed_start: null,
    confirmed_end: null,
    winner: null,
    next_cycle: null,
    updated_at: new Date('2026-11-18T10:00:00Z'),
    ...overrides,
  };
}

function gameRow(overrides: Partial<OfficialGameRow> = {}): OfficialGameRow {
  return {
    id: '00000000-0000-4000-8000-000000000011',
    kind: 'classical',
    game_number: 1,
    idempotency_key: 'world-championship-2026:game-1:result',
    state: 'scheduled',
    scheduled_at: new Date('2026-11-20T09:00:00Z'),
    white_player: 'a',
    result: null,
    d3_game_id: null,
    d3_round_id: null,
    round_label: null,
    round_name: null,
    round_url: null,
    pgn: null,
    played_at: null,
    confirmed_at: null,
    confirmed_by: null,
    confirmation_basis: null,
    result_version: 1,
    ...overrides,
  };
}

describe('officialRecordAdapter pure mappings (D1)', () => {
  it('derives event status from confirmed_start and confirmed_end, and maps rounds', () => {
    const upcoming = mapCycleToEvent(cycleRow(), [gameRow()]);
    expect(upcoming.data.sourceId).toBe(OFFICIAL_SOURCE_ID);
    expect(upcoming.data.status).toBe('upcoming');
    expect(upcoming.data.rounds[0]).toMatchObject({
      externalId: 'world-championship-2026:game-1',
      name: 'Game 1',
      status: 'upcoming',
    });

    const inProgress = mapCycleToEvent(
      cycleRow({ confirmed_start: new Date('2026-11-20T09:00:00Z') }),
      [
        gameRow({
          state: 'confirmed',
          result: '1-0',
          confirmed_at: new Date('2026-11-20T14:00:00Z'),
          round_name: 'Round 1',
        }),
        gameRow({ game_number: 2, state: 'result_observed', result: '0-1' }),
      ],
    );
    expect(inProgress.data.status).toBe('in_progress');
    expect(inProgress.data.rounds.map((r) => r.status)).toEqual(['completed', 'in_progress']);
    expect(inProgress.data.rounds[0]!.name).toBe('Round 1');

    const completed = mapCycleToEvent(
      cycleRow({
        confirmed_start: new Date('2026-11-20T09:00:00Z'),
        confirmed_end: new Date('2026-12-08T16:00:00Z'),
      }),
      [],
    );
    expect(completed.data.status).toBe('completed');
  });

  it('returns only confirmed games, preserves D3 round_label, and builds header-only PGN when absent', () => {
    const cycle = cycleRow({ confirmed_start: new Date('2026-11-20T09:00:00Z') });
    expect(
      mapConfirmedGame(cycle, gameRow({ state: 'result_observed', result: '1-0' })),
    ).toBeNull();

    const mapped = mapConfirmedGame(
      cycle,
      gameRow({
        state: 'confirmed',
        result: '1-0',
        white_player: 'b',
        round_label: '1.1',
        confirmed_at: new Date('2026-11-20T14:00:00Z'),
        confirmed_by: 'admin-1',
        confirmation_basis: 'official_entry',
      }),
    )!;
    expect(mapped).not.toBeNull();
    expect(mapped.data.externalId).toBe('world-championship-2026:game-1');
    expect(mapped.data.round).toBe('1.1');
    expect(mapped.data.white.name).toBe('Ding Liren');
    expect(mapped.data.black.name).toBe('Gukesh D');
    expect(mapped.data.pgn).toContain('[Result "1-0"]');
    expect(mapped.data.pgn).toContain('1-0');
    expect(mapped.data.headers['Result']).toBe('1-0');
  });

  it('falls back to clean header-only PGN if stored feed PGN contradicts the confirmed result', () => {
    const cycle = cycleRow({ confirmed_start: new Date('2026-11-20T09:00:00Z') });
    const badFeedPgn = '[Event "t"]\n[Result "0-1"]\n\n1. f3 e5 2. g4 Qh4# 0-1\n';
    const mapped = mapConfirmedGame(
      cycle,
      gameRow({
        state: 'confirmed',
        result: '1-0',
        pgn: badFeedPgn,
        confirmed_at: new Date('2026-11-20T14:00:00Z'),
        confirmed_by: 'admin-1',
        confirmation_basis: 'official_entry',
      }),
    )!;
    expect(mapped.data.result).toBe('1-0');
    expect(mapped.data.pgn).toContain('[Result "1-0"]');
    expect(mapped.data.pgn).not.toContain('Qh4#');
  });

  it('maps players without ratings and news only when next_cycle is set', () => {
    const c = cycleRow();
    const players = mapCycleToPlayers(c);
    expect(players).toHaveLength(2);
    expect(players[0]!.data).toMatchObject({
      sourceId: 'D1',
      externalId: '46616543',
      name: 'Gukesh D',
    });
    expect(players[0]!.data.rating).toBeUndefined();

    expect(mapCycleToNews(c)).toEqual([]);

    const withNews = mapCycleToNews(
      cycleRow({
        next_cycle: {
          stage: 'Candidates Tournament 2028',
          summary: 'Qualification begins Q1 2027',
          url: 'https://www.fide.com/candidates-2028',
        },
      }),
    );
    expect(withNews).toHaveLength(1);
    expect(withNews[0]!.data).toMatchObject({
      sourceId: 'D1',
      externalId: 'world-championship-2026:next-cycle',
      title: 'Candidates Tournament 2028',
      summary: 'Qualification begins Q1 2027',
    });
  });
});
