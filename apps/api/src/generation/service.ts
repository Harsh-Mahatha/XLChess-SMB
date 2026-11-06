import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import {
  canonicalJson,
  recheckGeneration,
  runGeneration,
  type AiProvider,
  type ChannelsRegistry,
  type GenerationInput,
  type GenerationOptions,
  type GenerationResult,
  type Slot,
} from '@smb/shared';
import { GenerationNotReadyError, buildInputForOpportunity } from './payload.js';

export interface StoredCandidate {
  id: string;
  slot: Slot;
  revisionId: string;
  /** True only when both the text checks and the visual-plan checks passed. */
  passed: boolean;
}

export interface StoredGeneration {
  cycle: number;
  candidates: StoredCandidate[];
  /** False when an earlier run already stored this set. */
  created: boolean;
}

export interface GenerateDeps {
  db: PrismaClient;
  provider: AiProvider;
  channels: ChannelsRegistry;
}

export interface GenerateOptions extends GenerationOptions {
  jobId?: string;
  /** Write a new generation cycle even if candidates already exist for this story (a regeneration). */
  newCycle?: boolean;
}

async function existing(
  db: Prisma.TransactionClient | PrismaClient,
  selectionId: string,
): Promise<StoredGeneration | undefined> {
  const rows = await db.post_candidates.findMany({
    where: { story_selection_id: selectionId },
    orderBy: [{ generation_cycle: 'desc' }, { slot: 'asc' }],
    include: { post_revisions: { orderBy: { revision_no: 'asc' }, take: 1 } },
  });
  if (rows.length === 0) return undefined;
  const cycle = rows[0]!.generation_cycle;
  return {
    cycle,
    created: false,
    candidates: rows
      .filter((r) => r.generation_cycle === cycle)
      .map((r) => ({
        id: r.id,
        slot: r.slot as Slot,
        revisionId: r.post_revisions[0]!.id,
        passed: Boolean((r.validation as { passed?: boolean } | null)?.passed),
      })),
  };
}

/** Hash that approval will bind to: the content, its assets (none yet) and the template. */
export function revisionHash(r: {
  headline: string;
  caption: string;
  channelTexts: Record<string, string | undefined>;
  template: string;
  assetHashes?: string[];
}): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        headline: r.headline,
        caption: r.caption,
        channelTexts: r.channelTexts,
        assetHashes: r.assetHashes ?? [],
        template: r.template,
      }),
    )
    .digest('hex');
}

/**
 * Stores a generation result, whoever produced it. The result is re-parsed and every check is run again
 * here, so what is stored as passing always passed the server's own validation. All three candidates, with
 * their first revision and claim links, are written in one transaction or not at all.
 */
export async function saveGeneration(
  db: PrismaClient,
  input: GenerationInput,
  selectionId: string,
  produced: GenerationResult,
  options: { jobId?: string; newCycle?: boolean } = {},
): Promise<StoredGeneration> {
  const result = recheckGeneration(produced, input);
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`select pg_advisory_xact_lock(hashtext(${'smb.generate:' + input.opportunityId}))`;
    if (!options.newCycle) {
      const already = await existing(tx, selectionId);
      if (already) return already;
    }
    const latest = await tx.post_candidates.aggregate({
      where: { opportunity_id: input.opportunityId },
      _max: { generation_cycle: true },
    });
    const cycle = (latest._max.generation_cycle ?? 0) + 1;

    const claimIds = new Map(
      (
        await tx.research_claims.findMany({
          where: { package_id: input.packageId },
          select: { id: true, claim_key: true },
        })
      ).map((c) => [c.claim_key, c.id]),
    );

    const stored: StoredCandidate[] = [];
    for (const c of result.candidates) {
      const passed = c.validation.passed && c.visualValidation.passed;
      const candidate = await tx.post_candidates.create({
        data: {
          opportunity_id: input.opportunityId,
          research_package_id: input.packageId,
          generation_cycle: cycle,
          slot: c.slot,
          angle: input.angle.id,
          provider: result.provider,
          model: result.model,
          prompt_version: result.promptVersions.candidate ?? '',
          job_id: options.jobId,
          story_selection_id: selectionId,
          approach: c.approach,
          prompt_versions: result.promptVersions as Prisma.InputJsonValue,
          generation_settings: result.settings as Prisma.InputJsonValue,
          output: c.draft as unknown as Prisma.InputJsonValue,
          validation: {
            passed,
            text: c.validation,
            visual: c.visualValidation,
          } as unknown as Prisma.InputJsonValue,
          editorial: c.editorial as unknown as Prisma.InputJsonValue,
          visual_plan: c.visualPlan as unknown as Prisma.InputJsonValue,
        },
      });
      const revision = await tx.post_revisions.create({
        data: {
          candidate_id: candidate.id,
          revision_no: 1,
          caption: c.draft.caption,
          channel_texts: c.draft.channelTexts as Prisma.InputJsonValue,
          headline: c.draft.headline,
          alt_text: c.visualPlan.altText,
          author_kind: 'ai',
          content_hash: revisionHash({
            headline: c.draft.headline,
            caption: c.draft.caption,
            channelTexts: c.draft.channelTexts,
            template: c.visualPlan.template,
          }),
          revision_claims: {
            create: [...new Set(c.draft.claimKeys)].flatMap((k) => {
              const id = claimIds.get(k);
              return id ? [{ claim_id: id }] : [];
            }),
          },
        },
      });
      stored.push({ id: candidate.id, slot: c.slot, revisionId: revision.id, passed });
    }
    return { cycle, candidates: stored, created: true };
  });
}

/**
 * Generation step for one opportunity: gate, build the model's input, run the pipeline with the given
 * provider, and store the three candidates. The opportunity stays in `generating`: images are still to
 * come (modules 1.8 to 1.10), and moving it on is the orchestrator's job (module 1.17).
 */
export async function generateCandidates(
  deps: GenerateDeps,
  opportunityId: string,
  options: GenerateOptions = {},
): Promise<StoredGeneration> {
  const opp = await deps.db.post_opportunities.findUniqueOrThrow({ where: { id: opportunityId } });
  if (opp.status !== 'generating') {
    throw new GenerationNotReadyError(
      opportunityId,
      `status is ${opp.status}, expected generating`,
    );
  }
  const { input, selectionId } = await buildInputForOpportunity(
    deps.db,
    deps.channels,
    opportunityId,
  );
  if (!options.newCycle) {
    const already = await existing(deps.db, selectionId);
    if (already) return already;
  }
  const result = await runGeneration(deps.provider, input, options);
  return saveGeneration(deps.db, input, selectionId, result, options);
}
