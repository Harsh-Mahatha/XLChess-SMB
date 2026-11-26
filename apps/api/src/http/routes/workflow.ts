import { Router, type Request, type Response } from 'express';
import type { Prisma, PrismaClient } from '@prisma/client';
import { JobStatus } from '@smb/shared';
import { z } from 'zod';
import { actorOf, authenticate, requireRole, type TokenVerifier } from '../../auth/index.js';
import { cancelJob } from '../../jobs/index.js';
import { ResumeError, resumeOpportunity } from '../../workflow/resume.js';
import { HttpError } from '../errors.js';

export interface WorkflowRouteDeps {
  verifier?: TokenVerifier;
  db: PrismaClient;
}

const ListJobsQuery = z.object({
  status: JobStatus.optional(),
  kind: z.string().min(1).optional(),
  opportunityId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const Id = z.string().uuid();
const Reprioritise = z.object({ priority: z.number().int().min(0).max(1000) });

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export function workflowRouter(deps: WorkflowRouteDeps): Router {
  const router = Router();
  const auth = [authenticate(deps.verifier), requireRole('admin')];
  const { db } = deps;

  const audit = (
    actor: string,
    action: string,
    targetType: string,
    targetId: string,
    details = {},
  ) =>
    db.audit_log.create({
      data: {
        actor,
        action,
        target_type: targetType,
        target_id: targetId,
        details: details as Prisma.InputJsonValue,
      },
    });

  // Jobs, newest first. Payloads are left out: they can be large and are not needed to see what is stuck.
  router.get('/v1/admin/jobs', ...auth, async (req: Request, res: Response) => {
    const q = ListJobsQuery.parse(req.query);
    const rows = await db.jobs.findMany({
      where: {
        ...(q.status && { status: q.status }),
        ...(q.kind && { kind: q.kind }),
        ...(q.opportunityId && { opportunity_id: q.opportunityId }),
      },
      orderBy: { created_at: 'desc' },
      take: q.limit,
    });
    res.json({
      jobs: rows.map((j) => ({
        id: j.id,
        lane: j.lane,
        kind: j.kind,
        status: j.status,
        priority: j.priority,
        opportunityId: j.opportunity_id,
        scope: j.job_scope || null,
        attempts: j.attempts,
        maxAttempts: j.max_attempts,
        runAfter: iso(j.run_after),
        notAfter: iso(j.not_after),
        leaseExpiresAt: iso(j.lease_expires_at),
        leasedBy: j.leased_by,
        heartbeatAt: iso(j.heartbeat_at),
        lastError: j.last_error,
        errorCode: j.error_code,
        createdAt: iso(j.created_at),
        finishedAt: iso(j.finished_at),
      })),
    });
  });

  router.post('/v1/admin/jobs/:id/cancel', ...auth, async (req: Request, res: Response) => {
    const id = Id.parse(req.params.id);
    if (!(await cancelJob(db, id))) {
      throw new HttpError(409, 'not_active', 'Only a waiting or running job can be cancelled');
    }
    await audit(actorOf(res).userId, 'workflow.job_cancel', 'job', id);
    res.json({ id, status: 'cancelled' });
  });

  router.post('/v1/admin/jobs/:id/reprioritise', ...auth, async (req: Request, res: Response) => {
    const id = Id.parse(req.params.id);
    const { priority } = Reprioritise.parse(req.body);
    const done = await db.jobs.updateMany({ where: { id, status: 'queued' }, data: { priority } });
    if (done.count !== 1) {
      throw new HttpError(409, 'not_queued', 'Only a waiting job can be reprioritised');
    }
    await audit(actorOf(res).userId, 'workflow.job_reprioritise', 'job', id, { priority });
    res.json({ id, priority });
  });

  // What an opportunity is doing and why: its status history and every job it has had.
  router.get('/v1/opportunities/:id/workflow', ...auth, async (req: Request, res: Response) => {
    const id = Id.parse(req.params.id);
    const opp = await db.post_opportunities.findUnique({ where: { id } });
    if (!opp) throw new HttpError(404, 'not_found', 'No such opportunity');
    const [events, jobs] = await Promise.all([
      db.opportunity_events.findMany({ where: { opportunity_id: id }, orderBy: { seq: 'asc' } }),
      db.jobs.findMany({ where: { opportunity_id: id }, orderBy: { created_at: 'asc' } }),
    ]);
    res.json({
      opportunityId: id,
      status: opp.status,
      failedStep: opp.failed_step,
      failureReason: opp.failure_reason,
      notAfter: iso(opp.not_after),
      history: events.map((e) => ({
        from: e.from_status,
        to: e.to_status,
        actor: e.actor,
        reason: e.reason,
        at: iso(e.created_at),
      })),
      jobs: jobs.map((j) => ({
        id: j.id,
        kind: j.kind,
        scope: j.job_scope || null,
        status: j.status,
        attempts: j.attempts,
        maxAttempts: j.max_attempts,
        errorCode: j.error_code,
        lastError: j.last_error,
        createdAt: iso(j.created_at),
        finishedAt: iso(j.finished_at),
      })),
    });
  });

  // Retry a failed opportunity from the step that failed.
  router.post('/v1/admin/opportunities/:id/retry', ...auth, async (req: Request, res: Response) => {
    const id = Id.parse(req.params.id);
    try {
      res.json(await resumeOpportunity(db, id, `user:${actorOf(res).userId}`));
    } catch (err) {
      if (err instanceof ResumeError) {
        throw new HttpError(err.code === 'not_found' ? 404 : 409, err.code, err.message);
      }
      throw err;
    }
  });

  return router;
}
