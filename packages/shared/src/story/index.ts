import { z } from 'zod';
import type { Channel, ClaimVerification } from '../domain/index.js';
import type { FactKey } from '../research/index.js';

/**
 * Story angles and the contracts for deterministic story selection (module 1.6).
 * An angle is a way of telling one story. Code decides which angles the evidence supports;
 * nothing here calls a model.
 */

/** Bump when scoring or eligibility rules change, so stored selections stay explainable. */
export const SELECTOR_VERSION = 'story-select/1';

/** Phase token for a post that is not in any configured phase. */
export const BASE_PHASE = 'base';

/** What an angle can read: the claims of the research package, nothing else. */
export interface ClaimView {
  claimKey: string;
  value: unknown;
  verification: ClaimVerification;
  confidence: number;
  eventTime?: string;
}

export interface AngleContext {
  claim(key: FactKey): ClaimView | undefined;
}

export interface AngleDefinition {
  id: string;
  description: string;
  /** Claims the angle cannot be told without. All must exist and meet their verification level. */
  requiredFacts: readonly FactKey[];
  /** Phases the angle is made for (BASE_PHASE for a post outside any phase). */
  phases: readonly string[];
  /** May also be used outside its phases, at lower relevance, when nothing fresher is available. */
  evergreen: boolean;
  /** 0..1 before the evidence adjusts it. */
  baseSignificance: number;
  /** Set when the evidence for the angle does not exist yet. The angle is listed and rejected with this reason. */
  unsupported?: string;
  /** Returns why the angle does not apply to this evidence, or null when it does. */
  applicable?(ctx: AngleContext): string | null;
  /** Added to baseSignificance from the evidence (result type, margin, size of an evaluation swing). */
  significanceBoost?(ctx: AngleContext): number;
  /** The facts this story is about. Two posts with the same features repeat each other. */
  features(ctx: AngleContext): string[];
  /** 0..1 per channel, default 1. */
  channelFit?: Partial<Record<Channel, number>>;
}

const norm = (v: unknown): string =>
  String(v ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
const day = (v: unknown): string => String(v ?? '').slice(0, 10);

function gameKey(v: unknown): string {
  const g = rec(v);
  return `${norm(g.white)}|${norm(g.black)}|${norm(g.round)}`;
}

function situation(ctx: AngleContext): {
  leader: string | null;
  margin: number;
  remaining: number;
} | null {
  const v = ctx.claim('match.situation')?.value;
  if (!v) return null;
  const s = rec(v);
  return {
    leader: typeof s.leader === 'string' ? s.leader : null,
    margin: Number(s.margin ?? 0),
    remaining: Number(s.roundsRemaining ?? 0),
  };
}

function maxSwing(ctx: AngleContext): number {
  const moments = ctx.claim('game.key_moments')?.value;
  if (!Array.isArray(moments)) return 0;
  return Math.max(0, ...moments.map((m) => Math.abs(Number(rec(m).swing ?? 0))));
}

const event = (ctx: AngleContext) => norm(ctx.claim('event.name')?.value);

/**
 * Every angle SMB knows. A post type may restrict this list in `storySelection.angles`;
 * a phase that wants an angle must also list the facts it needs in its `requiredFacts`.
 */
export const ANGLE_CATALOGUE: readonly AngleDefinition[] = [
  // --- during the tournament -------------------------------------------------------------
  {
    id: 'game_result',
    description: 'The result of a game that has just finished',
    requiredFacts: ['game.result'],
    phases: ['tournament'],
    evergreen: false,
    baseSignificance: 0.55,
    significanceBoost: (ctx) =>
      rec(ctx.claim('game.result')?.value).result === '1/2-1/2' ? 0 : 0.25,
    features: (ctx) => {
      const v = rec(ctx.claim('game.result')?.value);
      return [`game:${gameKey(v)}`, `result:${norm(v.result)}`];
    },
  },
  {
    id: 'decisive_moment',
    description: 'The moment an engine evaluation swung the most',
    requiredFacts: ['game.key_moments'],
    phases: ['tournament'],
    evergreen: false,
    baseSignificance: 0.45,
    applicable: (ctx) =>
      maxSwing(ctx) > 0 ? null : 'the game has no evaluation swing worth a story',
    significanceBoost: (ctx) => Math.min(0.35, maxSwing(ctx) / 10),
    features: (ctx) => {
      const moments = ctx.claim('game.key_moments')?.value;
      const plies = Array.isArray(moments) ? moments.map((m) => Number(rec(m).ply)) : [];
      return [
        `played:${norm(ctx.claim('game.key_moments')?.eventTime)}`,
        `moments:${plies.join(',')}`,
        `swing:${maxSwing(ctx).toFixed(1)}`,
      ];
    },
  },
  {
    id: 'match_standing',
    description: 'Who leads the match and how many rounds remain',
    requiredFacts: ['match.score', 'match.situation'],
    phases: ['tournament'],
    evergreen: false,
    baseSignificance: 0.55,
    applicable: (ctx) => (situation(ctx)?.leader ? null : 'nobody leads the match yet'),
    significanceBoost: (ctx) => {
      const s = situation(ctx);
      return s && s.remaining <= 2 ? 0.2 : 0.05;
    },
    features: (ctx) => {
      const s = situation(ctx);
      return [
        `leader:${norm(s?.leader)}`,
        `margin:${s?.margin ?? 0}`,
        `remaining:${s?.remaining ?? 0}`,
      ];
    },
  },
  {
    id: 'match_clinched',
    description: 'A player can no longer be caught',
    requiredFacts: ['match.score', 'match.situation'],
    phases: ['tournament'],
    evergreen: false,
    baseSignificance: 0.95,
    applicable: (ctx) => {
      const s = situation(ctx);
      return s?.leader && s.margin > s.remaining
        ? null
        : 'the lead is not larger than the points still available';
    },
    features: (ctx) => [`clinched:${norm(situation(ctx)?.leader)}`],
  },
  {
    id: 'next_game_preview',
    description: 'What is coming in the next round',
    requiredFacts: ['next_game'],
    phases: ['tournament'],
    evergreen: false,
    baseSignificance: 0.3,
    features: (ctx) => {
      const n = rec(ctx.claim('next_game')?.value);
      return [`next:${norm(n.name)}`, `starts:${norm(n.startsAt)}`];
    },
  },

  // --- before the tournament (also usable as evergreen) ---------------------------------
  {
    id: 'event_intro',
    description: 'What the event is, where and when',
    requiredFacts: ['event.name', 'event.dates', 'event.venue'],
    phases: ['pre_tournament', BASE_PHASE],
    evergreen: true,
    baseSignificance: 0.4,
    features: (ctx) => [
      `event:${event(ctx)}`,
      `dates:${day(rec(ctx.claim('event.dates')?.value).start)}`,
      `venue:${norm(ctx.claim('event.venue')?.value)}`,
    ],
  },
  {
    id: 'players_intro',
    description: 'Who is playing',
    requiredFacts: ['participants'],
    phases: ['pre_tournament', BASE_PHASE],
    evergreen: true,
    baseSignificance: 0.4,
    applicable: (ctx) => {
      const p = ctx.claim('participants')?.value;
      return Array.isArray(p) && p.length > 0 ? null : 'no players are known yet';
    },
    features: (ctx) => {
      const p = ctx.claim('participants')?.value;
      const names = Array.isArray(p) ? p.map((x) => norm(rec(x).name)).sort() : [];
      return [`players:${names.join('|')}`];
    },
  },
  {
    id: 'format_explainer',
    description: 'How the event works: format and time control',
    requiredFacts: ['format'],
    phases: ['pre_tournament', BASE_PHASE],
    evergreen: true,
    baseSignificance: 0.35,
    features: (ctx) => [`format:${norm(JSON.stringify(ctx.claim('format')?.value ?? ''))}`],
    channelFit: { x: 0.7 },
  },
  {
    id: 'schedule_countdown',
    description: 'When play starts',
    requiredFacts: ['event.dates', 'next_game'],
    phases: ['pre_tournament'],
    evergreen: false,
    baseSignificance: 0.45,
    features: (ctx) => [
      `start:${day(rec(ctx.claim('event.dates')?.value).start)}`,
      `next:${norm(rec(ctx.claim('next_game')?.value).startsAt)}`,
    ],
  },

  // --- after the tournament ---------------------------------------------------------------
  {
    id: 'outcome',
    description: 'Who won and the final standings',
    requiredFacts: ['event.outcome'],
    phases: ['post_tournament'],
    evergreen: false,
    baseSignificance: 0.9,
    applicable: (ctx) =>
      rec(ctx.claim('event.outcome')?.value).winner
        ? null
        : 'there is no unique winner without tiebreaks',
    features: (ctx) => {
      const o = rec(ctx.claim('event.outcome')?.value);
      return [`event:${event(ctx)}`, `winner:${norm(o.winner)}`];
    },
  },
  {
    id: 'next_cycle',
    description: 'What comes next in the qualification cycle',
    requiredFacts: ['next_cycle.stage'],
    phases: ['post_tournament'],
    evergreen: false,
    baseSignificance: 0.5,
    features: (ctx) => [
      `stage:${norm(JSON.stringify(ctx.claim('next_cycle.stage')?.value ?? ''))}`,
    ],
  },

  // --- listed so reviewers can see why it is never chosen ------------------------------------
  {
    id: 'rating_movement',
    description: "A player's rating change over a period",
    requiredFacts: [],
    phases: ['pre_tournament', BASE_PHASE],
    evergreen: true,
    baseSignificance: 0.6,
    unsupported: 'no approved source provides ratings yet (needs a FIDE adapter and a rating fact)',
    features: () => [],
  },
];

export const ANGLE_IDS: readonly string[] = ANGLE_CATALOGUE.map((a) => a.id);

export function isKnownAngle(id: string): boolean {
  return ANGLE_IDS.includes(id);
}

// ---------------------------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------------------------

export const SCORE_WEIGHT_KEYS = [
  'significance',
  'timeliness',
  'novelty',
  'relevance',
  'channel',
] as const;
export type ScoreWeightKey = (typeof SCORE_WEIGHT_KEYS)[number];

export const DEFAULT_WEIGHTS: Record<ScoreWeightKey, number> = {
  significance: 0.35,
  timeliness: 0.25,
  novelty: 0.2,
  relevance: 0.1,
  channel: 0.1,
};
export const DEFAULT_MIN_SCORE = 0.35;

const weight = z.number().min(0).max(1);

/** Optional per-post-type tuning. Without it, every catalogue angle and the default weights apply. */
export const StorySelection = z
  .object({
    /** Allow-list of angle ids. Omit to allow the whole catalogue. */
    angles: z.array(z.string().min(1)).min(1).optional(),
    /** Below this the post is not worth making. */
    minScore: z.number().min(0).max(1).optional(),
    weights: z
      .object({
        significance: weight.optional(),
        timeliness: weight.optional(),
        novelty: weight.optional(),
        relevance: weight.optional(),
        channel: weight.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type StorySelection = z.infer<typeof StorySelection>;

// ---------------------------------------------------------------------------------------------
// Result shapes (stored in smb.story_selections)
// ---------------------------------------------------------------------------------------------

export type RejectionCode =
  | 'unsupported'
  | 'disabled'
  | 'wrong_phase'
  | 'missing_fact'
  | 'weak_fact'
  | 'not_applicable'
  | 'stale'
  | 'duplicate'
  | 'repetitive'
  | 'below_minimum';

export interface Rejection {
  code: RejectionCode;
  message: string;
}

export interface ScoreBreakdown {
  significance: number;
  timeliness: number;
  novelty: number;
  relevance: number;
  channel: number;
}

export interface SimilarStory {
  opportunityId: string;
  angleId: string;
  similarity: number;
}

export interface RankedAngle {
  angleId: string;
  eligible: boolean;
  /** Weighted 0..1. Present once the evidence checks pass, even when a later check rejects it. */
  score?: number;
  breakdown?: ScoreBreakdown;
  rejections: Rejection[];
  features: string[];
  fingerprint?: string;
  mostSimilar?: SimilarStory;
}

export type SelectionOutcome = 'selected' | 'no_worthwhile_post';
