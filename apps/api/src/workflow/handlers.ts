import { PostTypeConfig, type Aspect, type RenderDataInput } from '@smb/shared';
import type { jobs } from '@prisma/client';
import { purgeExpiredAssets } from '../assets/index.js';
import { generateCandidates, reviseCandidate } from '../generation/index.js';
import { discoverImages, listChosenPhotos } from '../images/index.js';
import { slotForTemplate } from '../graphics/registry.js';
import { GraphicError } from '../graphics/text.js';
import { renderGraphic } from '../graphics/render.js';
import { JobError } from '../jobs/index.js';
import {
  ResearchNotReadyError,
  assertReadyForGeneration,
  buildResearchPackage,
} from '../research/index.js';
import { selectStory } from '../story/index.js';
import { buildRenderData } from './render-data.js';
import { nowOf, type WorkflowDeps } from './types.js';

export type JobResult = Record<string, unknown>;

const payloadOf = (job: jobs): Record<string, unknown> =>
  (job.payload as Record<string, unknown> | null) ?? {};
const str = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || !v)
    throw new JobError('bad_payload', `the job has no ${what}`, false);
  return v;
};

/** Research, then the readiness gate: a package that is missing required facts is retried later, not passed on. */
async function researchBuild(deps: WorkflowDeps, job: jobs): Promise<JobResult> {
  const opportunityId = str(payloadOf(job).opportunityId, 'opportunityId');
  const built = await buildResearchPackage(
    { db: deps.db, gateway: deps.gateway, registry: deps.sources },
    opportunityId,
    job.id,
  );
  if (built.status === 'failed') {
    throw new JobError('sources_failed', 'no source answered; the research package is empty', true);
  }
  try {
    await assertReadyForGeneration(deps.db, built.packageId);
  } catch (err) {
    if (err instanceof ResearchNotReadyError) {
      throw new JobError('research_not_ready', err.message, true);
    }
    throw err;
  }
  return { packageId: built.packageId, version: built.version, status: built.status };
}

async function storySelect(deps: WorkflowDeps, job: jobs): Promise<JobResult> {
  const opportunityId = str(payloadOf(job).opportunityId, 'opportunityId');
  const stored = await selectStory(deps.db, opportunityId, { jobId: job.id, now: nowOf(deps) });
  return { selectionId: stored.id, outcome: stored.outcome, angleId: stored.angleId ?? null };
}

async function imagesDiscover(deps: WorkflowDeps, job: jobs): Promise<JobResult> {
  const opportunityId = str(payloadOf(job).opportunityId, 'opportunityId');
  const out = await discoverImages(
    {
      db: deps.db,
      runtimes: deps.imageRuntimes,
      store: deps.store,
      downloader: deps.downloader,
      allowShareAlike: deps.allowShareAlike,
      slotForTemplate: slotForTemplate(deps.templates),
      now: deps.now,
    },
    opportunityId,
  );
  return {
    status: out.status,
    chosen: out.chosen.length,
    needsHuman: out.needsHuman,
    errors: out.errors,
  };
}

/** Graphic errors that mean "these inputs need a person or the no-photograph variant", not "the code is broken". */
const NEEDS_FALLBACK = new Set([
  'text_overflow',
  'missing_data',
  'photo_missing',
  'photo_too_small',
  'photo_not_usable',
  'unknown_flag',
]);

export interface RenderOutcome {
  rendered: boolean;
  reason?: string;
  withPhotos?: boolean;
  renderKey?: string;
  assetId?: string;
}

/**
 * Makes the graphic for one revision of one candidate. A render that cannot be made from verified inputs (no
 * mapping for the template, text too long, a photograph that does not fit) is retried once without photographs,
 * and if that fails too the candidate simply goes to review without a graphic. Only `verification_failed`, a
 * defect, stops the job.
 */
export async function renderForRevision(
  deps: WorkflowDeps,
  candidateId: string,
  revisionId: string,
  jobId?: string,
): Promise<RenderOutcome> {
  const candidate = await deps.db.post_candidates.findUniqueOrThrow({
    where: { id: candidateId },
    include: { post_opportunities: true },
  });
  const opp = candidate.post_opportunities;
  const configRow = await deps.db.post_configs.findUniqueOrThrow({
    where: { id: opp.post_config_id },
  });
  const config = PostTypeConfig.parse(configRow.config_json);
  const planned = (candidate.visual_plan as { template?: string } | null)?.template;
  const templateName =
    planned && deps.templates.has(planned) ? planned : config.imageRules.template;
  if (!templateName || !deps.templates.has(templateName)) {
    return { rendered: false, reason: `unknown template ${templateName ?? '(none)'}` };
  }
  const manifest = deps.templates.get(templateName);
  const claims = await deps.db.research_claims.findMany({
    where: { package_id: candidate.research_package_id },
  });
  const photos = await listChosenPhotos(deps.db, opp.id);
  const revision = await deps.db.post_revisions.findUniqueOrThrow({ where: { id: revisionId } });
  const built = buildRenderData(
    manifest,
    claims.map((c) => ({ claimKey: c.claim_key, value: c.value })),
    photos,
    revision.headline ?? undefined,
  );
  if (!built.mapped) return { rendered: false, reason: built.reason };

  const aspect: Aspect = '16:9';
  const attempt = async (data: RenderDataInput) =>
    renderGraphic(
      { db: deps.db, store: deps.store, registry: deps.templates },
      {
        template: manifest.id,
        aspect,
        data,
        candidateId,
        revisionId,
        opportunityId: opp.id,
        jobId,
      },
    );
  try {
    const r = await attempt(built.data);
    return {
      rendered: true,
      withPhotos: built.photoSlots.length > 0,
      renderKey: r.renderKey,
      assetId: r.assetId,
    };
  } catch (err) {
    if (!(err instanceof GraphicError) || !NEEDS_FALLBACK.has(err.code)) throw err;
    if (built.photoSlots.length === 0)
      return { rendered: false, reason: `${err.code}: ${err.message}` };
    try {
      const r = await attempt({ ...built.data, photos: {} });
      return {
        rendered: true,
        withPhotos: false,
        renderKey: r.renderKey,
        assetId: r.assetId,
        reason: `no photograph: ${err.code}`,
      };
    } catch (second) {
      if (second instanceof GraphicError && NEEDS_FALLBACK.has(second.code)) {
        return { rendered: false, reason: `${second.code}: ${second.message}` };
      }
      throw second;
    }
  }
}

async function graphicsRender(deps: WorkflowDeps, job: jobs): Promise<JobResult> {
  const p = payloadOf(job);
  const outcome = await renderForRevision(
    deps,
    str(p.candidateId, 'candidateId'),
    str(p.revisionId, 'revisionId'),
    job.id,
  );
  return { ...outcome };
}

async function assetsPurge(deps: WorkflowDeps): Promise<JobResult> {
  const r = await purgeExpiredAssets({ db: deps.db, store: deps.store }, nowOf(deps));
  return {
    removed: r.removed,
    alreadyGone: r.alreadyGone,
    failed: r.failed.length,
    retention: r.retention,
  };
}

async function candidatesGenerate(deps: WorkflowDeps, job: jobs): Promise<JobResult> {
  if (!deps.provider) throw new JobError('no_provider', 'no AI provider is configured here', false);
  const p = payloadOf(job);
  const out = await generateCandidates(
    { db: deps.db, provider: deps.provider, channels: deps.channels },
    str(p.opportunityId, 'opportunityId'),
    { jobId: job.id, newCycle: p.newCycle === true },
  );
  return { cycle: out.cycle, created: out.created, candidates: out.candidates.length };
}

async function revisionFromFeedback(deps: WorkflowDeps, job: jobs): Promise<JobResult> {
  if (!deps.provider) throw new JobError('no_provider', 'no AI provider is configured here', false);
  const out = await reviseCandidate(
    { db: deps.db, provider: deps.provider, channels: deps.channels },
    str(payloadOf(job).actionId, 'actionId'),
    { jobId: job.id },
  );
  return { revisionId: out.revisionId, created: out.created, passed: out.passed };
}

/** Runs one job's work. Throws on failure; the caller records the outcome with the queue. */
export async function executeJob(deps: WorkflowDeps, job: jobs): Promise<JobResult> {
  switch (job.kind) {
    case 'research_build':
      return researchBuild(deps, job);
    case 'story_select':
      return storySelect(deps, job);
    case 'images_discover':
      return imagesDiscover(deps, job);
    case 'graphics_render':
      return graphicsRender(deps, job);
    case 'assets_purge':
      return assetsPurge(deps);
    case 'candidates_generate':
      return candidatesGenerate(deps, job);
    case 'revision_from_feedback':
      return revisionFromFeedback(deps, job);
    default:
      throw new JobError('unknown_kind', `no handler for job kind ${job.kind}`, false);
  }
}
