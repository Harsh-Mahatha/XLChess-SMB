import { z } from 'zod';
import type { ClaimVerification } from '../domain/index.js';
import type { SourceReliability } from '../config/registries.js';

/**
 * Research package contracts and the deterministic verification rules (module 1.5).
 * Nothing here calls a model or a provider: facts, statuses and confidence are computed by code.
 */

export type MinVerification = 'single_source' | 'verified';

export interface FactDefinition {
  description: string;
  /** Calculated in code from other records rather than read from a provider. */
  computed: boolean;
  /**
   * Weakest verification at which the fact may be published. Results, scores and standings need
   * `verified` (an official source, or two independent sources that agree); descriptive facts
   * (names, dates, venue, schedule) accept one structured feed because a reviewer approves every post.
   */
  minVerification: MinVerification;
}

/** Every fact key a post type may list in `contentRules.requiredFacts`. */
export const FACT_CATALOGUE = {
  'event.name': { description: 'Event name', computed: false, minVerification: 'single_source' },
  'event.dates': {
    description: 'Event start and end dates',
    computed: false,
    minVerification: 'single_source',
  },
  'event.venue': { description: 'Event venue', computed: false, minVerification: 'single_source' },
  format: {
    description: 'Tournament format and time control',
    computed: false,
    minVerification: 'single_source',
  },
  participants: {
    description: 'Players who have played in the event',
    computed: true,
    minVerification: 'single_source',
  },
  'game.result': {
    description: 'Result of the game, checked against its moves',
    computed: false,
    minVerification: 'verified',
  },
  'game.key_moments': {
    description: 'Largest engine-evaluation swings in the game',
    computed: true,
    minVerification: 'single_source',
  },
  'match.score': {
    description: 'Points scored by each player over the completed games between them',
    computed: true,
    minVerification: 'verified',
  },
  'match.situation': {
    description: 'Who leads, by how much, and how many rounds remain',
    computed: true,
    minVerification: 'verified',
  },
  next_game: {
    description: 'Next scheduled round of the event',
    computed: false,
    minVerification: 'single_source',
  },
  'event.outcome': {
    description: 'Final standing and winner of a completed event',
    computed: true,
    minVerification: 'verified',
  },
  'next_cycle.stage': {
    description: 'Next stage of the qualification cycle',
    computed: false,
    minVerification: 'verified',
  },
} as const satisfies Record<string, FactDefinition>;

export type FactKey = keyof typeof FACT_CATALOGUE;

export function isKnownFact(key: string): key is FactKey {
  return Object.hasOwn(FACT_CATALOGUE, key);
}

// ---------------------------------------------------------------------------------------------
// Verification rules
// ---------------------------------------------------------------------------------------------

const RANK: Record<ClaimVerification, number> = {
  unverified: 0,
  conflicting: 0,
  single_source: 1,
  verified: 2,
};

/** True when `actual` is publishable at the fact's required level. Conflicting and unverified never are. */
export function meetsMinimum(actual: ClaimVerification, min: MinVerification): boolean {
  if (actual === 'unverified' || actual === 'conflicting') return false;
  return RANK[actual] >= RANK[min];
}

/** A claim computed from several inputs is only as strong as its weakest input. */
export function weakestVerification(list: ClaimVerification[]): ClaimVerification {
  if (list.length === 0) return 'unverified';
  if (list.includes('conflicting')) return 'conflicting';
  if (list.includes('unverified')) return 'unverified';
  return list.reduce((a, b) => (RANK[b] < RANK[a] ? b : a));
}

const BASE_CONFIDENCE: Record<SourceReliability, number> = {
  official: 0.95,
  structured_feed: 0.8,
  publication: 0.6,
  unverified: 0.3,
};

/** Deterministic confidence: best agreeing source tier, +0.1 per extra independent source, capped. */
export function confidenceFor(best: SourceReliability, agreeingSources: number): number {
  const base = BASE_CONFIDENCE[best];
  const bonus = agreeingSources >= 2 ? 0.1 : 0;
  return Math.round(Math.min(0.99, base + bonus) * 100) / 100;
}

export const CONFLICT_CONFIDENCE = 0.3;

// ---------------------------------------------------------------------------------------------
// Package shapes
// ---------------------------------------------------------------------------------------------

/** What a research job needs to know about the thing a post is about. Stored in `trigger_ref`. */
export const ResearchSubject = z
  .object({
    /** Provider event ids by source id, for example { D3: "XtrsoyoQ" }. */
    eventRefs: z.record(z.string().regex(/^D\d+$/), z.string().min(1)),
    /** The game a game-level post is about. */
    gameRef: z
      .object({ sourceId: z.string().regex(/^D\d+$/), externalId: z.string().min(1) })
      .strict()
      .optional(),
  })
  .strict();
export type ResearchSubject = z.infer<typeof ResearchSubject>;

export interface ClaimDraft {
  /** The claimId the generator cites. Equal to the fact key. */
  claimKey: string;
  description: string;
  value: unknown;
  computed: boolean;
  computation?: string;
  verification: ClaimVerification;
  confidence: number;
  eventTime?: string;
  /** smb.source_records ids. A claim is never stored without at least one. */
  evidenceRecordIds: string[];
  /** SHA-256 payload hashes of the evidence, in the same order. Used for the package hash. */
  evidencePayloadHashes: string[];
}

export type MissingReason =
  'unknown_fact' | 'no_approved_source' | 'no_data' | 'not_applicable_yet' | 'source_failed';

export interface MissingFact {
  fact: string;
  reason: MissingReason;
  detail?: string;
}

export interface ConflictNote {
  claimKey: string;
  resolved: boolean;
  candidates: { sourceId: string; value: unknown }[];
  resolvedAgainst?: string;
}

export interface SourceFailure {
  sourceId: string;
  capability: string;
  code: string;
  message: string;
}

export interface PackageIssue {
  code: 'pgn_invalid' | 'result_mismatch';
  url: string;
  detail: string;
}

export interface PackageSummary {
  requiredFacts: string[];
  phase: string | null;
  missing: MissingFact[];
  /** Claims present but below their required verification level. */
  blocked: { claimKey: string; verification: ClaimVerification; required: MinVerification }[];
  conflicts: ConflictNote[];
  sourceErrors: SourceFailure[];
  skippedSources: { sourceId: string; reason: string }[];
  issues: PackageIssue[];
  retrievedAt?: { from: string; to: string };
}

export type PackageStatus = 'complete' | 'partial' | 'failed';
