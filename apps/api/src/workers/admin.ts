import type { PrismaClient } from '@prisma/client';
import { writeAudit } from '../audit.js';
import { enqueueJob } from '../jobs/index.js';

const ONLINE_WINDOW_MS = 90_000;

export class WorkerAdminError extends Error {
  constructor(
    readonly status: 404 | 409,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'WorkerAdminError';
  }
}

export interface AdminWorkerView {
  id: string;
  label: string | null;
  hostname: string;
  os: string;
  osSupported: boolean;
  workerVersion: string;
  pairedAt: string;
  lastSeenAt: string | null;
  online: boolean;
  paused: boolean;
  revokedAt: string | null;
  updateRequired: boolean;
  status: unknown;
  currentJobs: Array<{ id: string; kind: string; leaseExpiresAt: string | null }>;
  lastSelfTest: {
    status: string;
    finishedAt: string | null;
    ok: boolean | null;
  } | null;
}

export async function listWorkers(
  db: PrismaClient,
  now: Date = new Date(),
): Promise<AdminWorkerView[]> {
  const rows = await db.workers.findMany({
    orderBy: { paired_at: 'desc' },
  });
  if (rows.length === 0) return [];

  const workerIds = rows.map((w) => w.id);
  const [leasedJobs, selftests] = await Promise.all([
    db.jobs.findMany({
      where: { status: 'leased', leased_by: { in: workerIds } },
      select: { id: true, kind: true, leased_by: true, lease_expires_at: true },
    }),
    db.jobs.findMany({
      where: { kind: 'worker_selftest', job_scope: { in: workerIds } },
      orderBy: { created_at: 'desc' },
      select: {
        job_scope: true,
        status: true,
        finished_at: true,
        result: true,
      },
    }),
  ]);

  const jobsByWorker = new Map<string, AdminWorkerView['currentJobs']>();
  for (const j of leasedJobs) {
    if (!j.leased_by) continue;
    const list = jobsByWorker.get(j.leased_by) ?? [];
    list.push({
      id: j.id,
      kind: j.kind,
      leaseExpiresAt: j.lease_expires_at?.toISOString() ?? null,
    });
    jobsByWorker.set(j.leased_by, list);
  }

  const latestSelfTest = new Map<string, AdminWorkerView['lastSelfTest']>();
  for (const s of selftests) {
    if (latestSelfTest.has(s.job_scope)) continue;
    const ok = (s.result as { ok?: unknown } | null)?.ok;
    latestSelfTest.set(s.job_scope, {
      status: s.status,
      finishedAt: s.finished_at?.toISOString() ?? null,
      ok: typeof ok === 'boolean' ? ok : null,
    });
  }

  const cutoff = now.getTime() - ONLINE_WINDOW_MS;
  return rows.map((w) => ({
    id: w.id,
    label: w.label,
    hostname: w.hostname,
    os: w.os,
    osSupported: !w.os.toLowerCase().includes('windows 10'),
    workerVersion: w.worker_version,
    pairedAt: w.paired_at.toISOString(),
    lastSeenAt: w.last_seen_at?.toISOString() ?? null,
    online: Boolean(w.last_seen_at && w.last_seen_at.getTime() > cutoff),
    paused: w.paused,
    revokedAt: w.revoked_at?.toISOString() ?? null,
    updateRequired: w.update_required,
    status: w.status,
    currentJobs: jobsByWorker.get(w.id) ?? [],
    lastSelfTest: latestSelfTest.get(w.id) ?? null,
  }));
}

export async function setWorkerPaused(
  db: PrismaClient,
  workerId: string,
  paused: boolean,
  actor: string,
): Promise<{ id: string; paused: boolean }> {
  return db.$transaction(async (tx) => {
    const worker = await tx.workers.findUnique({ where: { id: workerId } });
    if (!worker) throw new WorkerAdminError(404, 'not_found', 'Worker not found');
    const updated = await tx.workers.update({
      where: { id: workerId },
      data: { paused },
    });
    await writeAudit(tx, {
      actor,
      action: paused ? 'worker.pause' : 'worker.resume',
      targetType: 'worker',
      targetId: workerId,
      details: { hostname: worker.hostname, label: worker.label },
    });
    return { id: updated.id, paused: updated.paused };
  });
}

export async function revokeWorker(
  db: PrismaClient,
  workerId: string,
  actor: string,
  reason: string,
  now: Date = new Date(),
): Promise<{ id: string; revokedAt: string; requeuedJobs: number }> {
  return db.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string; revoked_at: Date | null }[]>`
      select id, revoked_at from smb.workers where id = ${workerId}::uuid for update`;
    const worker = locked[0];
    if (!worker) throw new WorkerAdminError(404, 'not_found', 'Worker not found');
    if (worker.revoked_at !== null) {
      throw new WorkerAdminError(409, 'already_revoked', 'Worker is already revoked');
    }

    await tx.workers.update({
      where: { id: workerId },
      data: {
        revoked_at: now,
        revoked_by: actor,
        revoke_reason: reason,
      },
    });

    const requeued = await tx.$executeRaw`
      update smb.jobs set
        status = (case when attempts >= max_attempts then 'dead' else 'queued' end)::smb.job_status,
        lease_id = null, leased_by = null, lease_expires_at = null,
        error_code = 'worker_revoked', last_error = 'the worker was revoked',
        run_after = ${now}::timestamptz,
        finished_at = case when attempts >= max_attempts then ${now}::timestamptz else null end
      where status = 'leased' and leased_by = ${workerId}::uuid`;

    await writeAudit(tx, {
      actor,
      action: 'worker.revoke',
      targetType: 'worker',
      targetId: workerId,
      details: { reason, requeuedJobs: requeued },
    });

    return {
      id: workerId,
      revokedAt: now.toISOString(),
      requeuedJobs: requeued,
    };
  });
}

export async function enqueueWorkerSelfTest(
  db: PrismaClient,
  workerId: string,
  actor: string,
  now: Date = new Date(),
): Promise<{ jobId: string }> {
  const worker = await db.workers.findUnique({ where: { id: workerId } });
  if (!worker) throw new WorkerAdminError(404, 'not_found', 'Worker not found');
  if (worker.revoked_at !== null) {
    throw new WorkerAdminError(409, 'worker_revoked', 'Cannot run self-test on a revoked worker');
  }

  return db.$transaction(async (tx) => {
    const { job } = await enqueueJob(tx, {
      kind: 'worker_selftest',
      scope: workerId,
      idempotencyKey: `selftest:${workerId}:${now.getTime()}`,
      payload: { workerId },
      maxAttempts: 2,
      runAfter: now,
    });
    await writeAudit(tx, {
      actor,
      action: 'worker.selftest',
      targetType: 'worker',
      targetId: workerId,
      details: { jobId: job.id },
    });
    return { jobId: job.id };
  });
}
