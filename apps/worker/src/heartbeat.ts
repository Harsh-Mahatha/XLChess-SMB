import { statfsSync } from 'node:fs';
import type { WorkerStatusRequest } from '@smb/shared';
import { ApiError, type WorkerApiClient } from './api-client.js';
import type { GpuMonitor } from './gpu.js';
import { log } from './log.js';
import type { GpuStageRunner } from './stages.js';

export interface HeartbeatSources {
  client: WorkerApiClient;
  version: string;
  startedAt: string;
  runner: GpuStageRunner;
  gpu: GpuMonitor;
  ollamaUp: () => Promise<boolean>;
  dataDir: string;
}

function diskFreeMiB(dir: string): number | undefined {
  try {
    const s = statfsSync(dir);
    return Math.floor((s.bavail * s.bsize) / (1024 * 1024));
  } catch {
    return undefined;
  }
}

export async function buildStatus(src: HeartbeatSources): Promise<WorkerStatusRequest> {
  const g = await src.gpu.sample();
  const free = diskFreeMiB(src.dataDir);
  return {
    workerVersion: src.version,
    startedAt: src.startedAt,
    ollamaUp: await src.ollamaUp().catch(() => false),
    models: { llm: src.runner.state.llm, image: src.runner.state.image },
    gpu: g ? { name: g.name, totalMiB: g.totalMiB, usedMiB: g.usedMiB, driver: g.driver } : null,
    ...(free !== undefined ? { diskFreeMiB: free } : {}),
  };
}

/**
 * Reports to the API every `everyMs`. An unreachable API is normal (internet down, server restarting): the
 * worker logs it once per outage and keeps its local runtimes healthy. A revoked token (401/403) is logged
 * as an error, because only the owner or an admin can fix it (re-pair).
 */
export function startHeartbeat(src: HeartbeatSources, everyMs = 30_000): () => void {
  let failing = false;
  const tick = (): void => {
    void buildStatus(src)
      .then((s) => src.client.status(s))
      .then(() => {
        if (failing) log('info', 'reconnected to the SMB API');
        failing = false;
      })
      .catch((err: unknown) => {
        const revoked = err instanceof ApiError && (err.status === 401 || err.status === 403);
        if (!failing || revoked) {
          log(
            revoked ? 'error' : 'warn',
            revoked
              ? 'the SMB API rejected this worker token; re-pair this PC'
              : 'cannot reach the SMB API; will keep trying',
            {
              error: String(err),
            },
          );
        }
        failing = true;
      });
  };
  tick();
  const timer = setInterval(tick, everyMs);
  return () => clearInterval(timer);
}
