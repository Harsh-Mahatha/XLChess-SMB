import { createHash } from 'node:crypto';
import {
  ANGLE_CATALOGUE,
  BASE_PHASE,
  DEFAULT_MIN_SCORE,
  DEFAULT_WEIGHTS,
  FACT_CATALOGUE,
  isKnownFact,
  meetsMinimum,
  type AngleContext,
  type AngleDefinition,
  type Channel,
  type ClaimView,
  type FactKey,
  type RankedAngle,
  type Rejection,
  type ScoreBreakdown,
  type ScoreWeightKey,
  type SelectionOutcome,
  type StorySelection,
} from '@smb/shared';

/** A story that was already chosen for an earlier post of the same type. */
export interface HistoryEntry {
  opportunityId: string;
  angleId: string;
  features: string[];
  fingerprint: string;
  chosenAt: Date;
}

export interface SelectionInput {
  phase: string | null;
  claims: ClaimView[];
  history: HistoryEntry[];
  channels: Channel[];
  /** Work whose evidence is older than this is stale (the phase's staleAfterMinutes). */
  staleAfterMinutes: number;
  deduplication: { similarityThreshold: number };
  storySelection?: StorySelection;
  now: Date;
  /** Defaults to the whole catalogue. Tests pass their own. */
  catalogue?: readonly AngleDefinition[];
}

export interface SelectionResult {
  outcome: SelectionOutcome;
  /** Present when outcome is `selected`. */
  selected?: RankedAngle & { score: number };
  /** Every angle, best first: eligible ones by score, then rejected ones. */
  ranking: RankedAngle[];
  /** Plain-language reason a reviewer can read. */
  reason: string;
}

/** Jaccard similarity of two feature sets: 1 = the same story, 0 = nothing in common. */
export function similarity(a: readonly string[], b: readonly string[]): number {
  const x = new Set(a);
  const y = new Set(b);
  if (x.size === 0 && y.size === 0) return 0;
  let shared = 0;
  for (const f of x) if (y.has(f)) shared++;
  return shared / (x.size + y.size - shared);
}

export function fingerprintOf(angleId: string, features: readonly string[]): string {
  return createHash('sha256')
    .update(JSON.stringify([angleId, [...new Set(features)].sort()]))
    .digest('hex');
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

function contextOf(claims: ClaimView[]): AngleContext {
  const byKey = new Map(claims.map((c) => [c.claimKey, c]));
  return { claim: (key: FactKey) => byKey.get(key) };
}

/** The newest event time among the angle's claims, or undefined when none has one. */
function newestEvent(claims: (ClaimView | undefined)[]): Date | undefined {
  const times = claims
    .flatMap((c) => (c?.eventTime ? [new Date(c.eventTime).getTime()] : []))
    .filter((t) => Number.isFinite(t));
  return times.length ? new Date(Math.max(...times)) : undefined;
}

function weightsOf(config?: StorySelection): Record<ScoreWeightKey, number> {
  const w = { ...DEFAULT_WEIGHTS, ...config?.weights };
  const total = Object.values(w).reduce((a, b) => a + b, 0);
  // Normalised, so the score always lies between 0 and 1 whatever the operator set.
  return Object.fromEntries(
    (Object.keys(w) as ScoreWeightKey[]).map((k) => [k, total > 0 ? w[k] / total : 0]),
  ) as Record<ScoreWeightKey, number>;
}

function channelFit(angle: AngleDefinition, channels: Channel[]): number {
  if (channels.length === 0) return 1;
  const fits = channels.map((c) => angle.channelFit?.[c] ?? 1);
  return fits.reduce((a, b) => a + b, 0) / fits.length;
}

/**
 * Ranks every angle against the evidence and the recent history, and picks the strongest one that
 * is supported. Pure: the same inputs always give the same answer and nothing is invented.
 *
 *  1. Gates. An angle is rejected, with a reason, when it is unsupported, switched off, made for a
 *     different phase, missing a fact or holding one below its verification level, not applicable
 *     to this evidence, or based on stale evidence.
 *  2. Novelty. An angle whose story matches a recent post is rejected as a duplicate (identical)
 *     or repetitive (similarity at or above the configured threshold).
 *  3. Score. Weighted significance, timeliness, novelty, relevance and channel suitability.
 *  4. If no angle is left, or the best scores below `minScore`, the result is `no_worthwhile_post`.
 */
export function rankStories(input: SelectionInput): SelectionResult {
  const catalogue = input.catalogue ?? ANGLE_CATALOGUE;
  const config = input.storySelection;
  const weights = weightsOf(config);
  const minScore = config?.minScore ?? DEFAULT_MIN_SCORE;
  const allowed = config?.angles ? new Set(config.angles) : undefined;
  const phase = input.phase ?? BASE_PHASE;
  const ctx = contextOf(input.claims);
  const staleMs = input.staleAfterMinutes * 60_000;

  const ranked: RankedAngle[] = catalogue.map((angle) => {
    const rejections: Rejection[] = [];
    const reject = (code: Rejection['code'], message: string) => rejections.push({ code, message });
    const base = (): RankedAngle => ({
      angleId: angle.id,
      eligible: false,
      rejections,
      features: [],
    });

    if (angle.unsupported) {
      reject('unsupported', angle.unsupported);
      return base();
    }
    if (allowed && !allowed.has(angle.id)) {
      reject('disabled', 'not listed in storySelection.angles');
      return base();
    }
    const native = angle.phases.includes(phase);
    if (!native && !angle.evergreen) {
      reject('wrong_phase', `made for ${angle.phases.join(', ')}, not ${phase}`);
      return base();
    }

    for (const fact of angle.requiredFacts) {
      const claim = ctx.claim(fact);
      if (!claim) {
        reject('missing_fact', `${fact} is not in the research package`);
      } else if (isKnownFact(claim.claimKey)) {
        const required = FACT_CATALOGUE[claim.claimKey].minVerification;
        if (!meetsMinimum(claim.verification, required)) {
          reject('weak_fact', `${fact} is ${claim.verification}, needs ${required}`);
        }
      }
    }
    if (rejections.length > 0) return base();

    const notApplicable = angle.applicable?.(ctx);
    if (notApplicable) {
      reject('not_applicable', notApplicable);
      return base();
    }

    const claims = angle.requiredFacts.map((f) => ctx.claim(f));
    const newest = angle.evergreen && !native ? undefined : newestEvent(claims);
    const ageMs = newest ? input.now.getTime() - newest.getTime() : undefined;
    if (!angle.evergreen && ageMs !== undefined && ageMs > staleMs) {
      reject(
        'stale',
        `the evidence is ${Math.round(ageMs / 60_000)} minutes old; the limit is ${input.staleAfterMinutes}`,
      );
      return base();
    }

    const features = [`angle:${angle.id}`, ...angle.features(ctx)];
    const fingerprint = fingerprintOf(angle.id, features);
    const out: RankedAngle = { ...base(), features, fingerprint };

    let most: { entry: HistoryEntry; value: number } | undefined;
    for (const h of input.history) {
      const value = h.fingerprint === fingerprint ? 1 : similarity(features, h.features);
      if (!most || value > most.value) most = { entry: h, value };
    }
    if (most) {
      out.mostSimilar = {
        opportunityId: most.entry.opportunityId,
        angleId: most.entry.angleId,
        similarity: round3(most.value),
      };
    }

    const novelty = 1 - (most?.value ?? 0);
    const timeliness = ageMs === undefined ? 0.5 : clamp01(1 - ageMs / (staleMs > 0 ? staleMs : 1));
    const breakdown: ScoreBreakdown = {
      significance: round3(clamp01(angle.baseSignificance + (angle.significanceBoost?.(ctx) ?? 0))),
      timeliness: round3(timeliness),
      novelty: round3(novelty),
      relevance: native ? 1 : 0.5,
      channel: round3(channelFit(angle, input.channels)),
    };
    out.breakdown = breakdown;
    out.score = round3(
      (Object.keys(weights) as ScoreWeightKey[]).reduce((s, k) => s + weights[k] * breakdown[k], 0),
    );

    if (most && most.value >= 1) {
      reject(
        'duplicate',
        `the same story as ${most.entry.angleId} already chosen for ${most.entry.opportunityId}`,
      );
    } else if (most && most.value >= input.deduplication.similarityThreshold) {
      reject(
        'repetitive',
        `${round3(most.value)} similar to ${most.entry.angleId} chosen for ${most.entry.opportunityId} ` +
          `(threshold ${input.deduplication.similarityThreshold}); nothing meaningfully new`,
      );
    } else if (out.score < minScore) {
      reject('below_minimum', `score ${out.score} is below the minimum ${minScore}`);
    }
    out.eligible = rejections.length === 0;
    return out;
  });

  const order = (a: RankedAngle, b: RankedAngle): number =>
    Number(b.eligible) - Number(a.eligible) ||
    (b.score ?? -1) - (a.score ?? -1) ||
    a.angleId.localeCompare(b.angleId);
  ranked.sort(order);

  const best = ranked[0];
  if (best?.eligible && best.score !== undefined) {
    const runnerUp = ranked.find((r, i) => i > 0 && r.eligible);
    const b = best.breakdown!;
    const reason =
      `Selected "${best.angleId}" (score ${best.score}): significance ${b.significance}, ` +
      `timeliness ${b.timeliness}, novelty ${b.novelty}, relevance ${b.relevance}, channel ${b.channel}.` +
      (runnerUp
        ? ` Runner-up: "${runnerUp.angleId}" (${runnerUp.score}).`
        : ' No other angle qualified.');
    return {
      outcome: 'selected',
      selected: { ...best, score: best.score },
      ranking: ranked,
      reason,
    };
  }

  const counts = new Map<string, number>();
  for (const r of ranked)
    for (const j of r.rejections) counts.set(j.code, (counts.get(j.code) ?? 0) + 1);
  const why = [...counts].map(([code, n]) => `${n} ${code}`).join(', ');
  return {
    outcome: 'no_worthwhile_post',
    ranking: ranked,
    reason: `No worthwhile post: no angle is supported by verified evidence, fresh and different enough from recent posts (${why}).`,
  };
}
