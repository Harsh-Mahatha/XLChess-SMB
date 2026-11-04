import {
  FACT_CATALOGUE,
  configHash,
  isKnownFact,
  meetsMinimum,
  type ClaimDraft,
  type ConflictNote,
  type MissingFact,
  type PackageIssue,
  type PackageStatus,
  type PackageSummary,
  type SourceFailure,
} from '@smb/shared';

export interface AssembleInput {
  phase: string | null;
  requiredFacts: string[];
  claims: ClaimDraft[];
  missing: MissingFact[];
  conflicts: ConflictNote[];
  issues: PackageIssue[];
  failures: SourceFailure[];
  skippedSources: PackageSummary['skippedSources'];
  /** Source calls attempted and how many returned data. */
  attempted: number;
  succeeded: number;
  retrievedAt: string[];
}

export interface AssembledPackage {
  status: PackageStatus;
  summary: PackageSummary;
  claims: ClaimDraft[];
  contentHash: string;
}

/**
 * Decides the package status from its parts.
 *  - failed: sources were called and none returned anything.
 *  - complete: every required fact has a claim at or above its required verification level.
 *  - partial: anything else (missing facts, claims below their level, conflicts, source errors).
 * A partial package is stored and shown, but the generation gate refuses it.
 */
export function assemblePackage(input: AssembleInput): AssembledPackage {
  const blocked: PackageSummary['blocked'] = [];
  for (const c of input.claims) {
    if (!isKnownFact(c.claimKey)) continue;
    const required = FACT_CATALOGUE[c.claimKey].minVerification;
    if (!meetsMinimum(c.verification, required)) {
      blocked.push({ claimKey: c.claimKey, verification: c.verification, required });
    }
  }
  const dates = [...input.retrievedAt].sort();
  // Sorted so the same evidence always gives the same summary, whatever order facts were requested in.
  const summary: PackageSummary = {
    requiredFacts: [...input.requiredFacts].sort(),
    phase: input.phase,
    missing: [...input.missing].sort((a, b) => a.fact.localeCompare(b.fact)),
    blocked: blocked.sort((a, b) => a.claimKey.localeCompare(b.claimKey)),
    conflicts: [...input.conflicts].sort((a, b) => a.claimKey.localeCompare(b.claimKey)),
    sourceErrors: input.failures,
    skippedSources: input.skippedSources,
    issues: input.issues,
    ...(dates.length ? { retrievedAt: { from: dates[0]!, to: dates.at(-1)! } } : {}),
  };

  let status: PackageStatus;
  if (input.attempted > 0 && input.succeeded === 0) status = 'failed';
  else if (
    input.missing.length === 0 &&
    blocked.length === 0 &&
    input.claims.length === input.requiredFacts.length
  ) {
    status = 'complete';
  } else status = 'partial';

  const claims = [...input.claims].sort((a, b) => a.claimKey.localeCompare(b.claimKey));
  // Hash what a reader depends on: claims, their evidence hashes and the open problems. Retrieval
  // timestamps and record ids are left out so identical evidence gives an identical hash.
  const contentHash = configHash({
    claims: claims.map((c) => ({
      claimKey: c.claimKey,
      value: c.value,
      computed: c.computed,
      computation: c.computation,
      verification: c.verification,
      confidence: c.confidence,
      eventTime: c.eventTime,
      evidence: [...c.evidencePayloadHashes].sort(),
    })),
    missing: summary.missing,
    blocked: summary.blocked,
    conflicts: summary.conflicts,
  });
  return { status, summary, claims, contentHash };
}

export class ResearchNotReadyError extends Error {
  constructor(
    readonly packageId: string,
    readonly status: string,
    readonly reasons: string[],
  ) {
    super(`research package ${packageId} is ${status}: ${reasons.join('; ')}`);
    this.name = 'ResearchNotReadyError';
  }
}

/** Human-readable reasons a package cannot go to generation. Empty when it can. */
export function notReadyReasons(status: string, summary: PackageSummary): string[] {
  if (status === 'complete') return [];
  const reasons: string[] = [];
  for (const m of summary.missing) reasons.push(`missing ${m.fact} (${m.reason})`);
  for (const b of summary.blocked) {
    reasons.push(`${b.claimKey} is ${b.verification}, needs ${b.required}`);
  }
  for (const c of summary.conflicts) {
    if (!c.resolved) reasons.push(`${c.claimKey} has conflicting sources`);
  }
  for (const e of summary.sourceErrors) reasons.push(`${e.sourceId} ${e.capability}: ${e.code}`);
  if (reasons.length === 0) reasons.push(`status is ${status}`);
  return reasons;
}
