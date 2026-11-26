import type { PrismaClient, jobs, opportunity_status } from '@prisma/client';
import { JOB_LANE_OF, type GpuJobKind, type ServerJobKind } from '@smb/shared';
import { enqueueJob, isBadEnd, nextRetryKey } from '../jobs/index.js';
import { ACTOR } from './advance.js';
import { STEP_OF_KIND, type WorkflowStep } from './types.js';

export class ResumeError extends Error {
  constructor(
    readonly code: 'not_failed' | 'not_found' | 'nothing_to_retry',
    message: string,
  ) {
    super(message);
    this.name = 'ResumeError';
  }
}

export interface ResumeResult {
  opportunityId: string;
  step: WorkflowStep;
  /** Jobs queued again. Everything that already succeeded is left alone. */
  requeued: { kind: string; key: string }[];
}

/**
 * Retries a failed opportunity from the step that failed, and nowhere earlier. Its status goes back to the step's
 * stage, and a replacement is queued for each job that ended badly in that step (same payload, next `#n` key).
 * Jobs that succeeded are not touched, so research is not repeated for a failed graphic and an approval is not
 * lost: nothing here changes a review record.
 */
export async function resumeOpportunity(
  db: PrismaClient,
  opportunityId: string,
  actor: string,
): Promise<ResumeResult> {
  return db.$transaction(async (tx) => {
    const opp = await tx.post_opportunities.findUnique({ where: { id: opportunityId } });
    if (!opp) throw new ResumeError('not_found', `no opportunity ${opportunityId}`);
    if (opp.status !== 'failed' || !opp.failed_step) {
      throw new ResumeError('not_failed', `the opportunity is ${opp.status}, not failed`);
    }
    const step = opp.failed_step as WorkflowStep;
    const rows = await tx.$queryRaw<jobs[]>`
      select distinct on (coalesce(regexp_replace(idempotency_key, '#[0-9]+$', ''), id::text)) *
      from smb.jobs
      where opportunity_id = ${opportunityId}::uuid and idempotency_key is not null
      order by coalesce(regexp_replace(idempotency_key, '#[0-9]+$', ''), id::text), created_at desc, id desc`;
    const bad = rows.filter((j) => isBadEnd(j.status) && STEP_OF_KIND[j.kind] === step);
    if (bad.length === 0 && step !== 'researching') {
      throw new ResumeError('nothing_to_retry', 'no job of the failed step ended badly');
    }
    await tx.$executeRaw`select set_config('smb.actor', ${actor}, true), set_config('smb.reason', ${'retry from ' + step}, true), set_config('smb.job_id', '', true)`;
    await tx.post_opportunities.update({
      where: { id: opportunityId },
      data: { status: step as opportunity_status, failed_step: null, failure_reason: null },
    });
    const requeued: ResumeResult['requeued'] = [];
    for (const j of bad) {
      if (!(j.kind in JOB_LANE_OF)) continue;
      const key = nextRetryKey(j.idempotency_key!);
      const { created } = await enqueueJob(tx, {
        kind: j.kind as ServerJobKind | GpuJobKind,
        opportunityId,
        scope: j.job_scope,
        payload: (j.payload as Record<string, unknown>) ?? {},
        idempotencyKey: key,
        priority: j.priority,
        maxAttempts: j.max_attempts,
        notAfter: opp.not_after,
      });
      if (created) requeued.push({ kind: j.kind, key });
    }
    await tx.audit_log.create({
      data: {
        actor,
        action: 'workflow.resume',
        target_type: 'opportunity',
        target_id: opportunityId,
        details: { step, requeued: requeued.map((r) => r.key), by: ACTOR },
      },
    });
    return { opportunityId, step, requeued };
  });
}
