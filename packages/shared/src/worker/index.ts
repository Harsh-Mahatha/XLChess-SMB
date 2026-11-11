import { z } from 'zod';

/**
 * The part of the worker protocol (docs/ARCHITECTURE.md section 6) that the installer and the worker's
 * heartbeat need first. The API implements these endpoints against the same schemas; claim, lease
 * and complete are added with the job runner (module 1.17).
 */

/** What the worker reports about its GPU. Null on a development PC without an NVIDIA GPU. */
export const WorkerGpuInfo = z
  .object({
    name: z.string(),
    totalMiB: z.number().int().nonnegative(),
    usedMiB: z.number().int().nonnegative().optional(),
    driver: z.string().optional(),
  })
  .nullable();
export type WorkerGpuInfo = z.infer<typeof WorkerGpuInfo>;

/** POST /worker/v1/pair: swaps a short-lived, single-use pairing code for a device token. */
export const WorkerPairRequest = z.object({
  pairingCode: z.string().min(4).max(64),
  workerVersion: z.string().min(1),
  hostname: z.string().min(1).max(255),
  os: z.string().max(255),
  gpu: WorkerGpuInfo,
});
export type WorkerPairRequest = z.infer<typeof WorkerPairRequest>;

export const WorkerPairResponse = z.object({
  workerId: z.string().min(1),
  /** Opaque and revocable. The server stores only a hash of it. */
  deviceToken: z.string().min(16),
});
export type WorkerPairResponse = z.infer<typeof WorkerPairResponse>;

/** POST /worker/v1/status: the heartbeat that makes the worker show as online in XLChess. */
export const WorkerStatusRequest = z.object({
  workerVersion: z.string(),
  startedAt: z.string(),
  ollamaUp: z.boolean(),
  models: z.object({ llm: z.string(), image: z.string() }),
  gpu: WorkerGpuInfo,
  /** Free space on the data drive, in MiB. */
  diskFreeMiB: z.number().int().nonnegative().optional(),
});
export type WorkerStatusRequest = z.infer<typeof WorkerStatusRequest>;

/** Desired state returned by the server. Unknown fields are ignored so the API can add to it. */
export const WorkerStatusResponse = z.object({
  paused: z.boolean().optional(),
});
export type WorkerStatusResponse = z.infer<typeof WorkerStatusResponse>;

/** Error codes on POST /worker/v1/pair that the installer turns into advice for the owner. */
export const PAIR_ERROR_CODES = [
  'pairing_code_invalid',
  'pairing_code_expired',
  'pairing_code_used',
] as const;
