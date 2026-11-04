import {
  CONFLICT_CONFIDENCE,
  canonicalJson,
  confidenceFor,
  type ClaimVerification,
  type ConflictNote,
  type SourceReliability,
} from '@smb/shared';

/** What one source said about one fact, tied to the stored record that proves it. */
export interface Observation {
  sourceId: string;
  reliability: SourceReliability;
  value: unknown;
  recordId: string;
  payloadHash: string;
}

export interface Assessment {
  /** The agreed value. For an unresolved conflict this is `{ conflict: candidates }`. */
  value: unknown;
  verification: ClaimVerification;
  confidence: number;
  recordIds: string[];
  payloadHashes: string[];
  conflict?: Omit<ConflictNote, 'claimKey'>;
}

const TIER: SourceReliability[] = ['official', 'structured_feed', 'publication', 'unverified'];
const best = (list: SourceReliability[]): SourceReliability =>
  TIER.find((t) => list.includes(t)) ?? 'unverified';

/**
 * Decides how well a fact is supported.
 *  - `verified`: an official source says it, or at least two independent sources (distinct source ids) agree.
 *  - `single_source`: exactly one non-official source says it.
 *  - `conflicting`: sources disagree and no official source settles it. Both values are kept for a human.
 *  - `unverified`: nothing said it.
 * Several records from the same source count as one source, because they are not independent.
 * A conflict that an official source settles is recorded as resolved, so it stays visible.
 */
export function assess(
  observations: Observation[],
  canon: (value: unknown) => string = canonicalJson,
): Assessment {
  if (observations.length === 0) {
    return {
      value: null,
      verification: 'unverified',
      confidence: 0,
      recordIds: [],
      payloadHashes: [],
    };
  }
  const recordIds = [...new Set(observations.map((o) => o.recordId))];
  const payloadHashes = [...new Set(observations.map((o) => o.payloadHash))];

  const groups = new Map<string, Observation[]>();
  for (const o of observations) {
    const key = canon(o.value);
    groups.set(key, [...(groups.get(key) ?? []), o]);
  }
  const sourcesIn = (g: Observation[]) => new Set(g.map((o) => o.sourceId));
  const candidates = [...groups.values()].map((g) => ({
    sourceId: [...sourcesIn(g)].join('+'),
    value: g[0]!.value,
  }));

  if (groups.size === 1) {
    const group = [...groups.values()][0]!;
    const sources = sourcesIn(group);
    const tier = best(group.map((o) => o.reliability));
    const verification: ClaimVerification =
      tier === 'official' || sources.size >= 2 ? 'verified' : 'single_source';
    return {
      value: group[0]!.value,
      verification,
      confidence: confidenceFor(tier, sources.size),
      recordIds,
      payloadHashes,
    };
  }

  // Sources disagree. Only an official source (all of them agreeing) can settle it.
  const officialGroups = [...groups.values()]
    .map((g) => g.filter((o) => o.reliability === 'official'))
    .filter((g) => g.length > 0);
  const officialValues = new Set(officialGroups.map((g) => canon(g[0]!.value)));
  if (officialValues.size === 1) {
    const winner = officialGroups[0]!;
    return {
      value: winner[0]!.value,
      verification: 'verified',
      confidence: confidenceFor('official', sourcesIn(winner).size),
      recordIds,
      payloadHashes,
      conflict: {
        resolved: true,
        candidates,
        resolvedAgainst: [...sourcesIn(winner)].join('+'),
      },
    };
  }
  return {
    value: { conflict: candidates },
    verification: 'conflicting',
    confidence: CONFLICT_CONFIDENCE,
    recordIds,
    payloadHashes,
    conflict: { resolved: false, candidates },
  };
}
