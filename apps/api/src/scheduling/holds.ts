import type { Prisma, PrismaClient } from '@prisma/client';

export interface SuspendOptions {
  postTypeId: string;
  until?: Date;
  reason: string;
  actor: string;
  now?: Date;
}

export interface ResumeOptions {
  postTypeId: string;
  actor: string;
}

/**
 * Suspends recurring schedules for a post type.
 * Upserts into `schedule_holds` and writes an audit log entry `schedule.suspend`.
 * If `until` is supplied, it must be in the future.
 */
export async function suspendSchedules(
  db: PrismaClient | Prisma.TransactionClient,
  opts: SuspendOptions,
): Promise<{ postTypeId: string; suspendedUntil: Date | null; reason: string; createdBy: string }> {
  const now = opts.now ?? new Date();
  if (opts.until && opts.until.getTime() <= now.getTime()) {
    throw new RangeError('Suspension "until" must be in the future');
  }

  const hold = await db.schedule_holds.upsert({
    where: { post_type_id: opts.postTypeId },
    create: {
      post_type_id: opts.postTypeId,
      suspended_until: opts.until ?? null,
      reason: opts.reason,
      created_by: opts.actor,
    },
    update: {
      suspended_until: opts.until ?? null,
      reason: opts.reason,
      created_by: opts.actor,
      created_at: now,
    },
  });

  await db.audit_log.create({
    data: {
      actor: opts.actor,
      action: 'schedule.suspend',
      target_type: 'post_type',
      target_id: opts.postTypeId,
      details: {
        suspendedUntil: opts.until ? opts.until.toISOString() : null,
        reason: opts.reason,
      },
    },
  });

  return {
    postTypeId: hold.post_type_id,
    suspendedUntil: hold.suspended_until,
    reason: hold.reason,
    createdBy: hold.created_by,
  };
}

/**
 * Resumes recurring schedules for a post type.
 * Deletes from `schedule_holds` and writes an audit log entry `schedule.resume`.
 * Returns false if no hold existed.
 */
export async function resumeSchedules(
  db: PrismaClient | Prisma.TransactionClient,
  opts: ResumeOptions,
): Promise<boolean> {
  const existing = await db.schedule_holds.findUnique({
    where: { post_type_id: opts.postTypeId },
  });
  if (!existing) {
    return false;
  }

  await db.schedule_holds.delete({
    where: { post_type_id: opts.postTypeId },
  });

  await db.audit_log.create({
    data: {
      actor: opts.actor,
      action: 'schedule.resume',
      target_type: 'post_type',
      target_id: opts.postTypeId,
      details: {},
    },
  });

  return true;
}

/**
 * Checks for an active hold on a post type.
 * Returns the hold if active, or null if no hold or hold has expired.
 */
export async function activeHold(
  db: PrismaClient | Prisma.TransactionClient,
  postTypeId: string,
  now: Date = new Date(),
) {
  const hold = await db.schedule_holds.findUnique({
    where: { post_type_id: postTypeId },
  });
  if (!hold) return null;
  if (hold.suspended_until && hold.suspended_until.getTime() <= now.getTime()) {
    return null;
  }
  return hold;
}
