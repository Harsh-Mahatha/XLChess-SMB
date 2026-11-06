import { describe, expect, it } from 'vitest';
import {
  ANGLE_CATALOGUE,
  type ClaimView,
  type ClaimVerification,
  type StorySelection,
} from '../../../packages/shared/src/index.js';
import {
  fingerprintOf,
  rankStories,
  similarity,
  type HistoryEntry,
  type SelectionInput,
} from '../../../apps/api/src/story/select.js';

const NOW = new Date('2026-11-04T12:00:00.000Z');
const minutesAgo = (m: number): string => new Date(NOW.getTime() - m * 60_000).toISOString();

function claim(
  key: string,
  value: unknown,
  verification: ClaimVerification = 'verified',
  eventTime?: string,
): ClaimView {
  return { claimKey: key, value, verification, confidence: 0.9, eventTime };
}

const gameResult = (result: string, round = '1', age = 30, v: ClaimVerification = 'verified') =>
  claim(
    'game.result',
    { result, white: 'Gukesh D', black: 'Sindarov J', round },
    v,
    minutesAgo(age),
  );

const swing = (ply: number, amount: number) => ({ ply, swing: amount });

function tournamentClaims(over: ClaimView[] = []): ClaimView[] {
  const base = [
    gameResult('1-0'),
    claim('match.score', { completedGames: 1 }, 'verified', minutesAgo(30)),
    claim(
      'match.situation',
      { leader: 'Gukesh D', tied: false, margin: 1, roundsRemaining: 13, totalRounds: 14 },
      'verified',
      minutesAgo(30),
    ),
    claim('game.key_moments', [swing(31, 2.4), swing(44, 6)], 'single_source', minutesAgo(30)),
    claim('next_game', { name: 'Round 2', startsAt: minutesAgo(-1200) }, 'single_source'),
  ];
  const keys = new Set(over.map((c) => c.claimKey));
  return [...base.filter((c) => !keys.has(c.claimKey)), ...over];
}

function input(over: Partial<SelectionInput> = {}): SelectionInput {
  return {
    phase: 'tournament',
    claims: tournamentClaims(),
    history: [],
    channels: ['x'],
    staleAfterMinutes: 360,
    deduplication: { similarityThreshold: 0.85 },
    now: NOW,
    ...over,
  };
}

/** What the selector would have stored for an earlier post. */
function historyOf(i: SelectionInput, angleId: string, opportunityId = 'opp-old'): HistoryEntry {
  const r = rankStories(i).ranking.find((x) => x.angleId === angleId)!;
  return {
    opportunityId,
    angleId,
    features: r.features,
    fingerprint: r.fingerprint!,
    chosenAt: NOW,
  };
}

const rejection = (res: ReturnType<typeof rankStories>, id: string) =>
  res.ranking.find((r) => r.angleId === id)!.rejections.map((j) => j.code);

describe('similarity', () => {
  it('is 1 for the same features and 0 for none shared', () => {
    expect(similarity(['a', 'b'], ['b', 'a'])).toBe(1);
    expect(similarity(['a'], ['b'])).toBe(0);
    expect(similarity([], [])).toBe(0);
  });
  it('is the Jaccard overlap otherwise', () => {
    expect(similarity(['a', 'b', 'c'], ['b', 'c', 'd'])).toBe(0.5);
  });
});

describe('fingerprintOf', () => {
  it('ignores order and duplicates but not content', () => {
    expect(fingerprintOf('x', ['a', 'b'])).toBe(fingerprintOf('x', ['b', 'a', 'a']));
    expect(fingerprintOf('x', ['a'])).not.toBe(fingerprintOf('y', ['a']));
    expect(fingerprintOf('x', ['a'])).not.toBe(fingerprintOf('x', ['b']));
  });
});

describe('rankStories: choosing a story', () => {
  it('selects a supported angle without being told a topic, and ranks every angle with reasons', () => {
    const res = rankStories(input());
    expect(res.outcome).toBe('selected');
    expect(res.selected?.angleId).toBeDefined();
    expect(res.ranking).toHaveLength(ANGLE_CATALOGUE.length);
    expect(res.reason).toContain(res.selected!.angleId);
    for (const r of res.ranking) {
      expect(r.eligible || r.rejections.length > 0).toBe(true);
      if (r.eligible) expect(r.breakdown).toBeDefined();
    }
    const scores = res.ranking.filter((r) => r.eligible).map((r) => r.score!);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it('is deterministic', () => {
    expect(rankStories(input())).toEqual(rankStories(input()));
  });

  it('prefers a decisive result to a draw', () => {
    const win = rankStories(input({ claims: tournamentClaims([gameResult('1-0')]) }));
    const draw = rankStories(input({ claims: tournamentClaims([gameResult('1/2-1/2')]) }));
    const score = (r: typeof win) => r.ranking.find((x) => x.angleId === 'game_result')!.score!;
    expect(score(win)).toBeGreaterThan(score(draw));
  });

  it('puts a clinched match first', () => {
    const res = rankStories(
      input({
        claims: tournamentClaims([
          claim('match.situation', {
            leader: 'Gukesh D',
            tied: false,
            margin: 3,
            roundsRemaining: 2,
            totalRounds: 14,
          }),
        ]),
      }),
    );
    expect(res.selected?.angleId).toBe('match_clinched');
  });

  it('does not call a match clinched while it can still be caught', () => {
    const res = rankStories(input());
    expect(rejection(res, 'match_clinched')).toEqual(['not_applicable']);
  });

  it('never selects an angle whose evidence does not exist yet', () => {
    const res = rankStories(input({ phase: 'pre_tournament' }));
    expect(rejection(res, 'rating_movement')).toEqual(['unsupported']);
    expect(res.selected?.angleId).not.toBe('rating_movement');
  });
});

describe('rankStories: evidence gates', () => {
  it('rejects an angle whose claim is below the required verification level', () => {
    const res = rankStories(
      input({ claims: tournamentClaims([gameResult('1-0', '1', 30, 'single_source')]) }),
    );
    expect(rejection(res, 'game_result')).toEqual(['weak_fact']);
  });

  it('rejects an angle whose claim is conflicting', () => {
    const res = rankStories(
      input({ claims: tournamentClaims([gameResult('1-0', '1', 30, 'conflicting')]) }),
    );
    expect(rejection(res, 'game_result')).toEqual(['weak_fact']);
  });

  it('rejects an angle with a missing fact and says which', () => {
    const claims = tournamentClaims().filter((c) => c.claimKey !== 'match.score');
    const res = rankStories(input({ claims }));
    const why = res.ranking.find((r) => r.angleId === 'match_standing')!.rejections;
    expect(why[0]?.code).toBe('missing_fact');
    expect(why[0]?.message).toContain('match.score');
  });

  it('rejects angles made for another phase', () => {
    const res = rankStories(input({ phase: 'post_tournament' }));
    expect(rejection(res, 'game_result')).toEqual(['wrong_phase']);
  });

  it('rejects fresh-news angles when the evidence is stale', () => {
    const res = rankStories(input({ claims: tournamentClaims([gameResult('1-0', '1', 400)]) }));
    expect(rejection(res, 'game_result')).toEqual(['stale']);
  });

  it('flags no worthwhile post instead of inventing one when nothing is supported', () => {
    const res = rankStories(input({ claims: [] }));
    expect(res.outcome).toBe('no_worthwhile_post');
    expect(res.selected).toBeUndefined();
    expect(res.reason).toContain('No worthwhile post');
    expect(res.ranking.every((r) => !r.eligible)).toBe(true);
  });

  it('honours the allow-list in the post type config', () => {
    const storySelection: StorySelection = { angles: ['next_game_preview'] };
    const res = rankStories(input({ storySelection }));
    expect(res.selected?.angleId).toBe('next_game_preview');
    expect(rejection(res, 'game_result')).toEqual(['disabled']);
  });

  it('returns no worthwhile post when the best score is under the minimum', () => {
    const res = rankStories(input({ storySelection: { minScore: 0.99 } }));
    expect(res.outcome).toBe('no_worthwhile_post');
    expect(rejection(res, 'game_result')).toEqual(['below_minimum']);
  });
});

describe('rankStories: avoiding repetition', () => {
  it('rejects the same story about the same game as a duplicate', () => {
    const first = input();
    const res = rankStories(input({ history: [historyOf(first, 'game_result')] }));
    expect(rejection(res, 'game_result')).toEqual(['duplicate']);
    expect(res.ranking.find((r) => r.angleId === 'game_result')!.mostSimilar?.similarity).toBe(1);
    expect(res.selected?.angleId).not.toBe('game_result');
  });

  it('allows the same angle about a different game', () => {
    const first = input();
    const nextGame = input({
      claims: tournamentClaims([gameResult('1/2-1/2', '2', 20)]),
      history: [historyOf(first, 'game_result')],
    });
    expect(rejection(rankStories(nextGame), 'game_result')).toEqual([]);
  });

  it('allows the same angle when something meaningful has changed', () => {
    const first = input();
    const later = input({
      claims: tournamentClaims([
        claim('match.situation', {
          leader: 'Sindarov J',
          tied: false,
          margin: 1,
          roundsRemaining: 12,
          totalRounds: 14,
        }),
      ]),
      history: [historyOf(first, 'match_standing')],
    });
    expect(rejection(rankStories(later), 'match_standing')).toEqual([]);
  });

  it('rejects a near-identical story at the configured threshold', () => {
    const first = input();
    const entry = historyOf(first, 'game_result');
    // Same game and angle, one feature different: 2 of 4 shared.
    const near: HistoryEntry = {
      ...entry,
      fingerprint: 'f'.repeat(64),
      features: [...entry.features.slice(0, -1), 'result:other'],
    };
    const strict = rankStories(
      input({ history: [near], deduplication: { similarityThreshold: 0.4 } }),
    );
    const loose = rankStories(
      input({ history: [near], deduplication: { similarityThreshold: 0.9 } }),
    );
    expect(rejection(strict, 'game_result')).toEqual(['repetitive']);
    expect(rejection(loose, 'game_result')).toEqual([]);
  });

  it('moves on to a different evergreen angle once the introduction was used', () => {
    const preTournament = (history: HistoryEntry[] = []) =>
      input({
        phase: 'pre_tournament',
        history,
        claims: [
          claim('event.name', 'World Championship 2026', 'single_source'),
          claim('event.dates', { start: '2026-11-10', end: '2026-11-30' }, 'single_source'),
          claim('event.venue', 'Dubai', 'single_source'),
          claim('format', { format: 'Match', timeControl: '90+30' }, 'single_source'),
          claim('participants', [{ name: 'Gukesh D' }, { name: 'Sindarov J' }], 'single_source'),
          claim(
            'next_game',
            { name: 'Round 1', startsAt: '2026-11-10T12:00:00Z' },
            'single_source',
          ),
        ],
      });
    const intro = rankStories(preTournament());
    const used = [historyOf(preTournament(), intro.selected!.angleId)];
    const second = rankStories(preTournament(used));
    expect(second.selected?.angleId).toBeDefined();
    expect(second.selected?.angleId).not.toBe(intro.selected!.angleId);
    expect(rejection(second, intro.selected!.angleId)).toEqual(['duplicate']);
  });

  it('flags no worthwhile post when every supported story has been used', () => {
    const base = input({
      phase: 'pre_tournament',
      claims: [claim('format', { format: 'Match' }, 'single_source')],
    });
    const used = historyOf(base, 'format_explainer');
    const res = rankStories({ ...base, history: [used] });
    expect(res.outcome).toBe('no_worthwhile_post');
    expect(rejection(res, 'format_explainer')).toEqual(['duplicate']);
  });

  it('uses evergreen angles outside their phase only at lower relevance', () => {
    const claims = [claim('format', { format: 'Match' }, 'single_source')];
    const native = rankStories(input({ phase: 'pre_tournament', claims }));
    const fallback = rankStories(input({ phase: 'tournament', claims }));
    const rel = (r: typeof native) =>
      r.ranking.find((x) => x.angleId === 'format_explainer')!.breakdown!.relevance;
    expect(rel(native)).toBe(1);
    expect(rel(fallback)).toBe(0.5);
  });
});
