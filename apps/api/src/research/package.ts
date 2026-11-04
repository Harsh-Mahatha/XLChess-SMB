import type { Prisma, PrismaClient } from '@prisma/client';
import {
  FACT_CATALOGUE,
  PostTypeConfig,
  ResearchSubject,
  isKnownFact,
  meetsMinimum,
  resolvePhase,
  type PackageSummary,
  type ResearchSubject as Subject,
  type SourcesRegistry,
  type SourceReliability,
} from '@smb/shared';
import type { SourceGateway } from '../sources/gateway.js';
import {
  assemblePackage,
  notReadyReasons,
  ResearchNotReadyError,
  type AssembledPackage,
} from './assemble.js';
import { buildClaims } from './claims.js';
import { gather, type Gathered } from './gather.js';

export interface ResearchInput {
  subject: Subject;
  requiredFacts: string[];
  phase: string | null;
  reliabilityOf: (sourceId: string) => SourceReliability;
}

/** Pure step: retrieved data in, assembled package out. No I/O, so it is tested with fixtures. */
export function researchFromGathered(g: Gathered, input: ResearchInput): AssembledPackage {
  const built = buildClaims({
    subject: input.subject,
    requiredFacts: input.requiredFacts,
    events: g.events,
    games: g.games,
    failures: g.failures,
    reliabilityOf: input.reliabilityOf,
  });
  return assemblePackage({
    phase: input.phase,
    requiredFacts: input.requiredFacts,
    claims: built.claims,
    missing: built.missing,
    conflicts: built.conflicts,
    issues: built.issues,
    failures: g.failures,
    skippedSources: g.skipped,
    attempted: g.attempted,
    succeeded: g.succeeded,
    retrievedAt: g.retrievedAt,
  });
}

export function reliabilityFrom(
  registry: SourcesRegistry,
): (sourceId: string) => SourceReliability {
  const map = new Map(
    registry.sources.flatMap((s) => (s.kind === 'data' ? [[s.id, s.reliability] as const] : [])),
  );
  return (id) => map.get(id) ?? 'unverified';
}

/** Stores the package, its claims and every claim-to-evidence link in one transaction. */
export async function savePackage(
  db: PrismaClient,
  opportunityId: string,
  pkg: AssembledPackage,
  jobId?: string,
): Promise<{ packageId: string; version: number }> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`select pg_advisory_xact_lock(hashtext(${'smb.research:' + opportunityId}))`;
    const latest = await tx.research_packages.aggregate({
      where: { opportunity_id: opportunityId },
      _max: { version: true },
    });
    const version = (latest._max.version ?? 0) + 1;
    const created = await tx.research_packages.create({
      data: { opportunity_id: opportunityId, version, status: 'building', job_id: jobId },
    });
    for (const c of pkg.claims) {
      if (c.evidenceRecordIds.length === 0) {
        throw new Error(`claim ${c.claimKey} has no evidence; refusing to store it`);
      }
      await tx.research_claims.create({
        data: {
          package_id: created.id,
          claim_key: c.claimKey,
          description: c.description,
          value: c.value as Prisma.InputJsonValue,
          computed: c.computed,
          computation: c.computation,
          verification: c.verification,
          confidence: c.confidence,
          event_time: c.eventTime ? new Date(c.eventTime) : undefined,
          research_claim_sources: {
            create: c.evidenceRecordIds.map((id) => ({ source_record_id: id })),
          },
        },
      });
    }
    await tx.research_packages.update({
      where: { id: created.id },
      data: {
        status: pkg.status,
        summary: pkg.summary as unknown as Prisma.InputJsonValue,
        content_hash: pkg.contentHash,
      },
    });
    return { packageId: created.id, version };
  });
}

export interface BuildDeps {
  db: PrismaClient;
  gateway: SourceGateway;
  registry: SourcesRegistry;
}

/**
 * Research step for one posting opportunity: load its pinned config and phase, retrieve evidence
 * through the gateway, build and verify claims, and store a new package version.
 */
export async function buildResearchPackage(
  deps: BuildDeps,
  opportunityId: string,
  jobId?: string,
): Promise<{ packageId: string; version: number; status: AssembledPackage['status'] }> {
  const opp = await deps.db.post_opportunities.findUniqueOrThrow({ where: { id: opportunityId } });
  const row = await deps.db.post_configs.findUniqueOrThrow({ where: { id: opp.post_config_id } });
  const config = PostTypeConfig.parse(row.config_json);
  const effective = resolvePhase(config, opp.phase);
  const subject = ResearchSubject.parse(opp.trigger_ref);

  const gathered = await gather(deps.gateway, config.sources, subject);
  const pkg = researchFromGathered(gathered, {
    subject,
    requiredFacts: effective.contentRules.requiredFacts,
    phase: effective.phaseId,
    reliabilityOf: reliabilityFrom(deps.registry),
  });
  const saved = await savePackage(deps.db, opportunityId, pkg, jobId);
  return { ...saved, status: pkg.status };
}

/**
 * The gate generation (module 1.7) must pass. Throws ResearchNotReadyError unless the package is
 * complete, every claim still meets its required verification level, and every claim has evidence.
 */
export async function assertReadyForGeneration(db: PrismaClient, packageId: string): Promise<void> {
  const pkg = await db.research_packages.findUniqueOrThrow({
    where: { id: packageId },
    include: { research_claims: { include: { research_claim_sources: true } } },
  });
  const summary = pkg.summary as unknown as PackageSummary;
  const reasons = notReadyReasons(pkg.status, summary);
  for (const c of pkg.research_claims) {
    if (c.research_claim_sources.length === 0) reasons.push(`${c.claim_key} has no evidence`);
    if (isKnownFact(c.claim_key)) {
      const required = FACT_CATALOGUE[c.claim_key].minVerification;
      if (!meetsMinimum(c.verification, required)) {
        reasons.push(`${c.claim_key} is ${c.verification}, needs ${required}`);
      }
    }
  }
  if (pkg.status !== 'complete' || reasons.length > 0) {
    throw new ResearchNotReadyError(packageId, pkg.status, [...new Set(reasons)]);
  }
}
