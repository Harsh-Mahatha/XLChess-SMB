import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { Prisma, type PrismaClient } from '@prisma/client';
import { backoffDelayMs } from '@smb/shared';
import type { Logger } from 'pino';
import type { DetectorRegistry } from './registry.js';
import type { DetectorPollResult, DetectorRunResult, EventDetector, PollSummary } from './types.js';

export interface PollDeps {
  db: PrismaClient;
  detectors: DetectorRegistry;
  logger: Logger;
  /** Identifies this process in `event_pollers.lease_holder`. */
  instanceId?: string;
  /** For tests: jitter source for backoff. */
  rand?: () => number;
}

export interface PollOptions {
  now?: Date;
  /** Run only this detector. */
  only?: string;
  /** Run even when not due, disabled or backing off. The lease still applies. */
  force?: boolean;
}

/** A run that outlives this is treated as dead and its lease can be taken over. */
export const LEASE_MS = 5 * 60_000;

const defaultInstance = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

export class UnknownDetectorError extends Error {
  constructor(readonly detectorId: string) {
    super(`Unknown event detector: ${detectorId}`);
    this.name = 'UnknownDetectorError';
  }
}

async function ensurePoller(db: PrismaClient, d: EventDetector) {
  await db.event_pollers.upsert({
    where: { detector_id: d.id },
    create: { detector_id: d.id, post_type_id: d.postTypeId },
    update: {},
  });
  return db.event_pollers.findUniqueOrThrow({ where: { detector_id: d.id } });
}

/** Takes the detector's lease. false when another live run holds it. */
async function claimLease(
  db: PrismaClient,
  id: string,
  holder: string,
  now: Date,
): Promise<boolean> {
  const until = new Date(now.getTime() + LEASE_MS);
  const n = await db.$executeRaw`
    update smb.event_pollers
       set lease_until = ${until}, lease_holder = ${holder}
     where detector_id = ${id}
       and (lease_until is null or lease_until < ${now})`;
  return n === 1;
}

async function releaseLease(db: PrismaClient, id: string, holder: string): Promise<void> {
  await db.event_pollers.updateMany({
    where: { detector_id: id, lease_holder: holder },
    data: { lease_until: null, lease_holder: null },
  });
}

/**
 * One pass over the registered detectors (1.16 D10, D11). Each due detector runs under its lease,
 * one after another; its outcome, failures and next due time are recorded in `smb.event_pollers`.
 * A run where every provider call failed backs off: cadence × 2^failures, at most 10 min.
 * Never throws for a detector failure.
 */
export async function runEventPoll(deps: PollDeps, opts: PollOptions = {}): Promise<PollSummary> {
  const now = opts.now ?? new Date();
  const holder = deps.instanceId ?? defaultInstance;
  const force = opts.force ?? false;

  let detectors = deps.detectors.list();
  if (opts.only) {
    const one = deps.detectors.get(opts.only);
    if (!one) throw new UnknownDetectorError(opts.only);
    detectors = [one];
  }

  const results: DetectorPollResult[] = [];
  for (const detector of detectors) {
    results.push(await pollOne(deps, detector, holder, now, force));
  }
  return { at: now.toISOString(), detectors: results };
}

async function pollOne(
  deps: PollDeps,
  detector: EventDetector,
  holder: string,
  now: Date,
  force: boolean,
): Promise<DetectorPollResult> {
  const { db, logger } = deps;
  const poller = await ensurePoller(db, detector);
  const base = {
    id: detector.id,
    nextDueAt: poller.next_due_at?.toISOString() ?? null,
    consecutiveFailures: poller.consecutive_failures,
  };

  if (!force && !poller.enabled) return { ...base, outcome: 'disabled' };
  if (!force && poller.consecutive_failures > 0 && poller.next_due_at && poller.next_due_at > now) {
    return { ...base, outcome: 'backoff' };
  }

  if (!(await claimLease(db, detector.id, holder, now))) {
    return { ...base, outcome: 'lease_held' };
  }

  try {
    if (!force) {
      const due = await detector.due({ now });
      if (!due.due) {
        await update(db, detector.id, {
          last_outcome: 'not_due',
          next_due_at: due.nextDueAt,
        });
        return { ...base, outcome: 'not_due', nextDueAt: due.nextDueAt?.toISOString() ?? null };
      }
    }

    let run: DetectorRunResult;
    try {
      run = await detector.run({ now });
    } catch (err) {
      logger.error({ err, detector: detector.id }, 'Event detector failed');
      run = {
        outcome: 'failed',
        cadenceMs: null,
        errors: [
          {
            sourceId: '-',
            capability: '-',
            code: 'internal',
            message: err instanceof Error ? err.message : String(err),
          },
        ],
        summary: null,
      };
    }

    if (run.outcome === 'failed') {
      const failures = poller.consecutive_failures + 1;
      const cadence = run.cadenceMs ?? 60_000;
      const nextDueAt = new Date(now.getTime() + backoffDelayMs(cadence, failures, deps.rand));
      await update(db, detector.id, {
        last_run_at: now,
        last_outcome: 'failed',
        consecutive_failures: failures,
        next_due_at: nextDueAt,
        last_error: {
          at: now.toISOString(),
          errors: run.errors ?? [],
        } as unknown as Prisma.InputJsonValue,
      });
      logger.warn(
        { detector: detector.id, failures, nextDueAt, errors: run.errors },
        'Event detector run failed; backing off',
      );
      return {
        id: detector.id,
        outcome: 'failed',
        nextDueAt: nextDueAt.toISOString(),
        consecutiveFailures: failures,
        summary: run.summary,
      };
    }

    const nextDueAt = run.cadenceMs === null ? null : new Date(now.getTime() + run.cadenceMs);
    const succeeded = run.outcome === 'ok' || run.outcome === 'partial';
    await update(db, detector.id, {
      last_run_at: now,
      last_outcome: run.outcome,
      next_due_at: nextDueAt,
      ...(succeeded
        ? {
            last_success_at: now,
            consecutive_failures: 0,
            last_error:
              run.outcome === 'partial'
                ? ({
                    at: now.toISOString(),
                    errors: run.errors ?? [],
                  } as unknown as Prisma.InputJsonValue)
                : Prisma.DbNull,
          }
        : {}),
    });
    return {
      id: detector.id,
      outcome: run.outcome,
      nextDueAt: nextDueAt?.toISOString() ?? null,
      consecutiveFailures: succeeded ? 0 : poller.consecutive_failures,
      summary: run.summary,
    };
  } finally {
    await releaseLease(db, detector.id, holder);
  }
}

async function update(
  db: PrismaClient,
  id: string,
  data: Prisma.event_pollersUpdateInput,
): Promise<void> {
  await db.event_pollers.update({ where: { detector_id: id }, data });
}

/** Pauses or resumes one detector, independent of SMB_EVENTS_ENABLED. Audited. */
export async function setDetectorEnabled(
  deps: { db: PrismaClient; detectors: DetectorRegistry },
  actor: string,
  id: string,
  enabled: boolean,
) {
  const detector = deps.detectors.get(id);
  if (!detector) throw new UnknownDetectorError(id);
  await ensurePoller(deps.db, detector);
  const row = await deps.db.event_pollers.update({
    where: { detector_id: id },
    data: { enabled },
  });
  await deps.db.audit_log.create({
    data: {
      actor,
      action: enabled ? 'events.detector_resume' : 'events.detector_pause',
      target_type: 'event_poller',
      target_id: id,
      details: { enabled },
    },
  });
  return row;
}

/** Whether a live run currently holds the detector's lease. */
export async function leaseHeld(db: PrismaClient, id: string, now = new Date()): Promise<boolean> {
  const row = await db.event_pollers.findUnique({ where: { detector_id: id } });
  return !!row?.lease_until && row.lease_until >= now;
}
