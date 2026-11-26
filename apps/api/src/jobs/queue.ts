import { Prisma, type PrismaClient, type jobs } from '@prisma/client';
import { JOB_LANE_OF, type GpuJobKind, type JobLane, type ServerJobKind } from '@smb/shared';

/** The durable queue (docs/ARCHITECTURE.md section 6). All state is in `smb.jobs`; nothing is held in memory. */
export type JobRow = jobs;
type Db = PrismaClient | Prisma.TransactionClient;

export interface EnqueueInput {
  kind: ServerJobKind | GpuJobKind;
  opportunityId?: string;
  /** Tells apart jobs of one kind for one opportunity (one render per candidate). */
  scope?: string;
  payload?: Record<string, unknown>;
  /** The same key never queues twice, even after the first job finished. */
  idempotencyKey?: string;
  priority?: number;
  maxAttempts?: number;
  runAfter?: Date;
  /** Work still waiting after this time expires instead of running. */
  notAfter?: Date | null;
}

export interface Enqueued {
  job: JobRow;
  /** False when an earlier job with the same key, or an active one for the same step, was returned. */
  created: boolean;
}

/**
 * Queues a job unless the same key was used before or the same step is already waiting or running. Safe to call
 * twice (a crashed orchestrator tick is simply run again).
 */
export async function enqueueJob(db: Db, input: EnqueueInput): Promise<Enqueued> {
  const lane = JOB_LANE_OF[input.kind];
  const scope = input.scope ?? '';
  const rows = await db.$queryRaw<jobs[]>`
    insert into smb.jobs (lane, kind, priority, payload, opportunity_id, job_scope, idempotency_key,
                          max_attempts, run_after, not_after)
    values (${lane}::smb.job_lane, ${input.kind}, ${input.priority ?? 100},
            ${JSON.stringify(input.payload ?? {})}::jsonb, ${input.opportunityId ?? null}::uuid, ${scope},
            ${input.idempotencyKey ?? null}, ${input.maxAttempts ?? 3},
            coalesce(${input.runAfter ?? null}::timestamptz, now()), ${input.notAfter ?? null}::timestamptz)
    on conflict do nothing
    returning *`;
  if (rows[0]) return { job: rows[0], created: true };

  const existing = input.idempotencyKey
    ? await db.jobs.findUnique({ where: { idempotency_key: input.idempotencyKey } })
    : null;
  const active =
    existing ??
    (input.opportunityId
      ? await db.jobs.findFirst({
          where: {
            opportunity_id: input.opportunityId,
            kind: input.kind,
            job_scope: scope,
            status: { in: ['queued', 'leased'] },
          },
        })
      : null);
  if (!active) throw new Error(`could not queue ${input.kind}: a conflicting job vanished`);
  return { job: active, created: false };
}

export interface ClaimOptions {
  lane: JobLane;
  kinds?: readonly string[];
  /** A paired worker's id (module 1.18); the in-process runner leaves it out. */
  workerId?: string;
  leaseSeconds: number;
  now?: Date;
}

/**
 * Takes the most urgent runnable job (lowest priority number, then oldest) and leases it. `FOR UPDATE SKIP LOCKED`
 * means two runners, or a runner and a worker, can never get the same job. Each claim counts as an attempt, so a
 * job that crashes its runner every time still reaches its limit.
 */
export async function claimJob(db: Db, o: ClaimOptions): Promise<JobRow | null> {
  const now = o.now ?? new Date();
  const kindFilter = o.kinds ? Prisma.sql`and kind = any(${[...o.kinds]}::text[])` : Prisma.empty;
  const rows = await db.$queryRaw<jobs[]>`
    update smb.jobs set
      status = 'leased', lease_id = gen_random_uuid(), leased_by = ${o.workerId ?? null}::uuid,
      lease_expires_at = ${now}::timestamptz + make_interval(secs => ${o.leaseSeconds}),
      heartbeat_at = ${now}::timestamptz, attempts = attempts + 1,
      started_at = coalesce(started_at, ${now}::timestamptz)
    where id = (
      select id from smb.jobs
      where status = 'queued' and lane = ${o.lane}::smb.job_lane and run_after <= ${now}::timestamptz
        and (not_after is null or not_after > ${now}::timestamptz) ${kindFilter}
        and attempts < max_attempts
      order by priority, run_after, created_at
      for update skip locked limit 1)
    returning *`;
  return rows[0] ?? null;
}

/** Extends the lease. False means the lease was lost (expired and re-queued, or cancelled): stop working. */
export async function heartbeatJob(
  db: Db,
  jobId: string,
  leaseId: string,
  o: { leaseSeconds: number; progress?: unknown; now?: Date },
): Promise<boolean> {
  const now = o.now ?? new Date();
  const n = await db.$executeRaw`
    update smb.jobs set
      lease_expires_at = ${now}::timestamptz + make_interval(secs => ${o.leaseSeconds}),
      heartbeat_at = ${now}::timestamptz,
      progress = coalesce(${o.progress === undefined ? null : JSON.stringify(o.progress)}::jsonb, progress)
    where id = ${jobId}::uuid and lease_id = ${leaseId}::uuid and status = 'leased'`;
  return n === 1;
}

export type CompleteOutcome =
  | { outcome: 'completed' }
  /** A second submit for a job that already succeeded: the first outcome stands. */
  | { outcome: 'already_completed' }
  | { outcome: 'lease_lost' };

/** Marks a leased job done. Idempotent on `(jobId, leaseId)`. */
export async function completeJob(
  db: Db,
  jobId: string,
  leaseId: string,
  result: unknown,
  now: Date = new Date(),
): Promise<CompleteOutcome> {
  const n = await db.$executeRaw`
    update smb.jobs set status = 'succeeded', result = ${JSON.stringify(result ?? {})}::jsonb,
      lease_id = null, leased_by = null, lease_expires_at = null, last_error = null, error_code = null,
      finished_at = ${now}::timestamptz
    where id = ${jobId}::uuid and lease_id = ${leaseId}::uuid and status = 'leased'`;
  if (n === 1) return { outcome: 'completed' };
  const job = await db.jobs.findUnique({ where: { id: jobId } });
  return job?.status === 'succeeded' ? { outcome: 'already_completed' } : { outcome: 'lease_lost' };
}

/** The delay before attempt `attempts + 1`: backoffSeconds * multiplier^(attempts - 1). */
export function backoffSeconds(
  attempts: number,
  policy: { backoffSeconds: number; backoffMultiplier: number },
): number {
  return Math.round(policy.backoffSeconds * policy.backoffMultiplier ** Math.max(0, attempts - 1));
}

export interface FailInput {
  code: string;
  message: string;
  retryable: boolean;
  /** Seconds to wait before the next attempt, when there is one. */
  retryInSeconds?: number;
  now?: Date;
}

export type FailOutcome =
  | { outcome: 'requeued'; runAfter: Date }
  /** Out of attempts after retryable failures. */
  | { outcome: 'dead' }
  /** A failure that waiting would not change. */
  | { outcome: 'failed' }
  | { outcome: 'lease_lost' };

/** Records a failed attempt: back to the queue with a delay while attempts remain, otherwise stopped for good. */
export async function failJob(
  db: Db,
  jobId: string,
  leaseId: string,
  f: FailInput,
): Promise<FailOutcome> {
  const now = f.now ?? new Date();
  const job = await db.jobs.findUnique({ where: { id: jobId } });
  if (!job || job.lease_id !== leaseId || job.status !== 'leased') return { outcome: 'lease_lost' };
  const message = f.message.slice(0, 2000);
  if (f.retryable && job.attempts < job.max_attempts) {
    const runAfter = new Date(now.getTime() + (f.retryInSeconds ?? 60) * 1000);
    const n = await db.$executeRaw`
      update smb.jobs set status = 'queued', lease_id = null, leased_by = null, lease_expires_at = null,
        run_after = ${runAfter}::timestamptz, last_error = ${message}, error_code = ${f.code}
      where id = ${jobId}::uuid and lease_id = ${leaseId}::uuid and status = 'leased'`;
    return n === 1 ? { outcome: 'requeued', runAfter } : { outcome: 'lease_lost' };
  }
  const status = f.retryable ? 'dead' : 'failed';
  const n = await db.$executeRaw`
    update smb.jobs set status = ${status}::smb.job_status, lease_id = null, leased_by = null,
      lease_expires_at = null, last_error = ${message}, error_code = ${f.code},
      finished_at = ${now}::timestamptz
    where id = ${jobId}::uuid and lease_id = ${leaseId}::uuid and status = 'leased'`;
  return n === 1 ? { outcome: status } : { outcome: 'lease_lost' };
}

export interface Reaped {
  id: string;
  kind: string;
  opportunity_id: string | null;
  status: 'queued' | 'dead';
}

/**
 * Finds leases whose holder stopped heartbeating (a crash, a lost connection, a reboot) and puts the job back
 * in the queue, or stops it for good once its attempts are used up.
 */
export async function reapExpiredLeases(db: Db, now: Date = new Date()): Promise<Reaped[]> {
  return db.$queryRaw<Reaped[]>`
    update smb.jobs set
      status = (case when attempts >= max_attempts then 'dead' else 'queued' end)::smb.job_status,
      lease_id = null, leased_by = null, lease_expires_at = null,
      last_error = 'the lease expired: the runner stopped answering', error_code = 'lease_expired',
      run_after = ${now}::timestamptz,
      finished_at = case when attempts >= max_attempts then ${now}::timestamptz else null end
    where status = 'leased' and lease_expires_at < ${now}::timestamptz
    returning id, kind, opportunity_id, status::text as status`;
}

/** Work that waited past its `not_after` expires instead of running (docs/ARCHITECTURE.md section 6). */
export async function expireStaleJobs(db: Db, now: Date = new Date()): Promise<Reaped[]> {
  return db.$queryRaw<Reaped[]>`
    update smb.jobs set status = 'expired', last_error = 'expired before it ran', error_code = 'expired',
      finished_at = ${now}::timestamptz
    where status = 'queued' and not_after is not null and not_after <= ${now}::timestamptz
    returning id, kind, opportunity_id, status::text as status`;
}

/** Cancels a job that is waiting or running. A runner holding its lease finds out at its next heartbeat. */
export async function cancelJob(db: Db, jobId: string, now: Date = new Date()): Promise<boolean> {
  const n = await db.$executeRaw`
    update smb.jobs set status = 'cancelled', lease_id = null, leased_by = null, lease_expires_at = null,
      last_error = 'cancelled', error_code = 'cancelled', finished_at = ${now}::timestamptz
    where id = ${jobId}::uuid and status in ('queued', 'leased')`;
  return n === 1;
}

/** The newest job for an idempotency key base: `base`, then `base#1`, `base#2` after each admin retry. */
export async function latestJobForBase(db: Db, base: string): Promise<JobRow | null> {
  const rows = await db.$queryRaw<jobs[]>`
    select * from smb.jobs
    where idempotency_key = ${base} or idempotency_key like ${base.replace(/[\\%_]/g, '\\$&') + '#%'}
    order by created_at desc, id desc limit 1`;
  return rows[0] ?? null;
}

/** The key a retry of `job` uses: its base plus the next `#n`. */
export function nextRetryKey(key: string): string {
  const m = /^(.*)#(\d+)$/.exec(key);
  return m ? `${m[1]}#${Number(m[2]) + 1}` : `${key}#1`;
}

export const isBadEnd = (status: string): boolean =>
  ['failed', 'dead', 'cancelled', 'expired'].includes(status);
