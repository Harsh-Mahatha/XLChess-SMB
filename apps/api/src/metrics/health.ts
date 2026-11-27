import type { PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import {
  evaluateHealth,
  type HealthAlert,
  type HealthInputs,
  type HealthThresholds,
} from '@smb/shared';

/** What is wrong right now, and the workers behind it (module 1.19). */
export interface HealthReport {
  at: string;
  ok: boolean;
  alerts: HealthAlert[];
  workers: {
    id: string;
    label: string | null;
    online: boolean;
    paused: boolean;
    lastSeenAt: string | null;
    currentJob: { id: string; kind: string; since: string | null } | null;
  }[];
  pollers: {
    id: string;
    enabled: boolean;
    consecutiveFailures: number;
    lastSuccessAt: string | null;
  }[];
}

export async function gatherHealthInputs(db: PrismaClient): Promise<HealthInputs> {
  const [workers, gpuQueue, dead, pubs, pollers, review] = await Promise.all([
    db.workers.findMany({
      where: { revoked_at: null, paused: false },
      select: { id: true, last_seen_at: true },
    }),
    db.$queryRaw<{ queued: number; oldest: Date | null }[]>`
      select count(*)::int as queued, min(run_after) as oldest
      from smb.jobs
      where status = 'queued' and lane = 'gpu' and run_after <= now()`,
    db.$queryRaw<{ n: number }[]>`
      select count(*)::int as n from smb.jobs
      where status = 'dead' and finished_at > now() - interval '24 hours'`,
    db.$queryRaw<{ status: string; n: number }[]>`
      select status::text as status, count(*)::int as n from smb.publications
      where (status = 'uncertain')
         or (status = 'failed' and updated_at > now() - interval '7 days')
      group by 1`,
    db.event_pollers.findMany({
      where: { enabled: true, consecutive_failures: { gt: 0 } },
      select: { detector_id: true, consecutive_failures: true, last_error: true },
    }),
    db.$queryRaw<{ oldest: Date | null }[]>`
      select min(w.at) as oldest
      from smb.post_opportunities o
      cross join lateral (
        select max(e.created_at) as at from smb.opportunity_events e
        where e.opportunity_id = o.id and e.to_status = 'awaiting_review'
      ) w
      where o.status = 'awaiting_review'`,
  ]);
  const pub = (s: string): number => pubs.find((r) => r.status === s)?.n ?? 0;
  return {
    workers: workers.map((w) => ({ id: w.id, lastSeenAt: w.last_seen_at })),
    gpuJobsQueued: gpuQueue[0]?.queued ?? 0,
    oldestGpuJobQueuedAt: gpuQueue[0]?.oldest ?? null,
    deadJobsLast24h: dead[0]?.n ?? 0,
    publicationsFailed: pub('failed'),
    publicationsUncertain: pub('uncertain'),
    pollersFailing: pollers.map((p) => ({
      id: p.detector_id,
      consecutiveFailures: p.consecutive_failures,
      // The stored error can be large and comes from a remote source: only a short message is kept.
      lastError:
        p.last_error && typeof p.last_error === 'object' && 'message' in p.last_error
          ? String((p.last_error as { message: unknown }).message).slice(0, 200)
          : null,
    })),
    oldestReviewWaitingAt: review[0]?.oldest ?? null,
  };
}

export async function healthReport(
  db: PrismaClient,
  thresholds: HealthThresholds,
  now: Date = new Date(),
): Promise<HealthReport> {
  const inputs = await gatherHealthInputs(db);
  const alerts = evaluateHealth(inputs, now, thresholds);
  const workers = await db.workers.findMany({
    where: { revoked_at: null },
    orderBy: { created_at: 'asc' },
  });
  const leased = await db.jobs.findMany({
    where: { status: 'leased', leased_by: { in: workers.map((w) => w.id) } },
    select: { id: true, kind: true, leased_by: true, attempt_started_at: true },
  });
  const pollers = await db.event_pollers.findMany({ orderBy: { detector_id: 'asc' } });
  const offlineMs = thresholds.workerOfflineMinutes * 60_000;
  return {
    at: now.toISOString(),
    ok: alerts.length === 0,
    alerts,
    workers: workers.map((w) => {
      const job = leased.find((j) => j.leased_by === w.id);
      return {
        id: w.id,
        label: w.label,
        online: !!w.last_seen_at && now.getTime() - w.last_seen_at.getTime() < offlineMs,
        paused: w.paused,
        lastSeenAt: w.last_seen_at?.toISOString() ?? null,
        currentJob: job
          ? { id: job.id, kind: job.kind, since: job.attempt_started_at?.toISOString() ?? null }
          : null,
      };
    }),
    pollers: pollers.map((p) => ({
      id: p.detector_id,
      enabled: p.enabled,
      consecutiveFailures: p.consecutive_failures,
      lastSuccessAt: p.last_success_at?.toISOString() ?? null,
    })),
  };
}

/**
 * Logs an alert once when it opens and once when it clears, not on every pass. The state lives in this
 * process: after a restart the alerts that are still active are logged as opened again, which is what an
 * operator reading the log after a restart wants to see.
 */
export function createAlertWatcher(logger: Logger): (alerts: HealthAlert[]) => void {
  let active = new Map<string, HealthAlert>();
  return (alerts) => {
    const next = new Map(alerts.map((a) => [a.key, a]));
    for (const a of alerts) {
      if (!active.has(a.key)) {
        const level = a.severity === 'critical' ? 'error' : 'warn';
        logger[level]({ event: 'alert.opened', alert: a.key, severity: a.severity, ...a.detail }, a.message);
      }
    }
    for (const [key, a] of active) {
      if (!next.has(key)) logger.info({ event: 'alert.cleared', alert: key }, `Cleared: ${a.message}`);
    }
    active = next;
  };
}

/** One alert pass: check, log changes. Safe to run from every instance. */
export async function runAlertCheck(
  db: PrismaClient,
  thresholds: HealthThresholds,
  watch: (alerts: HealthAlert[]) => void,
  now: Date = new Date(),
): Promise<HealthAlert[]> {
  const alerts = evaluateHealth(await gatherHealthInputs(db), now, thresholds);
  watch(alerts);
  return alerts;
}
