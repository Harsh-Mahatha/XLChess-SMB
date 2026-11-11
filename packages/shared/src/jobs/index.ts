import { z } from 'zod';

/** Where a job runs. `gpu` jobs are claimed only by paired home-PC workers. */
export const JobLane = z.enum(['server', 'gpu']);
export type JobLane = z.infer<typeof JobLane>;

export const JobStatus = z.enum([
  'queued',
  'leased',
  'succeeded',
  'failed',
  'dead',
  'cancelled',
  'expired',
]);
export type JobStatus = z.infer<typeof JobStatus>;

/** Job kinds are added module by module (1.6 story-select, 1.7 candidates, ...). */
export const GPU_JOB_KINDS = [
  'story_select',
  'candidates_generate',
  'revision_from_feedback',
  /** Queued once when a PC is paired: a short text stage and image stage that prove the whole path works. */
  'worker_selftest',
] as const;
export const GpuJobKind = z.enum(GPU_JOB_KINDS);
export type GpuJobKind = z.infer<typeof GpuJobKind>;
