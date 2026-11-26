import { describe, expect, it } from 'vitest';
import type { ChessEvent, ChessGame } from '@smb/shared';
import { GameCompletedEvent } from '@smb/shared';
import {
  CADENCE_MS,
  MAX_ROUNDS_PER_SYNC,
  isSyncDue,
  mapFeedGame,
  roundTiming,
  roundsToFetch,
  syncCadenceMs,
  type GameRowBinding,
} from '../../../apps/api/src/championship/mapping.js';
import { buildGameCompletedEvent } from '../../../apps/api/src/championship/emit.js';
import { eventsLoopSettings, loadEnv } from '../../../apps/api/src/env.js';

const game = (over: Partial<ChessGame>): ChessGame => ({
  sourceId: 'D3',
  externalId: 'g1',
  white: { name: 'A' },
  black: { name: 'B' },
  result: '*',
  url: 'https://lichess.org/x',
  pgn: '*',
  headers: {},
  ...over,
});

const rows: GameRowBinding[] = [
  ...Array.from({ length: 14 }, (_, i) => ({
    kind: 'classical',
    game_number: i + 1,
    d3_game_id: null,
    d3_round_id: null,
  })),
  { kind: 'tiebreak', game_number: 1, d3_game_id: null, d3_round_id: 'tb-round' },
  { kind: 'tiebreak', game_number: 2, d3_game_id: 'tb2-game', d3_round_id: null },
];

describe('mapFeedGame (D8)', () => {
  it('maps plain classical round labels', () => {
    expect(mapFeedGame(game({ round: '7' }), rows)).toEqual({ kind: 'classical', number: 7 });
    expect(mapFeedGame(game({ round: '7.1' }), rows)).toEqual({ kind: 'classical', number: 7 });
  });

  it('never guesses other boards, tiebreak labels, blank labels or unknown numbers', () => {
    expect(mapFeedGame(game({ round: '7.2' }), rows)).toBeNull();
    expect(mapFeedGame(game({ round: 'Tiebreak 1' }), rows)).toBeNull();
    expect(mapFeedGame(game({ round: '' }), rows)).toBeNull();
    expect(mapFeedGame(game({}), rows)).toBeNull();
    expect(mapFeedGame(game({ round: '15' }), rows)).toBeNull();
  });

  it('prefers a game binding, then a unique round binding, over the label', () => {
    expect(mapFeedGame(game({ externalId: 'tb2-game', round: '3' }), rows)).toEqual({
      kind: 'tiebreak',
      number: 2,
    });
    expect(mapFeedGame(game({ roundExternalId: 'tb-round', round: 'Tiebreak 1' }), rows)).toEqual({
      kind: 'tiebreak',
      number: 1,
    });
  });

  it('ignores D3 bindings for other sources and ambiguous round bindings', () => {
    expect(mapFeedGame(game({ sourceId: 'D4', externalId: 'tb2-game' }), rows)).toBeNull();
    const twoInRound = [
      ...rows,
      { kind: 'tiebreak', game_number: 3, d3_game_id: null, d3_round_id: 'tb-round' },
    ];
    expect(mapFeedGame(game({ roundExternalId: 'tb-round' }), twoInRound)).toBeNull();
  });
});

describe('round-aware cadence (D9)', () => {
  const start = new Date('2026-11-20T09:00:00Z');
  const quiet = { nextRoundAt: null, anyRoundLive: false };

  it('keeps the 1.15 pre-tournament cadences and never polls post-tournament', () => {
    expect(syncCadenceMs('pre_tournament', start, new Date('2026-11-10T00:00:00Z'), quiet)).toBe(
      CADENCE_MS.preFar,
    );
    expect(syncCadenceMs('pre_tournament', start, new Date('2026-11-18T09:00:00Z'), quiet)).toBe(
      CADENCE_MS.preNear,
    );
    expect(syncCadenceMs('post_tournament', start, new Date(), quiet)).toBeNull();
    expect(isSyncDue('post_tournament', start, null, new Date())).toBe(false);
  });

  it('polls every 2 min while live or near the next round, 15 min otherwise', () => {
    const now = new Date('2026-11-22T10:00:00Z');
    expect(syncCadenceMs('tournament', start, now, { nextRoundAt: null, anyRoundLive: true })).toBe(
      CADENCE_MS.live,
    );
    expect(
      syncCadenceMs('tournament', start, now, {
        nextRoundAt: new Date('2026-11-22T10:20:00Z'),
        anyRoundLive: false,
      }),
    ).toBe(CADENCE_MS.live);
    expect(
      syncCadenceMs('tournament', start, now, {
        nextRoundAt: new Date('2026-11-23T09:00:00Z'),
        anyRoundLive: false,
      }),
    ).toBe(CADENCE_MS.between);
    expect(syncCadenceMs('tournament', start, now, quiet)).toBe(CADENCE_MS.between);
  });

  const event = (rounds: ChessEvent['rounds']): ChessEvent => ({
    sourceId: 'D3',
    externalId: 'ev',
    name: 'WCC',
    url: 'https://lichess.org/broadcast/ev',
    status: 'in_progress',
    rounds,
  });
  const r = (
    id: string,
    status: 'upcoming' | 'in_progress' | 'completed',
    extra: object = {},
  ): ChessEvent['rounds'][number] => ({
    externalId: id,
    name: id,
    status,
    url: `https://lichess.org/r/${id}`,
    ...extra,
  });

  it('derives live rounds and the next start from the event', () => {
    const now = new Date('2026-11-22T10:00:00Z');
    expect(
      roundTiming(
        event([
          r('r1', 'completed', { finishedAt: '2026-11-21T15:00:00Z' }),
          r('r2', 'completed', { finishedAt: '2026-11-22T09:45:00Z' }),
          r('r3', 'upcoming', { startsAt: '2026-11-23T09:00:00Z' }),
          r('r4', 'upcoming', { startsAt: '2026-11-24T09:00:00Z' }),
        ]),
        now,
      ),
    ).toEqual({ nextRoundAt: new Date('2026-11-23T09:00:00Z'), anyRoundLive: true });
  });

  it('fetches only live, recent or re-read rounds; nothing on a rest day', () => {
    const now = new Date('2026-11-22T10:00:00Z');
    const rest = event([
      r('r1', 'completed', { finishedAt: '2026-11-21T15:00:00Z' }),
      r('r2', 'upcoming', { startsAt: '2026-11-23T09:00:00Z' }),
    ]);
    expect(roundsToFetch(rest, now, new Set())).toEqual([]);
    expect(roundsToFetch(rest, now, new Set(['r1']))).toEqual(['r1']);
    const live = event([r('r1', 'completed'), r('r2', 'in_progress'), r('r3', 'upcoming')]);
    expect(roundsToFetch(live, now, new Set())).toEqual(['r2']);
    const many = event(Array.from({ length: 10 }, (_, i) => r(`r${i}`, 'in_progress')));
    expect(roundsToFetch(many, now, new Set())).toHaveLength(MAX_ROUNDS_PER_SYNC);
  });
});

describe('events loop settings (D11)', () => {
  it('defaults to off with a 30 s tick', () => {
    expect(eventsLoopSettings(loadEnv({}))).toEqual({
      enabled: false,
      tickSeconds: 30,
      deprecated: [],
    });
  });

  it('honours the deprecated 1.15 names and reports them', () => {
    const s = eventsLoopSettings(
      loadEnv({ SMB_CHAMPIONSHIP_SYNC_ENABLED: 'true', SMB_CHAMPIONSHIP_SYNC_SECONDS: '45' }),
    );
    expect(s).toEqual({
      enabled: true,
      tickSeconds: 45,
      deprecated: ['SMB_CHAMPIONSHIP_SYNC_ENABLED', 'SMB_CHAMPIONSHIP_SYNC_SECONDS'],
    });
  });

  it('prefers the 1.16 names', () => {
    const s = eventsLoopSettings(
      loadEnv({
        SMB_EVENTS_ENABLED: 'false',
        SMB_EVENTS_TICK_SECONDS: '20',
        SMB_CHAMPIONSHIP_SYNC_ENABLED: 'true',
      }),
    );
    expect(s).toEqual({ enabled: false, tickSeconds: 20, deprecated: [] });
    expect(loadEnv({}).SMB_EVENTS_STABILITY_SECONDS).toBe(120);
  });
});

describe('buildGameCompletedEvent', () => {
  const cycle = {
    id: 'c',
    post_type_id: '1.1',
    cycle_key: 'wcc-2026',
    title: 'WCC 2026',
    player_a: { name: 'Gukesh D' },
    player_b: { name: 'Ding Liren' },
    source_event_refs: { D3: 'bcast', D4: 'twic-1' },
  } as unknown as Parameters<typeof buildGameCompletedEvent>[0];
  const row = (
    n: number,
    result: string | null,
    state = 'confirmed',
    white = 'a',
    kind = 'classical',
  ) =>
    ({
      kind,
      game_number: n,
      idempotency_key: `wcc-2026:${kind === 'tiebreak' ? 'tiebreak' : 'game'}-${n}:result`,
      state,
      result,
      white_player: white,
      confirmed_at: state === 'confirmed' ? new Date('2026-11-22T18:00:00Z') : null,
      played_at: new Date('2026-11-22T14:00:00Z'),
      observed_at: null,
      confirmation_basis: 'official_entry',
      d3_game_id: 'd3g',
      round_url: 'https://lichess.org/broadcast/x/r',
      round_label: String(n),
      observed_sources: ['D3', 'D4'],
    }) as unknown as Parameters<typeof buildGameCompletedEvent>[1];

  it('scores confirmed games up to and including this one, and validates', () => {
    const games = [
      row(1, '1-0'),
      row(2, '1/2-1/2', 'confirmed', 'b'),
      row(3, '0-1', 'result_observed'),
    ];
    const e = buildGameCompletedEvent(cycle, games[1]!, games);
    expect(GameCompletedEvent.parse(e)).toEqual(e);
    expect(e.identityKey).toBe('wcc-2026:game-2:result');
    expect(e.scoreAfter).toEqual({ a: 1.5, b: 0.5, basis: 'classical' });
    expect(e.players).toEqual({ white: { name: 'Ding Liren' }, black: { name: 'Gukesh D' } });
    expect(e.sources.map((s) => s.sourceId)).toEqual(['D1', 'D3', 'D4']);
    expect(e.completedAt).toBe('2026-11-22T14:00:00.000Z');
  });

  it('uses the overall score for a tiebreak', () => {
    const games = [row(1, '1-0'), row(2, '0-1'), row(1, '1-0', 'confirmed', 'a', 'tiebreak')];
    const e = buildGameCompletedEvent(cycle, games[2]!, games);
    expect(e.identityKey).toBe('wcc-2026:tiebreak-1:result');
    expect(e.scoreAfter).toEqual({ a: 2, b: 1, basis: 'overall' });
  });
});
