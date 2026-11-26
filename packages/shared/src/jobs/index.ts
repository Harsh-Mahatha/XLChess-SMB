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

/** Jobs the in-process runner executes: they need the network, storage and credentials the API host holds. */
export const SERVER_JOB_KINDS = [
  'research_build',
  /** Ranking angles is deterministic code, so it runs on the server (module 1.17 D2). */
  'story_select',
  'images_discover',
  /** One per candidate (scope = candidate id). */
  'graphics_render',
  /** Daily: applies retention and removes the files of expired unused assets. */
  'assets_purge',
] as const;
export const ServerJobKind = z.enum(SERVER_JOB_KINDS);
export type ServerJobKind = z.infer<typeof ServerJobKind>;

/** Jobs only a paired worker with a GPU runs. */
export const GPU_JOB_KINDS = [
  'candidates_generate',
  'revision_from_feedback',
  /** Queued once when a PC is paired: a short text stage and image stage that prove the whole path works. */
  'worker_selftest',
] as const;
export const GpuJobKind = z.enum(GPU_JOB_KINDS);
export type GpuJobKind = z.infer<typeof GpuJobKind>;

export const JOB_LANE_OF: Record<ServerJobKind | GpuJobKind, JobLane> = {
  research_build: 'server',
  story_select: 'server',
  images_discover: 'server',
  graphics_render: 'server',
  assets_purge: 'server',
  candidates_generate: 'gpu',
  revision_from_feedback: 'gpu',
  worker_selftest: 'gpu',
};

/** A job that has stopped for good, or is still working: used by "one active job" rules and the admin list. */
export const ACTIVE_JOB_STATUSES = ['queued', 'leased'] as const;
export const FINISHED_JOB_STATUSES = [
  'succeeded',
  'failed',
  'dead',
  'cancelled',
  'expired',
] as const;
