import { createHash, randomUUID } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { ResearchSubject } from '@smb/shared';
import type { Logger } from 'pino';
import { z } from 'zod';
import { actorOf, authenticate, requireRole, type TokenVerifier } from '../../auth/index.js';
import { HttpError } from '../errors.js';
import { idempotencyKey } from '../idempotency.js';
import type { ContextResolvers } from '../../scheduling/context.js';
import { suspendSchedules, resumeSchedules } from '../../scheduling/holds.js';
import { openManualOpportunity } from '../../scheduling/open.js';

export interface SchedulingRouteDeps {
  verifier?: TokenVerifier;
  db: PrismaClient;
  resolvers: ContextResolvers;
  logger: Logger;
}

const ListSchedulesQuery = z.object({
  postTypeId: z.string().optional(),
});

const SuspendScheduleBody = z.object({
  postTypeId: z.string().min(1),
  until: z.string().datetime().optional(),
  reason: z.string().trim().min(3).max(300),
});

const ResumeScheduleBody = z.object({
  postTypeId: z.string().min(1),
});

const TriggerOutcomeEnum = z.enum([
  'created',
  'duplicate',
  'refused',
  'missed_coalesced',
  'missed_expired',
  'rule_inactive',
  'rule_active',
  'error',
]);

const ListLogQuery = z.object({
  postTypeId: z.string().optional(),
  outcome: TriggerOutcomeEnum.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.string().datetime().optional(),
});

const DNumber = z.string().regex(/^D\d+$/);

const ManualOpportunityBody = z.object({
  postTypeId: z.string().min(1),
  reason: z.string().trim().min(3).max(300),
  phase: z.string().min(1).optional(),
  eventRefs: z.record(DNumber, z.string().min(1)).optional(),
  gameRef: z
    .object({
      sourceId: z.string().min(1),
      externalId: z.string().min(1),
    })
    .optional(),
  scheduledFor: z.string().datetime().optional(),
});

export function schedulingRouter(deps: SchedulingRouteDeps): Router {
  const router = Router();
  const auth = [authenticate(deps.verifier), requireRole('admin')];
  const { db } = deps;

  // 1. GET /v1/schedules - list schedules and holds
  router.get('/v1/schedules', ...auth, async (req: Request, res: Response) => {
    const query = ListSchedulesQuery.parse(req.query);
    const where: Prisma.schedulesWhereInput = {};
    const holdWhere: Prisma.schedule_holdsWhereInput = {};

    if (query.postTypeId) {
      where.post_type_id = query.postTypeId;
      holdWhere.post_type_id = query.postTypeId;
    }

    const [schedulesRows, holdsRows] = await Promise.all([
      db.schedules.findMany({
        where,
        orderBy: [{ post_type_id: 'asc' }, { rule_key: 'asc' }],
      }),
      db.schedule_holds.findMany({
        where: holdWhere,
        orderBy: { post_type_id: 'asc' },
      }),
    ]);

    const schedules = schedulesRows.map((s) => ({
      postTypeId: s.post_type_id,
      ruleKey: s.rule_key,
      phaseId: s.phase_id,
      timezone: s.timezone,
      state: s.state,
      inactiveReason: s.inactive_reason,
      cursorAt: s.cursor_at.toISOString(),
      nextRunAt: s.next_run_at ? s.next_run_at.toISOString() : null,
      lastSlotAt: s.last_slot_at ? s.last_slot_at.toISOString() : null,
      lastOpportunityId: s.last_opportunity_id,
      lastOutcome: s.last_outcome,
    }));

    const holds = holdsRows.map((h) => ({
      postTypeId: h.post_type_id,
      suspendedUntil: h.suspended_until ? h.suspended_until.toISOString() : null,
      reason: h.reason,
      createdBy: h.created_by,
      createdAt: h.created_at.toISOString(),
    }));

    res.json({ schedules, holds });
  });

  // 2. POST /v1/schedules/suspend - suspend recurring schedules
  router.post('/v1/schedules/suspend', ...auth, async (req: Request, res: Response) => {
    const body = SuspendScheduleBody.parse(req.body);
    const actor = actorOf(res).userId;
    const until = body.until ? new Date(body.until) : undefined;

    if (until && until.getTime() <= Date.now()) {
      throw new HttpError(400, 'invalid_until', 'Suspension "until" must be in the future');
    }

    const hold = await suspendSchedules(db, {
      postTypeId: body.postTypeId,
      until,
      reason: body.reason,
      actor,
    });

    res.json({
      postTypeId: hold.postTypeId,
      suspendedUntil: hold.suspendedUntil ? hold.suspendedUntil.toISOString() : null,
      reason: hold.reason,
      createdBy: hold.createdBy,
    });
  });

  // 3. POST /v1/schedules/resume - resume recurring schedules
  router.post('/v1/schedules/resume', ...auth, async (req: Request, res: Response) => {
    const body = ResumeScheduleBody.parse(req.body);
    const actor = actorOf(res).userId;

    const resumed = await resumeSchedules(db, {
      postTypeId: body.postTypeId,
      actor,
    });

    if (!resumed) {
      throw new HttpError(
        404,
        'hold_not_found',
        `No active schedule hold found for post type "${body.postTypeId}"`,
      );
    }

    res.json({ resumed: true, postTypeId: body.postTypeId });
  });

  // 4. GET /v1/scheduler/log - query trigger log (newest first)
  router.get('/v1/scheduler/log', ...auth, async (req: Request, res: Response) => {
    const query = ListLogQuery.parse(req.query);
    const where: Prisma.trigger_logWhereInput = {};

    if (query.postTypeId) where.post_type_id = query.postTypeId;
    if (query.outcome) where.outcome = query.outcome;
    if (query.before) where.at = { lt: new Date(query.before) };

    const rows = await db.trigger_log.findMany({
      where,
      orderBy: { at: 'desc' },
      take: query.limit,
    });

    const log = rows.map((l) => ({
      id: String(l.id),
      at: l.at.toISOString(),
      postTypeId: l.post_type_id,
      triggerKind: l.trigger_kind,
      outcome: l.outcome,
      ruleKey: l.rule_key,
      slotAt: l.slot_at ? l.slot_at.toISOString() : null,
      dedupeKey: l.dedupe_key,
      opportunityId: l.opportunity_id,
      reason: l.reason,
      detail: l.detail,
    }));

    res.json({ log });
  });

  // 5. POST /v1/opportunities/manual - create manual posting opportunity
  router.post('/v1/opportunities/manual', ...auth, async (req: Request, res: Response) => {
    const body = ManualOpportunityBody.parse(req.body);
    const actor = actorOf(res).userId;
    const idKey = idempotencyKey(req);
    const requestId = idKey
      ? createHash('sha256').update(idKey).digest('hex').slice(0, 24)
      : randomUUID();

    const subject: ResearchSubject | undefined =
      body.eventRefs !== undefined || body.gameRef !== undefined
        ? {
            eventRefs: body.eventRefs ?? {},
            ...(body.gameRef ? { gameRef: body.gameRef } : {}),
          }
        : undefined;

    const scheduledFor = body.scheduledFor ? new Date(body.scheduledFor) : undefined;

    const result = await openManualOpportunity(
      { db, resolvers: deps.resolvers },
      {
        postTypeId: body.postTypeId,
        requestedBy: actor,
        requestId,
        reason: body.reason,
        phase: body.phase,
        subject,
        scheduledFor,
      },
    );

    if (result.status === 'refused') {
      throw new HttpError(409, result.code, result.message);
    }

    if (result.status === 'created') {
      await db.audit_log.create({
        data: {
          actor,
          action: 'opportunity.manual',
          target_type: 'opportunity',
          target_id: result.opportunityId,
          details: {
            postTypeId: body.postTypeId,
            reason: body.reason,
            dedupeKey: result.dedupeKey,
          },
        },
      });

      res.status(201).json({
        opportunityId: result.opportunityId,
        status: 'created',
      });
      return;
    }

    // Replay with duplicate dedupeKey
    res.status(200).json({
      opportunityId: result.opportunityId,
      status: 'duplicate',
    });
  });

  return router;
}
