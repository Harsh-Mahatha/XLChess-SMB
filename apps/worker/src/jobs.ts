import {
  AiError,
  WORKER_PROTOCOL_VERSION,
  promptVersions,
  type ClaimedJob,
  type WorkerStatusResponse,
} from '@smb/shared';
import { ApiError, type WorkerApiClient } from './api-client.js';
import { clearCheckpoint, readCheckpoint, writeCheckpoint } from './checkpoint.js';
import { executeJob, type ExecuteDeps } from './execute.js';
import { log } from './log.js';
import { VramNotReleasedError } from './stages.js';

export interface WorkerRuntimeState {
  paused: boolean;
  updateRequired: boolean;
  pollSeconds: number;
  heartbeatSeconds: number;
}

export function createWorkerRuntimeState(): WorkerRuntimeState {
  return {
    paused: false,
    updateRequired: false,
    pollSeconds: 10,
    heartbeatSeconds: 60,
  };
}

export function applyDesiredState(state: WorkerRuntimeState, reply: WorkerStatusResponse): void {
  if (reply.paused !== undefined) state.paused = reply.paused;
  if (reply.updateRequired !== undefined) state.updateRequired = reply.updateRequired;
  if (reply.pollSeconds !== undefined) state.pollSeconds = reply.pollSeconds;
  if (reply.heartbeatSeconds !== undefined) state.heartbeatSeconds = reply.heartbeatSeconds;
}

/**
 * Startup recovery: if a checkpoint remained from an interrupted run, tell the API the worker restarted
 * and clear the checkpoint. Ignores `lease_lost` and `404` (the reaper may have already moved it).
 */
export async function recoverCheckpoint(
  client: Pick<WorkerApiClient, 'fail'>,
  checkpointsDir: string,
): Promise<void> {
  const cp = readCheckpoint(checkpointsDir);
  if (!cp) return;
  try {
    await client.fail(cp.jobId, {
      leaseId: cp.leaseId,
      code: 'worker_restarted',
      message: 'the worker restarted during the job',
      retryable: true,
    });
    log('info', 'recovered interrupted job from checkpoint', { jobId: cp.jobId, kind: cp.kind });
  } catch (err) {
    if (err instanceof ApiError && (err.code === 'lease_lost' || err.status === 404)) {
      log('info', 'checkpoint job lease already gone', { jobId: cp.jobId, code: err.code });
    } else {
      log('warn', 'failed to report interrupted checkpoint job; clearing locally', {
        jobId: cp.jobId,
        error: String(err),
      });
    }
  } finally {
    clearCheckpoint(checkpointsDir);
  }
}

export interface JobLoopDeps extends ExecuteDeps {
  client: Pick<WorkerApiClient, 'claim' | 'heartbeat' | 'complete' | 'fail'>;
  workerVersion: string;
  checkpointsDir: string;
  state: WorkerRuntimeState;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  retryBaseMs?: number;
  maxRetryMs?: number;
  maxEmptyBackoffMs?: number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function classifyWorkerError(err: unknown): { code: string; message: string; retryable: boolean } {
  if (err instanceof AiError) {
    return { code: err.code, message: err.message, retryable: err.retryable };
  }
  if (err instanceof VramNotReleasedError) {
    return { code: 'vram_not_released', message: err.message, retryable: true };
  }
  return {
    code: 'worker_error',
    message: err instanceof Error ? err.message : String(err),
    retryable: true,
  };
}

async function submitCompletion(
  deps: JobLoopDeps,
  job: ClaimedJob,
  result: unknown,
  durationMs: number,
  isStopped: () => boolean,
): Promise<void> {
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const baseMs = deps.retryBaseMs ?? 2000;
  const maxMs = deps.maxRetryMs ?? 60_000;
  const parsedExpiry = Date.parse(job.leaseExpiresAt);
  const deadline = Number.isFinite(parsedExpiry) ? parsedExpiry : now() + 600_000;

  let delayMs = baseMs;
  for (;;) {
    try {
      const reply = await deps.client.complete(job.jobId, {
        leaseId: job.leaseId,
        result,
        durationMs: Math.max(0, Math.round(durationMs)),
      });
      if (reply.outcome === 'rejected') {
        log('warn', 'server rejected job result', { jobId: job.jobId, code: reply.code });
      }
      clearCheckpoint(deps.checkpointsDir);
      return;
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'lease_lost') {
          log('warn', 'lease lost before completion was recorded', { jobId: job.jobId });
          clearCheckpoint(deps.checkpointsDir);
          return;
        }
        const transient = err.status === 0 || err.status >= 500;
        if (transient && !isStopped() && now() < deadline) {
          await sleep(Math.min(delayMs, maxMs));
          delayMs = Math.min(maxMs, delayMs * 2);
          continue;
        }
        log('error', 'could not complete job', {
          jobId: job.jobId,
          status: err.status,
          code: err.code,
          error: err.message,
        });
        clearCheckpoint(deps.checkpointsDir);
        return;
      }
      throw err;
    }
  }
}

/**
 * Polls the SMB API for GPU jobs, runs one job at a time with heartbeats and a local checkpoint, and
 * returns a stop handle.
 */
export function startJobLoop(deps: JobLoopDeps): {
  stop: () => Promise<void>;
  done: Promise<void>;
} {
  const sleep = deps.sleep ?? defaultSleep;
  const maxEmptyBackoffMs = deps.maxEmptyBackoffMs ?? 60_000;
  let stopped = false;

  const loop = async (): Promise<void> => {
    let emptyDelayMs = deps.state.pollSeconds * 1000;

    while (!stopped) {
      if (deps.state.paused || deps.state.updateRequired) {
        await sleep(deps.state.pollSeconds * 1000);
        continue;
      }

      let job: ClaimedJob | null;
      try {
        job = await deps.client.claim({
          protocolVersion: WORKER_PROTOCOL_VERSION,
          workerVersion: deps.workerVersion,
          promptVersions: promptVersions(),
        });
      } catch (err) {
        if (err instanceof ApiError) {
          if (err.status === 409 && err.code === 'worker_outdated') {
            log('error', 'worker is outdated and must be updated before claiming jobs', {
              error: err.message,
            });
            deps.state.updateRequired = true;
            await sleep(deps.state.pollSeconds * 1000);
            continue;
          }
          if (err.status === 401) {
            log('error', 're-pair this PC', { code: err.code });
            return;
          }
          log('warn', 'claim request failed; will retry', {
            status: err.status,
            code: err.code,
            error: err.message,
          });
          await sleep(deps.state.pollSeconds * 1000);
          continue;
        }
        log('warn', 'unexpected error claiming job; will retry', { error: String(err) });
        await sleep(deps.state.pollSeconds * 1000);
        continue;
      }

      if (!job) {
        await sleep(emptyDelayMs);
        emptyDelayMs = Math.min(maxEmptyBackoffMs, emptyDelayMs * 2);
        continue;
      }

      emptyDelayMs = deps.state.pollSeconds * 1000;
      writeCheckpoint(deps.checkpointsDir, {
        jobId: job.jobId,
        leaseId: job.leaseId,
        kind: job.kind,
        startedAt: new Date().toISOString(),
      });

      let cancelled = false;
      const hbMs = Math.max(100, deps.state.heartbeatSeconds * 1000);
      const hbTimer = setInterval(() => {
        void deps.client
          .heartbeat(job.jobId, { leaseId: job.leaseId })
          .then((res) => {
            if (res.cancel) cancelled = true;
          })
          .catch((err) => {
            log('warn', 'job heartbeat failed', { jobId: job.jobId, error: String(err) });
          });
      }, hbMs);
      hbTimer.unref?.();

      let executed: { value: unknown; durationMs: number } | undefined;
      let runErr: unknown = undefined;
      let hasRunErr = false;
      try {
        executed = await executeJob(deps, job);
      } catch (err) {
        runErr = err;
        hasRunErr = true;
      } finally {
        clearInterval(hbTimer);
      }

      if (cancelled) {
        log('info', 'job cancelled by server; discarding result', { jobId: job.jobId });
        clearCheckpoint(deps.checkpointsDir);
        continue;
      }

      if (hasRunErr) {
        const mapped = classifyWorkerError(runErr);
        log('warn', 'job execution failed', {
          jobId: job.jobId,
          kind: job.kind,
          code: mapped.code,
          retryable: mapped.retryable,
          error: mapped.message,
        });
        try {
          await deps.client.fail(job.jobId, {
            leaseId: job.leaseId,
            code: mapped.code,
            message: mapped.message,
            retryable: mapped.retryable,
          });
        } catch (err) {
          log('warn', 'failed to report job failure', { jobId: job.jobId, error: String(err) });
        }
        clearCheckpoint(deps.checkpointsDir);
        continue;
      }

      await submitCompletion(deps, job, executed!.value, executed!.durationMs, () => stopped);
    }
  };

  const done = loop();
  return {
    done,
    stop: async () => {
      stopped = true;
      await done.catch(() => undefined);
    },
  };
}
