import type { Prisma, PrismaClient, jobs, opportunity_status } from '@prisma/client';
import { PostTypeConfig, type GpuJobKind, type ServerJobKind } from '@smb/shared';
import { enqueueJob, isBadEnd, latestJobForBase, type JobRow } from '../jobs/index.js';
import type { WorkflowDeps, WorkflowStep } from './types.js';

export const ACTOR = 'workflow';

type StepState = 'done' | 'active' | 'bad';
export interface AdvanceResult {
  opportunityId: string;
  from: string;
  to: string;
  /** What the opportunity is waiting for, when it did not move. */
  waitingFor: string[];
}

/** Moves an opportunity between statuses. Returns false when it had already moved on (another tick got there). */
export async function transitionStatus(
  db: PrismaClient,
  opportunityId: string,
  from: readonly string[],
  to: string,
  reason: string,
  data: Prisma.post_opportunitiesUpdateManyMutationInput = {},
): Promise<boolean> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`select set_config('smb.actor', ${ACTOR}, true), set_config('smb.reason', ${reason}, true), set_config('smb.job_id', '', true)`;
    const r = await tx.post_opportunities.updateMany({
      where: { id: opportunityId, status: { in: from as opportunity_status[] } },
      data: { status: to as opportunity_status, ...data },
    });
    return r.count === 1;
  });
}

/** A step ran out of attempts or hit a failure waiting cannot fix: the opportunity stops, and says where. */
export async function failOpportunity(
  db: PrismaClient,
  opportunityId: string,
  step: WorkflowStep,
  reason: string,
): Promise<boolean> {
  return transitionStatus(
    db,
    opportunityId,
    ['pending', 'researching', 'generating'],
    'failed',
    `${step} failed: ${reason}`.slice(0, 500),
    { failed_step: step, failure_reason: reason.slice(0, 1000) },
  );
}

interface EnsureInput {
  kind: ServerJobKind | GpuJobKind;
  /** The idempotency key base. After an admin retry the newest job has `#n` appended. */
  base: string;
  opportunityId: string;
  scope?: string;
  payload: Record<string, unknown>;
  priority: number;
  maxAttempts: number;
  notAfter: Date | null;
}

/** Queues the step's job the first time, and otherwise reports what became of the newest one. */
async function ensureJob(
  db: PrismaClient,
  e: EnsureInput,
): Promise<{ state: StepState; job: JobRow }> {
  const latest = await latestJobForBase(db, e.base);
  if (!latest) {
    const { job } = await enqueueJob(db, {
      kind: e.kind,
      opportunityId: e.opportunityId,
      scope: e.scope,
      payload: e.payload,
      idempotencyKey: e.base,
      priority: e.priority,
      maxAttempts: e.maxAttempts,
      notAfter: e.notAfter,
    });
    return { state: 'active', job };
  }
  if (latest.status === 'succeeded') return { state: 'done', job: latest };
  if (isBadEnd(latest.status)) return { state: 'bad', job: latest };
  return { state: 'active', job: latest };
}

const badReason = (j: jobs): string =>
  `${j.kind} ${j.status}${j.error_code ? ` (${j.error_code})` : ''}: ${j.last_error ?? 'no reason recorded'}`;

/**
 * Looks at what exists in the database for one opportunity, decides which step is missing, queues it, and moves
 * the status on when everything for the stage is done. Nothing is remembered between calls: a crash anywhere
 * leaves the next call to work out the same answer, which is what makes recovery safe.
 *
 *   pending -> researching -> (story selected) generating -> awaiting_review
 *
 * Failures stop the opportunity in `failed` with the step that failed; `resumeOpportunity` retries from there.
 */
export async function advanceOpportunity(
  deps: WorkflowDeps,
  opportunityId: string,
): Promise<AdvanceResult> {
  const { db } = deps;
  const opp = await db.post_opportunities.findUniqueOrThrow({ where: { id: opportunityId } });
  const result = (to: string, waitingFor: string[] = []): AdvanceResult => ({
    opportunityId,
    from: opp.status,
    to,
    waitingFor,
  });
  if (!['pending', 'researching', 'generating'].includes(opp.status)) return result(opp.status);

  const row = await db.post_configs.findUniqueOrThrow({ where: { id: opp.post_config_id } });
  const config = PostTypeConfig.parse(row.config_json);
  const base = {
    opportunityId,
    priority: opp.priority,
    maxAttempts: config.retryPolicy.maxAttempts,
    notAfter: opp.not_after,
  };

  if (opp.status === 'pending') {
    await transitionStatus(db, opportunityId, ['pending'], 'researching', 'queued for research');
    return advanceOpportunity(deps, opportunityId);
  }

  if (opp.status === 'researching') {
    const entered = await db.opportunity_events.findFirst({
      where: { opportunity_id: opportunityId, to_status: 'researching' },
      orderBy: { seq: 'desc' },
    });
    const since = entered?.created_at ?? opp.created_at;
    const pkg = await db.research_packages.findFirst({
      where: {
        opportunity_id: opportunityId,
        status: { in: ['complete', 'partial'] },
        created_at: { gte: since },
      },
      orderBy: { version: 'desc' },
    });
    if (!pkg) {
      const research = await ensureJob(db, {
        ...base,
        kind: 'research_build',
        base: `research:${opportunityId}:${since.getTime()}`,
        payload: { opportunityId },
      });
      if (research.state === 'bad') {
        await failOpportunity(db, opportunityId, 'researching', badReason(research.job));
        return result('failed');
      }
      return result('researching', ['research']);
    }
    const story = await ensureJob(db, {
      ...base,
      kind: 'story_select',
      base: `story:${opportunityId}:${pkg.id}`,
      payload: { opportunityId, packageId: pkg.id },
    });
    if (story.state === 'bad') {
      await failOpportunity(db, opportunityId, 'researching', badReason(story.job));
      return result('failed');
    }
    return result('researching', ['story selection']);
  }

  // generating
  const selection = await db.story_selections.findFirst({
    where: { opportunity_id: opportunityId, outcome: 'selected' },
    orderBy: { created_at: 'desc' },
  });
  if (!selection) {
    await failOpportunity(db, opportunityId, 'researching', 'generating without a selected story');
    return result('failed');
  }
  const waiting: string[] = [];

  // Photographs: optional for most post types, so a failed search does not hold the post back.
  const images = await ensureJob(db, {
    ...base,
    kind: 'images_discover',
    base: `images:${opportunityId}:${selection.id}`,
    payload: { opportunityId, selectionId: selection.id },
  });
  let imagesDone = images.state === 'done';
  if (images.state === 'bad') {
    if (config.imageRules.need === 'required') {
      await failOpportunity(db, opportunityId, 'generating', badReason(images.job));
      return result('failed');
    }
    deps.logger.warn(
      { opportunityId, job: images.job.id },
      'image search failed; continuing without photographs',
    );
    imagesDone = true;
  }
  if (!imagesDone) waiting.push('photographs');

  // Candidates: an unanswered regeneration request first, otherwise the first set for this story.
  const regen = await db.review_actions.findFirst({
    where: { opportunity_id: opportunityId, action: 'regenerate' },
    orderBy: { created_at: 'desc' },
  });
  let wanted: EnsureInput | undefined;
  if (
    regen &&
    (regen.created_at >= selection.created_at || selection.review_action_id === regen.id) &&
    (await db.post_candidates.count({ where: { feedback_action_id: regen.id } })) === 0
  ) {
    wanted = {
      ...base,
      kind: 'candidates_generate',
      base: `regenerate:${regen.id}`,
      payload: {
        opportunityId,
        newCycle: true,
        feedback: { actionId: regen.id, text: regen.feedback, tags: regen.feedback_tags },
      },
    };
  } else if (
    (await db.post_candidates.count({ where: { story_selection_id: selection.id } })) === 0
  ) {
    wanted = {
      ...base,
      kind: 'candidates_generate',
      base: `generate:${opportunityId}:${selection.id}`,
      payload: { opportunityId },
    };
  }
  if (wanted) {
    const gen = await ensureJob(db, wanted);
    if (gen.state === 'bad') {
      await failOpportunity(db, opportunityId, 'generating', badReason(gen.job));
      return result('failed');
    }
    // `done` with nothing stored means the job stored nothing: let the next tick queue it again via retry.
    waiting.push('candidate posts');
    return result('generating', waiting);
  }

  // Graphics: one job per candidate in the newest set, once the photographs are settled.
  const all = await db.post_candidates.findMany({
    where: { opportunity_id: opportunityId },
    orderBy: { generation_cycle: 'desc' },
    include: { post_revisions: { orderBy: { revision_no: 'desc' }, take: 1 } },
  });
  const cycle = all[0]?.generation_cycle;
  const current = all.filter((c) => c.generation_cycle === cycle);
  if (imagesDone) {
    for (const c of current) {
      const rev = c.post_revisions[0];
      if (!rev) continue;
      const render = await ensureJob(db, {
        ...base,
        kind: 'graphics_render',
        base: `render:${c.id}:${rev.id}`,
        scope: c.id,
        payload: { opportunityId, candidateId: c.id, revisionId: rev.id },
      });
      if (render.state === 'bad') {
        await failOpportunity(db, opportunityId, 'generating', badReason(render.job));
        return result('failed');
      }
      if (render.state !== 'done') waiting.push(`graphic for candidate ${c.slot}`);
    }
  }
  if (waiting.length > 0) return result('generating', waiting);

  const moved = await transitionStatus(
    db,
    opportunityId,
    ['generating'],
    'awaiting_review',
    'candidates and graphics are ready',
  );
  return result(moved ? 'awaiting_review' : 'generating');
}

/** Opportunities the orchestrator still has work for, most urgent first. */
export async function advanceAll(
  deps: WorkflowDeps,
  limit = 50,
): Promise<{ results: AdvanceResult[]; errors: { opportunityId: string; error: string }[] }> {
  const rows = await deps.db.post_opportunities.findMany({
    where: { status: { in: ['pending', 'researching', 'generating'] } },
    orderBy: [{ priority: 'asc' }, { created_at: 'asc' }],
    take: limit,
    select: { id: true },
  });
  const results: AdvanceResult[] = [];
  const errors: { opportunityId: string; error: string }[] = [];
  for (const r of rows) {
    try {
      results.push(await advanceOpportunity(deps, r.id));
    } catch (err) {
      deps.logger.error({ err, opportunityId: r.id }, 'could not advance opportunity');
      errors.push({ opportunityId: r.id, error: String(err) });
    }
  }
  return { results, errors };
}
