import { hostname, release, type } from 'node:os';
import { ApiError, WorkerApiClient } from './api-client.js';
import type { GpuMonitor } from './gpu.js';

export interface PairingResult {
  ok: boolean;
  workerId?: string;
  /** Only present on success; the installer encrypts it immediately and it is never logged. */
  deviceToken?: string;
  /** Machine-readable reason on failure, so the installer can give the owner the right advice. */
  error?: string;
  message?: string;
}

/**
 * Exchanges the pairing code for a device token (docs/installer-v1-plan.md step 12). Never throws for
 * "server said no" cases: the result says what to tell the owner.
 */
export async function pairWithServer(opts: {
  apiUrl: string;
  pairingCode: string;
  version: string;
  gpu: GpuMonitor;
  fetchImpl?: typeof fetch;
}): Promise<PairingResult> {
  const sample = await opts.gpu.sample();
  const client = new WorkerApiClient({ baseUrl: opts.apiUrl, fetchImpl: opts.fetchImpl });
  try {
    const r = await client.pair({
      pairingCode: opts.pairingCode.trim(),
      workerVersion: opts.version,
      hostname: hostname(),
      os: `${type()} ${release()}`,
      gpu: sample
        ? {
            name: sample.name,
            totalMiB: sample.totalMiB,
            usedMiB: sample.usedMiB,
            driver: sample.driver,
          }
        : null,
    });
    return { ok: true, workerId: r.workerId, deviceToken: r.deviceToken };
  } catch (err) {
    if (err instanceof ApiError) return { ok: false, error: err.code, message: err.message };
    return { ok: false, error: 'unexpected', message: String(err) };
  }
}
