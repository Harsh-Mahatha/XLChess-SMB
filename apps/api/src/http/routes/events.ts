import type { PrismaClient } from '@prisma/client';
import { Router, type Request, type Response } from 'express';
import type { Logger } from 'pino';
import { z } from 'zod';
import { actorOf, authenticate, requireRole, type TokenVerifier } from '../../auth/index.js';
import {
  UnknownDetectorError,
  leaseHeld,
  runEventPoll,
  setDetectorEnabled,
  type DetectorRegistry,
} from '../../events/index.js';
import { HttpError } from '../errors.js';

export interface EventsRouteDeps {
  verifier?: TokenVerifier;
  db: PrismaClient;
  detectors: DetectorRegistry;
  logger: Logger;
  now?: () => Date;
}

export const EVENT_KINDS = [
  'game_completed',
  'round_completed',
  'tournament_started',
  'tournament_completed',
  'rating_list_published',
  'news_published',
] as const;
export const EVENT_STATES = [
  'recorded',
  'opportunity_created',
  'refused',
  'stale_skipped',
  'held',
] as const;

export const ListEventsQuery = z
  .object({
    postTypeId: z.string().min(1).optional(),
    kind: z.enum(EVENT_KINDS).optional(),
    state: z.enum(EVENT_STATES).optional(),
    corrected: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .optional(),
    before: z.string().datetime({ offset: true }).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();
export const EventIdParam = z.object({ id: z.string().uuid() });
export const DetectorIdParam = z.object({ id: z.string().min(1).max(100) });
export const PatchDetectorBody = z.object({ enabled: z.boolean() }).strict();

type EventRow = Awaited<ReturnType<PrismaClient['detected_events']['findFirstOrThrow']>>;

function formatEvent(e: EventRow) {
  return {
    id: e.id,
    identityKey: e.identity_key,
    kind: e.kind,
    postTypeId: e.post_type_id,
    detectorId: e.detector_id,
    version: e.version,
    state: e.state,
    opportunityId: e.opportunity_id,
    refusalCode: e.refusal_code,
    seenCount: e.seen_count,
    firstSeenAt: e.first_seen_at.toISOString(),
    lastSeenAt: e.last_seen_at.toISOString(),
    correctedAt: e.corrected_at?.toISOString() ?? null,
  };
}

/** Admin routes for the event ledger and the detectors (1.16). */
export function eventsRouter(deps: EventsRouteDeps): Router {
  const router = Router();
  const auth = [authenticate(deps.verifier), requireRole('admin')];
  const { db } = deps;
  const now = () => (deps.now ? deps.now() : new Date());

  router.get('/v1/events', ...auth, async (req: Request, res: Response) => {
    const q = ListEventsQuery.parse(req.query);
    const rows = await db.detected_events.findMany({
      where: {
        ...(q.postTypeId ? { post_type_id: q.postTypeId } : {}),
        ...(q.kind ? { kind: q.kind } : {}),
        ...(q.state ? { state: q.state } : {}),
        ...(q.corrected === true ? { version: { gt: 1 } } : {}),
        ...(q.corrected === false ? { version: 1 } : {}),
        ...(q.before ? { first_seen_at: { lt: new Date(q.before) } } : {}),
      },
      orderBy: { first_seen_at: 'desc' },
      take: q.limit,
    });
    res.json({ events: rows.map(formatEvent) });
  });

  router.get('/v1/events/:id', ...auth, async (req: Request, res: Response) => {
    const { id } = EventIdParam.parse(req.params);
    const event = await db.detected_events.findUnique({ where: { id } });
    if (!event) throw new HttpError(404, 'not_found', 'Event not found');
    const [versions, opportunity] = await Promise.all([
      db.detected_event_versions.findMany({
        where: { event_id: id },
        orderBy: { version: 'asc' },
      }),
      event.opportunity_id
        ? db.post_opportunities.findUnique({
            where: { id: event.opportunity_id },
            select: {
              id: true,
              status: true,
              dedupe_key: true,
              trigger_event_id: true,
              trigger_event_version: true,
            },
          })
        : null,
    ]);
    const builtFrom = opportunity?.trigger_event_version ?? null;
    res.json({
      event: { ...formatEvent(event), payload: event.payload },
      versions: versions.map((v) => ({
        version: v.version,
        payload: v.payload,
        reason: v.reason,
        actor: v.actor,
        at: v.at.toISOString(),
      })),
      opportunity: opportunity
        ? {
            id: opportunity.id,
            status: opportunity.status,
            dedupeKey: opportunity.dedupe_key,
            eventVersion: builtFrom,
            /** The opportunity was built from an older version of this event (1.17 re-researches it). */
            stale: builtFrom !== null && builtFrom < event.version,
          }
        : null,
    });
  });

  router.get('/v1/event-pollers', ...auth, async (_req: Request, res: Response) => {
    const rows = await db.event_pollers.findMany({ orderBy: { detector_id: 'asc' } });
    const byId = new Map(rows.map((r) => [r.detector_id, r]));
    const at = now();
    res.json({
      pollers: deps.detectors.list().map((d) => {
        const r = byId.get(d.id);
        return {
          id: d.id,
          postTypeId: d.postTypeId,
          mode: d.mode,
          enabled: r?.enabled ?? true,
          nextDueAt: r?.next_due_at?.toISOString() ?? null,
          lastRunAt: r?.last_run_at?.toISOString() ?? null,
          lastSuccessAt: r?.last_success_at?.toISOString() ?? null,
          lastOutcome: r?.last_outcome ?? null,
          consecutiveFailures: r?.consecutive_failures ?? 0,
          lastError: r?.last_error ?? null,
          running: !!r?.lease_until && r.lease_until >= at,
          leaseHolder: r?.lease_until && r.lease_until >= at ? r.lease_holder : null,
        };
      }),
    });
  });

  router.post('/v1/event-pollers/:id/run', ...auth, async (req: Request, res: Response) => {
    const { id } = DetectorIdParam.parse(req.params);
    if (!deps.detectors.get(id)) throw new HttpError(404, 'not_found', 'Unknown event detector');
    const at = now();
    if (await leaseHeld(db, id, at)) {
      throw new HttpError(409, 'lease_held', 'The detector is already running');
    }
    const summary = await runEventPoll(
      { db, detectors: deps.detectors, logger: deps.logger },
      { now: at, only: id, force: true },
    );
    const result = summary.detectors[0]!;
    if (result.outcome === 'lease_held') {
      throw new HttpError(409, 'lease_held', 'The detector is already running');
    }
    await db.audit_log.create({
      data: {
        actor: actorOf(res).userId,
        action: 'events.detector_run',
        target_type: 'event_poller',
        target_id: id,
        details: { outcome: result.outcome },
      },
    });
    res.json({ result });
  });

  router.patch('/v1/event-pollers/:id', ...auth, async (req: Request, res: Response) => {
    const { id } = DetectorIdParam.parse(req.params);
    const body = PatchDetectorBody.parse(req.body);
    try {
      const row = await setDetectorEnabled(
        { db, detectors: deps.detectors },
        actorOf(res).userId,
        id,
        body.enabled,
      );
      res.json({ poller: { id: row.detector_id, enabled: row.enabled } });
    } catch (err) {
      if (err instanceof UnknownDetectorError) {
        throw new HttpError(404, 'not_found', 'Unknown event detector');
      }
      throw err;
    }
  });

  return router;
}
