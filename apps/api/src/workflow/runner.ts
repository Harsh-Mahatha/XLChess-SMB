import { PostTypeConfig, type JobLane } from '@smb/shared';
import {
  backoffSeconds,
  claimJob,
  classifyError,
  completeJob,
  failJob,
  heartbeatJob,
  type JobRow,
} from '../jobs/index.js';
import { advanceOpportunity } from './advance.js';
import { executeJob } from './handlers.js';
import { nowOf, type WorkflowDeps } from './types.js';

const DEFAULT_LEASE = { server: 120, gpu: 600 };
/** Kinds the in-process gpu runner may take. `worker_selftest` needs a real paired PC. */
export const IN_PROCESS_GPU_KINDS = ['candidates_generate', 'revision_from_feedback'] as const;

export interface RunOutcome {
  jobId: string;
  kind: string;
  outcome: 'completed' | 'requeued' | 'dead' | 'failed' | 'lease_lost' | 'already_completed';
  error?: string;
}

async function backoffFor(deps: WorkflowDeps, job: JobRow, attempts: number): Promise<number> {
  if (job.opportunity_id) {
    const opp = await deps.db.post_opportunities.findUnique({ where: { id: job.opportunity_id } });
    const row =
      opp && (await deps.db.post_configs.findUnique({ where: { id: opp.post_config_id } }));
    if (row) {
      return backoffSeconds(attempts, PostTypeConfig.parse(row.config_json).retryPolicy);
    }
  }
  return backoffSeconds(attempts, { backoffSeconds: 60, backoffMultiplier: 2 });
}

/** Runs one claimed job to its end: heartbeat while it works, then record success, a retry or a stop. */
export async function processJob(deps: WorkflowDeps, job: JobRow): Promise<RunOutcome> {
  const lane = job.lane as JobLane;
  const leaseSeconds = deps.leaseSeconds?.[lane] ?? DEFAULT_LEASE[lane];
  const leaseId = job.lease_id!;
  let lost = false;
  const beat = setInterval(
    () => {
      heartbeatJob(deps.db, job.id, leaseId, { leaseSeconds, now: nowOf(deps) })
        .then((ok) => {
          if (!ok) lost = true;
        })
        .catch((err) => deps.logger.warn({ err, jobId: job.id }, 'heartbeat failed'));
    },
    Math.max(1000, (leaseSeconds * 1000) / 3),
  );
  beat.unref();

  let outcome: RunOutcome;
  try {
    const result = await executeJob(deps, job);
    const done = await completeJob(deps.db, job.id, leaseId, result, nowOf(deps));
    outcome = { jobId: job.id, kind: job.kind, outcome: done.outcome };
  } catch (err) {
    const c = classifyError(err);
    deps.logger.warn(
      {
        jobId: job.id,
        kind: job.kind,
        attempt: job.attempts,
        code: c.code,
        retryable: c.retryable,
        err,
      },
      'job failed',
    );
    const failed = await failJob(deps.db, job.id, leaseId, {
      ...c,
      retryInSeconds: await backoffFor(deps, job, job.attempts),
      now: nowOf(deps),
    });
    outcome = {
      jobId: job.id,
      kind: job.kind,
      outcome: failed.outcome,
      error: `${c.code}: ${c.message}`,
    };
  } finally {
    clearInterval(beat);
  }
  if (lost && outcome.outcome === 'completed') {
    deps.logger.warn(
      { jobId: job.id },
      'the lease was lost while the job ran; its result was still accepted',
    );
  }
  if (job.opportunity_id) {
    await advanceOpportunity(deps, job.opportunity_id).catch((err) =>
      deps.logger.error({ err, opportunityId: job.opportunity_id }, 'could not advance after job'),
    );
  }
  return outcome;
}

export interface RunOptions {
  lane: JobLane;
  kinds?: readonly string[];
  /** Jobs run at once. */
  concurrency?: number;
  /** Stop claiming after this many jobs in one call. */
  budget?: number;
}

/** Claims and runs jobs until the queue has nothing runnable or the budget is used. */
export async function runJobs(deps: WorkflowDeps, o: RunOptions): Promise<RunOutcome[]> {
  const outcomes: RunOutcome[] = [];
  let left = o.budget ?? 20;
  const leaseSeconds = deps.leaseSeconds?.[o.lane] ?? DEFAULT_LEASE[o.lane];
  const worker = async (): Promise<void> => {
    while (left > 0) {
      left -= 1;
      const job = await claimJob(deps.db, {
        lane: o.lane,
        kinds: o.kinds,
        leaseSeconds,
        now: nowOf(deps),
      });
      if (!job) return;
      outcomes.push(await processJob(deps, job));
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, o.concurrency ?? 1) }, worker));
  return outcomes;
}

/** The server lane, and the gpu lane too when an AI provider runs inside the API (the stub in dev and tests). */
export async function runAvailableJobs(
  deps: WorkflowDeps,
  o: { concurrency?: number; budget?: number } = {},
): Promise<RunOutcome[]> {
  const server = await runJobs(deps, { lane: 'server', ...o });
  const gpu = deps.provider
    ? await runJobs(deps, { lane: 'gpu', kinds: IN_PROCESS_GPU_KINDS, ...o })
    : [];
  return [...server, ...gpu];
}
