import { z } from 'zod';
import { GENERATION_SCHEMA_VERSION } from '../generation/schemas.js';

/**
 * Shared worker protocol contracts (docs/ARCHITECTURE.md section 6, module 1.18).
 */

export const WORKER_PROTOCOL_VERSION = 1;

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

export const WorkerDesiredState = z.object({
  paused: z.boolean(),
  concurrency: z.literal(1),
  pollSeconds: z.number().int().positive(),
  heartbeatSeconds: z.number().int().positive(),
  leaseSeconds: z.number().int().positive(),
  updateRequired: z.boolean(),
  targetWorkerVersion: z.string().nullable(),
});
export type WorkerDesiredState = z.infer<typeof WorkerDesiredState>;

/** Desired state returned by the server. Unknown fields are ignored so the API can add to it. */
export const WorkerStatusResponse = WorkerDesiredState.partial();
export type WorkerStatusResponse = z.infer<typeof WorkerStatusResponse>;

export const WorkerConfigResponse = WorkerDesiredState.extend({
  promptVersions: z.record(z.string()),
  models: z.object({ llm: z.string(), image: z.string() }),
});
export type WorkerConfigResponse = z.infer<typeof WorkerConfigResponse>;

export const ClaimRequest = z.object({
  protocolVersion: z.number().int(),
  workerVersion: z.string().min(1),
  promptVersions: z.record(z.string()),
});
export type ClaimRequest = z.infer<typeof ClaimRequest>;

export const ClaimedJob = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('candidates_generate'),
    jobId: z.string().uuid(),
    leaseId: z.string().uuid(),
    leaseExpiresAt: z.string(),
    attempt: z.number().int(),
    input: z.unknown(),
  }),
  z.object({
    kind: z.literal('revision_from_feedback'),
    jobId: z.string().uuid(),
    leaseId: z.string().uuid(),
    leaseExpiresAt: z.string(),
    attempt: z.number().int(),
    input: z.unknown(),
    request: z.unknown(),
  }),
  z.object({
    kind: z.literal('worker_selftest'),
    jobId: z.string().uuid(),
    leaseId: z.string().uuid(),
    leaseExpiresAt: z.string(),
    attempt: z.number().int(),
  }),
]);
export type ClaimedJob = z.infer<typeof ClaimedJob>;

export const HeartbeatRequest = z.object({
  leaseId: z.string().uuid(),
  progress: z.unknown().optional(),
});
export type HeartbeatRequest = z.infer<typeof HeartbeatRequest>;

export const HeartbeatResponse = z.object({
  cancel: z.boolean(),
  leaseExpiresAt: z.string().optional(),
});
export type HeartbeatResponse = z.infer<typeof HeartbeatResponse>;

export const CompleteRequest = z.object({
  leaseId: z.string().uuid(),
  result: z.unknown(),
  durationMs: z.number().int().nonnegative(),
});
export type CompleteRequest = z.infer<typeof CompleteRequest>;

export const CompleteResponse = z.object({
  outcome: z.enum(['completed', 'already_completed', 'rejected']),
  code: z.string().optional(),
});
export type CompleteResponse = z.infer<typeof CompleteResponse>;

export const FailRequest = z.object({
  leaseId: z.string().uuid(),
  code: z.string().min(1).max(80),
  message: z.string().max(4000),
  retryable: z.boolean(),
});
export type FailRequest = z.infer<typeof FailRequest>;

/** Envelope checks only: the server re-checks the content with recheckGeneration / recheckRevision. */
export const GenerationResultWire = z
  .object({
    schemaVersion: z.literal(GENERATION_SCHEMA_VERSION),
    angleId: z.string().min(1),
    provider: z.string().min(1),
    model: z.string().min(1),
    promptVersions: z.record(z.string()),
    settings: z.record(z.unknown()),
    interpretation: z.unknown(),
    candidates: z.array(z.object({ slot: z.enum(['A', 'B', 'C']) }).passthrough()).length(3),
    durationMs: z.number().nonnegative(),
  })
  .passthrough();
export type GenerationResultWire = z.infer<typeof GenerationResultWire>;

export const RevisionResultWire = z
  .object({
    schemaVersion: z.literal(GENERATION_SCHEMA_VERSION),
    slot: z.enum(['A', 'B', 'C']),
    provider: z.string().min(1),
    model: z.string().min(1),
    promptVersion: z.string().min(1),
    draft: z.unknown(),
    validation: z.object({ passed: z.boolean(), issues: z.array(z.unknown()) }).passthrough(),
    attempts: z.number().int().positive(),
    durationMs: z.number().nonnegative(),
  })
  .passthrough();
export type RevisionResultWire = z.infer<typeof RevisionResultWire>;

export const SelfTestResultWire = z
  .object({
    ok: z.boolean(),
    steps: z.array(z.unknown()),
    durationMs: z.number().nonnegative(),
  })
  .passthrough();
export type SelfTestResultWire = z.infer<typeof SelfTestResultWire>;

/** Error codes on POST /worker/v1/pair that the installer turns into advice for the owner. */
export const PAIR_ERROR_CODES = [
  'pairing_code_invalid',
  'pairing_code_expired',
  'pairing_code_used',
] as const;

export const WORKER_ERROR_CODES = [
  'worker_outdated',
  'worker_revoked',
  'invalid_worker_token',
  'rate_limited',
  'https_required',
  'lease_lost',
  'not_your_job',
] as const;
