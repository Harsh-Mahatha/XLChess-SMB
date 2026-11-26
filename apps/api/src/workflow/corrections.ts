import type { PrismaClient, opportunity_status } from '@prisma/client';
import { cancelJob } from '../jobs/index.js';
import { ACTOR } from './advance.js';

export interface CorrectionResult {
  opportunityId: string;
  from: string;
  eventId: string;
  fromVersion: number;
  toVersion: number;
  approvalWithdrawn: boolean;
}

/** Statuses from which a corrected opportunity goes back to research. Posts already going out are left to `result_corrected`. */
const REWINDABLE = [
  'pending',
  'researching',
  'generating',
  'awaiting_review',
  'deferred',
  'approved',
  'scheduled',
];

async function cancelActive(db: PrismaClient, opportunityId: string, now: Date): Promise<void> {
  const active = await db.jobs.findMany({
    where: { opportunity_id: opportunityId, status: { in: ['queued', 'leased'] } },
    select: { id: true },
  });
  for (const j of active) await cancelJob(db, j.id, now);
}

/**
 * An opportunity built from event version 1 whose event was later corrected to version 2 holds facts that are no
 * longer true (module 1.16 hand-off). If it has not been published it goes back to research on the corrected
 * facts (the same opportunity: never a second one for the event), any approval is withdrawn, and the jobs still
 * working on the old facts are cancelled. A published post is not touched: `result_corrected` already flags it.
 */
export async function applyCorrections(
  db: PrismaClient,
  now: Date = new Date(),
): Promise<CorrectionResult[]> {
  const stale = await db.$queryRaw<
    { id: string; status: string; event_id: string; have: number; latest: number }[]
  >`
    select o.id, o.status::text as status, o.trigger_event_id as event_id,
           o.trigger_event_version as have, e.version as latest
    from smb.post_opportunities o
    join smb.detected_events e on e.id = o.trigger_event_id
    where o.trigger_event_version < e.version and o.status::text = any(${REWINDABLE}::text[])`;
  const done: CorrectionResult[] = [];
  for (const s of stale) {
    const result = await db.$transaction(async (tx) => {
      await tx.$executeRaw`select set_config('smb.actor', ${ACTOR}, true), set_config('smb.reason', ${'the event result was corrected'}, true), set_config('smb.job_id', '', true)`;
      const opp = await tx.post_opportunities.findUniqueOrThrow({ where: { id: s.id } });
      if (!REWINDABLE.includes(opp.status)) return undefined;
      let withdrawn = false;
      if (opp.status === 'approved' || opp.status === 'scheduled') {
        withdrawn = true;
        const approval = await tx.review_actions.findFirst({
          where: { opportunity_id: opp.id, action: 'approve' },
          orderBy: { created_at: 'desc' },
        });
        if (approval) {
          await tx.publications.updateMany({
            where: { approval_id: approval.id, status: 'pending' },
            data: {
              status: 'cancelled',
              last_error: 'approval withdrawn: the facts were corrected',
            },
          });
        }
        await tx.review_actions.create({
          data: {
            opportunity_id: opp.id,
            action: 'comment',
            reviewer_id: `system:${ACTOR}`,
            feedback: 'The approval was withdrawn because the event result was corrected',
            feedback_tags: ['approval_withdrawn', 'facts_corrected'],
          },
        });
      }
      await tx.post_opportunities.update({
        where: { id: opp.id },
        data: {
          status: 'researching' as opportunity_status,
          trigger_event_version: s.latest,
          failed_step: null,
          failure_reason: null,
        },
      });
      await tx.audit_log.create({
        data: {
          actor: `system:${ACTOR}`,
          action: 'workflow.facts_corrected',
          target_type: 'opportunity',
          target_id: opp.id,
          details: {
            from: opp.status,
            eventId: s.event_id,
            fromVersion: s.have,
            toVersion: s.latest,
            approvalWithdrawn: withdrawn,
          },
        },
      });
      return {
        opportunityId: opp.id,
        from: opp.status,
        eventId: s.event_id,
        fromVersion: s.have,
        toVersion: s.latest,
        approvalWithdrawn: withdrawn,
      };
    });
    if (result) {
      await cancelActive(db, s.id, now);
      done.push(result);
    }
  }
  return done;
}

/**
 * Work that waited too long is reconsidered, not run late (docs/ARCHITECTURE.md section 6). An opportunity still
 * before review whose `not_after` has passed is skipped with the reason `stale`. Opportunities waiting for a
 * reviewer are never expired here: a person has the draft in front of them.
 */
export async function skipStaleOpportunities(
  db: PrismaClient,
  now: Date = new Date(),
): Promise<string[]> {
  const rows = await db.post_opportunities.findMany({
    where: {
      status: { in: ['pending', 'researching', 'generating'] },
      not_after: { not: null, lte: now },
    },
    select: { id: true },
  });
  const skipped: string[] = [];
  for (const r of rows) {
    const ok = await db.$transaction(async (tx) => {
      await tx.$executeRaw`select set_config('smb.actor', ${ACTOR}, true), set_config('smb.reason', 'stale', true), set_config('smb.job_id', '', true)`;
      const u = await tx.post_opportunities.updateMany({
        where: { id: r.id, status: { in: ['pending', 'researching', 'generating'] } },
        data: { status: 'skipped', failure_reason: 'stale: not_after passed before review' },
      });
      return u.count === 1;
    });
    if (ok) {
      await cancelActive(db, r.id, now);
      skipped.push(r.id);
    }
  }
  return skipped;
}
