import type { Prisma, PrismaClient, workers } from '@prisma/client';
import {
  GPU_JOB_KINDS,
  GenerationResultWire,
  REVISE,
  RevisionResultWire,
  SelfTestResultWire,
  WORKER_PROTOCOL_VERSION,
  canonicalJson,
  promptVersion,
  promptVersions,
  type ClaimRequest,
  type ClaimedJob,
  type CompleteRequest,
  type CompleteResponse,
  type FailRequest,
  type GenerationInput,
  type GenerationResult,
  type HeartbeatRequest,
  type HeartbeatResponse,
  type RevisionResult,
  type WorkerConfigResponse,
  type WorkerDesiredState,
  type WorkerStatusRequest,
} from '@smb/shared';
import type { Env } from '../env.js';
import { buildInputForOpportunity } from '../generation/payload.js';
import { buildRevisionSubject, saveRevision } from '../generation/revise.js';
import { saveGeneration, storedGeneration } from '../generation/service.js';
import {
  claimJob,
  classifyError,
  completeJob,
  failJob,
  heartbeatJob,
  type JobRow,
} from '../jobs/index.js';
import { advanceOpportunity } from '../workflow/advance.js';
import { backoffFor } from '../workflow/retry.js';
import type { WorkflowDeps } from '../workflow/types.js';

export class WorkerProtocolError extends Error {
  constructor(
    readonly status: 403 | 404 | 409 | 422,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'WorkerProtocolError';
  }
}

export type WorkerProtocolEnv = Pick<
  Env,
  | 'SMB_WORKER_POLL_SECONDS'
  | 'SMB_WORKER_LEASE_SECONDS'
  | 'SMB_WORKER_TARGET_VERSION'
  | 'SMB_WORKER_LLM_MODEL'
  | 'SMB_WORKER_IMAGE_MODEL'
>;

export interface WorkerProtocolDeps {
  db: PrismaClient;
  workflow: WorkflowDeps;
  env: WorkerProtocolEnv;
  now?: () => Date;
}

export function desiredStateOf(worker: workers, env: WorkerProtocolEnv): WorkerDesiredState {
  return {
    paused: worker.paused,
    concurrency: 1,
    pollSeconds: env.SMB_WORKER_POLL_SECONDS,
    heartbeatSeconds: 60,
    leaseSeconds: env.SMB_WORKER_LEASE_SECONDS,
    updateRequired: worker.update_required,
    targetWorkerVersion: env.SMB_WORKER_TARGET_VERSION ?? null,
  };
}

export async function recordWorkerStatus(
  db: PrismaClient,
  env: WorkerProtocolEnv,
  worker: workers,
  body: WorkerStatusRequest,
  now: Date = new Date(),
): Promise<WorkerDesiredState> {
  const updated = await db.workers.update({
    where: { id: worker.id },
    data: {
      status: body as unknown as Prisma.InputJsonValue,
      worker_version: body.workerVersion,
      last_seen_at: now,
    },
  });
  return desiredStateOf(updated, env);
}

export function getWorkerConfig(env: WorkerProtocolEnv, worker: workers): WorkerConfigResponse {
  return {
    ...desiredStateOf(worker, env),
    promptVersions: promptVersions(),
    models: {
      llm: env.SMB_WORKER_LLM_MODEL,
      image: env.SMB_WORKER_IMAGE_MODEL,
    },
  };
}

async function prepareJob(
  deps: WorkerProtocolDeps,
  job: JobRow,
): Promise<{ alreadyStored: true } | { alreadyStored: false; claimed: ClaimedJob }> {
  const payload = ((job.payload as Record<string, unknown> | null) ?? {}) as Record<
    string,
    unknown
  >;

  if (job.kind === 'candidates_generate') {
    const opportunityId = payload.opportunityId;
    if (typeof opportunityId !== 'string' || !opportunityId) {
      throw new Error('candidates_generate job missing opportunityId');
    }
    const newCycle = payload.newCycle === true;
    const { input, selectionId } = await buildInputForOpportunity(
      deps.db,
      deps.workflow.channels,
      opportunityId,
      { withFeedback: newCycle },
    );
    const feedbackActionId =
      input.reviewerFeedback?.actionId ??
      (payload.feedback as { actionId?: string } | undefined)?.actionId;
    const already = await storedGeneration(deps.db, {
      selectionId,
      newCycle,
      feedbackActionId,
    });
    if (already) return { alreadyStored: true };

    await deps.db.jobs.update({
      where: { id: job.id },
      data: {
        payload: {
          ...payload,
          prepared: { input, selectionId },
        } as unknown as Prisma.InputJsonValue,
      },
    });
    return {
      alreadyStored: false,
      claimed: {
        kind: 'candidates_generate',
        jobId: job.id,
        leaseId: job.lease_id!,
        leaseExpiresAt: job.lease_expires_at!.toISOString(),
        attempt: job.attempts,
        input,
      },
    };
  }

  if (job.kind === 'revision_from_feedback') {
    const actionId = payload.actionId;
    if (typeof actionId !== 'string' || !actionId) {
      throw new Error('revision_from_feedback job missing actionId');
    }
    const already = await deps.db.post_revisions.findFirst({
      where: { review_action_id: actionId },
    });
    if (already) return { alreadyStored: true };

    const { input, request } = await buildRevisionSubject(
      deps.db,
      deps.workflow.channels,
      actionId,
    );
    await deps.db.jobs.update({
      where: { id: job.id },
      data: {
        payload: {
          ...payload,
          prepared: { input, request },
        } as unknown as Prisma.InputJsonValue,
      },
    });
    return {
      alreadyStored: false,
      claimed: {
        kind: 'revision_from_feedback',
        jobId: job.id,
        leaseId: job.lease_id!,
        leaseExpiresAt: job.lease_expires_at!.toISOString(),
        attempt: job.attempts,
        input,
        request,
      },
    };
  }

  if (job.kind === 'worker_selftest') {
    return {
      alreadyStored: false,
      claimed: {
        kind: 'worker_selftest',
        jobId: job.id,
        leaseId: job.lease_id!,
        leaseExpiresAt: job.lease_expires_at!.toISOString(),
        attempt: job.attempts,
      },
    };
  }

  throw new Error(`unsupported gpu job kind: ${job.kind}`);
}

/**
 * Claims at most one GPU job for `worker`, preparing inputs at claim time. Returns `null` when paused
 * or when no runnable job is available (HTTP 204).
 */
export async function claimWorkerJob(
  deps: WorkerProtocolDeps,
  worker: workers,
  body: ClaimRequest,
  now?: Date,
): Promise<ClaimedJob | null> {
  if (worker.paused) return null;

  const expectedPrompts = promptVersions();
  if (
    body.protocolVersion !== WORKER_PROTOCOL_VERSION ||
    canonicalJson(body.promptVersions) !== canonicalJson(expectedPrompts)
  ) {
    await deps.db.workers.update({
      where: { id: worker.id },
      data: { update_required: true },
    });
    throw new WorkerProtocolError(
      409,
      'worker_outdated',
      'Worker protocol or prompt versions do not match the server',
      {
        expected: expectedPrompts,
        expectedProtocolVersion: WORKER_PROTOCOL_VERSION,
      },
    );
  }

  if (worker.update_required || worker.worker_version !== body.workerVersion) {
    await deps.db.workers.update({
      where: { id: worker.id },
      data: { update_required: false, worker_version: body.workerVersion },
    });
  }

  const at = now ?? deps.now?.() ?? new Date();
  for (let i = 0; i < 3; i++) {
    const job = await claimJob(deps.db, {
      lane: 'gpu',
      kinds: GPU_JOB_KINDS,
      workerId: worker.id,
      forWorker: worker.id,
      leaseSeconds: deps.env.SMB_WORKER_LEASE_SECONDS,
      now: at,
    });
    if (!job) return null;

    try {
      const prep = await prepareJob(deps, job);
      if (prep.alreadyStored) {
        await completeJob(deps.db, job.id, job.lease_id!, { alreadyStored: true }, at);
        if (job.opportunity_id) {
          await advanceOpportunity(deps.workflow, job.opportunity_id);
        }
        continue;
      }
      return prep.claimed;
    } catch (err) {
      const c = classifyError(err);
      await failJob(deps.db, job.id, job.lease_id!, {
        ...c,
        retryInSeconds: await backoffFor(deps.db, job, job.attempts),
        now: at,
      });
      if (job.opportunity_id) {
        await advanceOpportunity(deps.workflow, job.opportunity_id);
      }
    }
  }
  return null;
}

export async function heartbeatWorkerJob(
  deps: Pick<WorkerProtocolDeps, 'db' | 'env' | 'now'>,
  workerId: string,
  jobId: string,
  body: HeartbeatRequest,
  now?: Date,
): Promise<HeartbeatResponse> {
  const job = await deps.db.jobs.findUnique({ where: { id: jobId } });
  if (!job) throw new WorkerProtocolError(404, 'not_found', 'Job not found');
  if (job.status === 'leased' && job.leased_by !== workerId) {
    throw new WorkerProtocolError(403, 'not_your_job', 'This job is leased to another worker');
  }

  const at = now ?? deps.now?.() ?? new Date();
  const ok = await heartbeatJob(deps.db, jobId, body.leaseId, {
    leaseSeconds: deps.env.SMB_WORKER_LEASE_SECONDS,
    progress: body.progress,
    now: at,
  });
  if (!ok) return { cancel: true };

  const leaseExpiresAt = new Date(
    at.getTime() + deps.env.SMB_WORKER_LEASE_SECONDS * 1000,
  ).toISOString();
  return { cancel: false, leaseExpiresAt };
}

function assertOwnershipAndLease(job: JobRow | null, workerId: string, leaseId: string): JobRow {
  if (!job) throw new WorkerProtocolError(404, 'not_found', 'Job not found');
  if (job.status === 'leased' && job.leased_by !== workerId) {
    throw new WorkerProtocolError(403, 'not_your_job', 'This job is leased to another worker');
  }
  if (job.status !== 'leased' || job.lease_id !== leaseId) {
    throw new WorkerProtocolError(409, 'lease_lost', 'The job lease is no longer active');
  }
  return job;
}

export async function completeWorkerJob(
  deps: WorkerProtocolDeps,
  workerId: string,
  jobId: string,
  body: CompleteRequest,
  now?: Date,
): Promise<CompleteResponse> {
  const at = now ?? deps.now?.() ?? new Date();
  const existing = await deps.db.jobs.findUnique({ where: { id: jobId } });
  if (!existing) throw new WorkerProtocolError(404, 'not_found', 'Job not found');
  if (existing.status === 'succeeded') {
    return { outcome: 'already_completed' };
  }
  const job = assertOwnershipAndLease(existing, workerId, body.leaseId);
  const payload = (job.payload as Record<string, unknown> | null) ?? {};

  let summary: unknown;
  if (job.kind === 'candidates_generate') {
    const parsed = GenerationResultWire.safeParse(body.result);
    if (!parsed.success) {
      await failJob(deps.db, job.id, body.leaseId, {
        code: 'bad_result',
        message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        retryable: false,
        now: at,
      });
      if (job.opportunity_id) await advanceOpportunity(deps.workflow, job.opportunity_id);
      throw new WorkerProtocolError(
        422,
        'bad_result',
        'Invalid generation result',
        parsed.error.issues,
      );
    }
    const expected = promptVersions();
    if (canonicalJson(parsed.data.promptVersions) !== canonicalJson(expected)) {
      await failJob(deps.db, job.id, body.leaseId, {
        code: 'worker_outdated',
        message: 'Generation result promptVersions do not match the server',
        retryable: true,
        retryInSeconds: await backoffFor(deps.db, job, job.attempts),
        now: at,
      });
      if (job.opportunity_id) await advanceOpportunity(deps.workflow, job.opportunity_id);
      throw new WorkerProtocolError(409, 'worker_outdated', 'Prompt versions do not match server', {
        expected,
      });
    }
    try {
      const prepared = payload.prepared as
        { input: GenerationInput; selectionId: string } | undefined;
      if (!prepared) {
        throw new Error('job is missing prepared generation input');
      }
      const saved = await saveGeneration(
        deps.db,
        prepared.input,
        prepared.selectionId,
        parsed.data as unknown as GenerationResult,
        { jobId: job.id, newCycle: payload.newCycle === true },
      );
      summary = {
        cycle: saved.cycle,
        created: saved.created,
        candidates: saved.candidates.length,
      };
    } catch (err) {
      const c = classifyError(err);
      await failJob(deps.db, job.id, body.leaseId, {
        ...c,
        retryInSeconds: await backoffFor(deps.db, job, job.attempts),
        now: at,
      });
      if (job.opportunity_id) await advanceOpportunity(deps.workflow, job.opportunity_id);
      return { outcome: 'rejected', code: c.code };
    }
  } else if (job.kind === 'revision_from_feedback') {
    const parsed = RevisionResultWire.safeParse(body.result);
    if (!parsed.success) {
      await failJob(deps.db, job.id, body.leaseId, {
        code: 'bad_result',
        message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        retryable: false,
        now: at,
      });
      if (job.opportunity_id) await advanceOpportunity(deps.workflow, job.opportunity_id);
      throw new WorkerProtocolError(
        422,
        'bad_result',
        'Invalid revision result',
        parsed.error.issues,
      );
    }
    const expectedPrompt = promptVersion(REVISE);
    if (parsed.data.promptVersion !== expectedPrompt) {
      await failJob(deps.db, job.id, body.leaseId, {
        code: 'worker_outdated',
        message: 'Revision result promptVersion does not match the server',
        retryable: true,
        retryInSeconds: await backoffFor(deps.db, job, job.attempts),
        now: at,
      });
      if (job.opportunity_id) await advanceOpportunity(deps.workflow, job.opportunity_id);
      throw new WorkerProtocolError(
        409,
        'worker_outdated',
        'Prompt version does not match server',
        {
          expected: expectedPrompt,
        },
      );
    }
    try {
      const prepared = payload.prepared as { input: GenerationInput } | undefined;
      const actionId = payload.actionId as string | undefined;
      if (!prepared || !actionId) {
        throw new Error('job is missing prepared revision input');
      }
      const saved = await saveRevision(
        deps.db,
        prepared.input,
        actionId,
        parsed.data as unknown as RevisionResult,
        { jobId: job.id },
      );
      summary = {
        revisionId: saved.revisionId,
        created: saved.created,
        passed: saved.passed,
      };
    } catch (err) {
      const c = classifyError(err);
      await failJob(deps.db, job.id, body.leaseId, {
        ...c,
        retryInSeconds: await backoffFor(deps.db, job, job.attempts),
        now: at,
      });
      if (job.opportunity_id) await advanceOpportunity(deps.workflow, job.opportunity_id);
      return { outcome: 'rejected', code: c.code };
    }
  } else if (job.kind === 'worker_selftest') {
    const parsed = SelfTestResultWire.safeParse(body.result);
    if (!parsed.success) {
      await failJob(deps.db, job.id, body.leaseId, {
        code: 'bad_result',
        message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        retryable: false,
        now: at,
      });
      throw new WorkerProtocolError(
        422,
        'bad_result',
        'Invalid self-test result',
        parsed.error.issues,
      );
    }
    summary = parsed.data;
  } else {
    throw new WorkerProtocolError(422, 'bad_result', `Unsupported job kind ${job.kind}`);
  }

  const done = await completeJob(deps.db, job.id, body.leaseId, summary, at);
  if (done.outcome === 'lease_lost') {
    throw new WorkerProtocolError(409, 'lease_lost', 'The job lease is no longer active');
  }
  if (job.opportunity_id) {
    await advanceOpportunity(deps.workflow, job.opportunity_id);
  }
  return { outcome: done.outcome };
}

export async function failWorkerJob(
  deps: WorkerProtocolDeps,
  workerId: string,
  jobId: string,
  body: FailRequest,
  now?: Date,
): Promise<{ outcome: string }> {
  const at = now ?? deps.now?.() ?? new Date();
  const existing = await deps.db.jobs.findUnique({ where: { id: jobId } });
  const job = assertOwnershipAndLease(existing, workerId, body.leaseId);

  const code = body.code.startsWith('worker_') ? body.code : `worker_${body.code}`;
  const message = body.message.slice(0, 2000);
  const retryInSeconds = await backoffFor(deps.db, job, job.attempts);
  const out = await failJob(deps.db, job.id, body.leaseId, {
    code,
    message,
    retryable: body.retryable,
    retryInSeconds,
    now: at,
  });
  if (out.outcome === 'lease_lost') {
    throw new WorkerProtocolError(409, 'lease_lost', 'The job lease is no longer active');
  }
  if (job.opportunity_id) {
    await advanceOpportunity(deps.workflow, job.opportunity_id);
  }
  return { outcome: out.outcome };
}
