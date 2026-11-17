import { Router, type Request, type Response } from 'express';
import type { Prisma } from '@prisma/client';
import type { Channel, PublishMode } from '@smb/shared';
import { actorOf, authenticate, requireRole, type TokenVerifier } from '../../auth/index.js';
import { HttpError } from '../errors.js';
import { idempotencyKey } from '../idempotency.js';
import {
  ListPublicationsQuery,
  PublicationIdParam,
  ResolvePublicationBody,
  RetryPublicationBody,
} from '../../publishing/schemas.js';
import { PublishDeps, reconcilePublication, settleOpportunity } from '../../publishing/service.js';
import { publisherFor } from '../../publishing/registry.js';

export interface PublicationRouteDeps {
  verifier: TokenVerifier | undefined;
  publishing: PublishDeps;
}

export function publicationsRouter(deps: PublicationRouteDeps): Router {
  const router = Router();
  const auth = [authenticate(deps.verifier), requireRole('admin')];
  const { db } = deps.publishing;

  // 1. GET /v1/publications - list publications with filters
  router.get('/v1/publications', ...auth, async (req: Request, res: Response) => {
    const query = ListPublicationsQuery.parse(req.query);
    const where: Prisma.publicationsWhereInput = {};

    if (query.status) where.status = query.status;
    if (query.channel) where.channel = query.channel;
    if (query.before) where.created_at = { lt: new Date(query.before) };

    const rows = await db.publications.findMany({
      where,
      include: {
        review_actions: {
          include: {
            post_opportunities: true,
          },
        },
      },
      orderBy: { created_at: 'desc' },
      take: query.limit,
    });

    const publications = rows.map((p) => {
      const opp = p.review_actions.post_opportunities;
      const needsAttention =
        (p.status === 'uncertain' && p.retry_after === null) || p.status === 'failed';
      return {
        id: p.id,
        opportunityId: opp.id,
        postTypeId: opp.post_type_id,
        channel: p.channel,
        mode: p.mode,
        status: p.status,
        scheduledFor: p.scheduled_for?.toISOString() ?? null,
        url: p.url,
        lastError: p.last_error,
        attemptCount: p.attempt_count,
        lookupCount: p.lookup_count,
        needsAttention,
        createdAt: p.created_at.toISOString(),
        updatedAt: p.updated_at.toISOString(),
      };
    });

    res.json({ publications });
  });

  // 2. GET /v1/publications/:id - one publication with attempts
  router.get('/v1/publications/:id', ...auth, async (req: Request, res: Response) => {
    const { id } = PublicationIdParam.parse(req.params);

    const pub = await db.publications.findUnique({
      where: { id },
      include: {
        publication_attempts: {
          orderBy: { attempt_no: 'asc' },
        },
        review_actions: {
          include: {
            post_opportunities: true,
          },
        },
      },
    });

    if (!pub) {
      throw new HttpError(404, 'not_found', 'Publication not found');
    }

    const opp = pub.review_actions.post_opportunities;
    const needsAttention =
      (pub.status === 'uncertain' && pub.retry_after === null) || pub.status === 'failed';

    res.json({
      publication: {
        id: pub.id,
        opportunityId: opp.id,
        postTypeId: opp.post_type_id,
        channel: pub.channel,
        mode: pub.mode,
        status: pub.status,
        scheduledFor: pub.scheduled_for?.toISOString() ?? null,
        url: pub.url,
        lastError: pub.last_error,
        attemptCount: pub.attempt_count,
        lookupCount: pub.lookup_count,
        needsAttention,
        createdAt: pub.created_at.toISOString(),
        updatedAt: pub.updated_at.toISOString(),
        attempts: pub.publication_attempts.map((a) => ({
          id: a.id,
          attemptNo: a.attempt_no,
          kind: a.kind,
          outcome: a.outcome,
          requestSummary: a.request_summary,
          responseSummary: a.response_summary,
          error: a.error,
          startedAt: a.started_at?.toISOString() ?? null,
          finishedAt: a.finished_at?.toISOString() ?? null,
        })),
      },
    });
  });

  // 3. POST /v1/publications/:id/retry - failed -> pending, attempt_count = 0
  router.post('/v1/publications/:id/retry', ...auth, async (req: Request, res: Response) => {
    const { id } = PublicationIdParam.parse(req.params);
    const body = RetryPublicationBody.parse(req.body);
    const key = idempotencyKey(req);
    const actor = actorOf(res);

    const pub = await db.publications.findUnique({
      where: { id },
      include: {
        review_actions: {
          include: {
            post_opportunities: true,
          },
        },
      },
    });

    if (!pub) {
      throw new HttpError(404, 'not_found', 'Publication not found');
    }

    if (pub.status !== 'failed') {
      throw new HttpError(
        409,
        'wrong_status',
        `Publication status is '${pub.status}'; only 'failed' publications can be retried`,
      );
    }

    const at = deps.publishing.now ? deps.publishing.now() : new Date();

    await db.$transaction(async (tx) => {
      await tx.publications.update({
        where: { id },
        data: {
          status: 'pending',
          retry_after: at,
          attempt_count: 0,
          last_error: null,
        },
      });

      const opp = pub.review_actions.post_opportunities;
      if (opp.status === 'failed' || opp.status === 'partially_published') {
        await tx.$executeRaw`select set_config('smb.actor', ${actor.userId}, true), set_config('smb.reason', 'publication retried', true)`;
        await tx.post_opportunities.update({
          where: { id: opp.id },
          data: { status: 'approved' },
        });
      }

      await tx.audit_log.create({
        data: {
          actor: actor.userId,
          action: 'publication.retry',
          target_type: 'publication',
          target_id: id,
          details: { reason: body.reason, idempotencyKey: key ?? null },
        },
      });
    });

    res.json({
      publication: {
        id,
        status: 'pending',
        attemptCount: 0,
        retryAfter: at.toISOString(),
      },
    });
  });

  // 4. POST /v1/publications/:id/reconcile - runs reconcilePublication for uncertain
  router.post('/v1/publications/:id/reconcile', ...auth, async (req: Request, res: Response) => {
    const { id } = PublicationIdParam.parse(req.params);

    const pub = await db.publications.findUnique({ where: { id } });
    if (!pub) {
      throw new HttpError(404, 'not_found', 'Publication not found');
    }

    if (pub.status !== 'uncertain') {
      throw new HttpError(
        409,
        'wrong_status',
        `Publication status is '${pub.status}'; only 'uncertain' publications can be reconciled`,
      );
    }

    // Reset retry_after to now so reconcilePublication runs immediately
    const at = deps.publishing.now ? deps.publishing.now() : new Date();
    await db.publications.update({
      where: { id },
      data: { retry_after: at },
    });

    const outcome = await reconcilePublication(deps.publishing, id);
    res.json({ outcome });
  });

  // 5. POST /v1/publications/:id/resolve - human decision for uncertain
  router.post('/v1/publications/:id/resolve', ...auth, async (req: Request, res: Response) => {
    const { id } = PublicationIdParam.parse(req.params);
    const body = ResolvePublicationBody.parse(req.body);
    const key = idempotencyKey(req);
    const actor = actorOf(res);

    const pub = await db.publications.findUnique({
      where: { id },
      include: {
        review_actions: {
          include: {
            post_opportunities: true,
          },
        },
      },
    });

    if (!pub) {
      throw new HttpError(404, 'not_found', 'Publication not found');
    }

    if (pub.status !== 'uncertain') {
      throw new HttpError(
        409,
        'wrong_status',
        `Publication status is '${pub.status}'; only 'uncertain' publications can be resolved`,
      );
    }

    const at = deps.publishing.now ? deps.publishing.now() : new Date();

    if (body.outcome === 'published') {
      // If a publisher adapter is configured, verify with getStatus
      try {
        const adapter = publisherFor(
          pub.mode as PublishMode,
          pub.channel as Channel,
          deps.publishing.publishers,
        );
        const status = await adapter.getStatus(body.externalId);
        if (status === 'deleted') {
          throw new HttpError(
            422,
            'post_deleted',
            `Post ${body.externalId} was not found or is deleted on ${pub.channel}`,
          );
        }
      } catch (err: unknown) {
        if (err instanceof HttpError) throw err;
        // Other errors (e.g. publisher not configured or getStatus network error) are tolerated in resolution
      }

      const defaultUrl =
        pub.channel === 'x'
          ? `https://x.com/smb_bot/status/${body.externalId}`
          : `https://example.org/${pub.channel}/${body.externalId}`;
      const url = body.url ?? defaultUrl;

      await db.$transaction(async (tx) => {
        await tx.publications.update({
          where: { id },
          data: {
            status: 'published',
            external_id: body.externalId,
            url,
            published_at: at,
            last_error: null,
            retry_after: null,
          },
        });

        const maxAttempt = await tx.publication_attempts.aggregate({
          where: { publication_id: id },
          _max: { attempt_no: true },
        });
        await tx.publication_attempts.create({
          data: {
            publication_id: id,
            attempt_no: (maxAttempt._max.attempt_no ?? 0) + 1,
            kind: 'manual',
            outcome: 'manual',
            request_summary: {},
            response_summary: { outcome: 'published', externalId: body.externalId, url },
            job_id: null,
            started_at: at,
            finished_at: at,
          },
        });

        await tx.audit_log.create({
          data: {
            actor: actor.userId,
            action: 'publication.resolve',
            target_type: 'publication',
            target_id: id,
            details: {
              outcome: 'published',
              externalId: body.externalId,
              url,
              idempotencyKey: key ?? null,
            },
          },
        });

        await settleOpportunity(tx, pub.review_actions.opportunity_id, at);
      });

      res.json({
        publication: {
          id,
          status: 'published',
          externalId: body.externalId,
          url,
          publishedAt: at.toISOString(),
        },
      });
      return;
    }

    if (body.outcome === 'not_published') {
      await db.$transaction(async (tx) => {
        await tx.publications.update({
          where: { id },
          data: {
            status: 'pending',
            retry_after: at,
            last_error: body.reason,
          },
        });

        const maxAttempt = await tx.publication_attempts.aggregate({
          where: { publication_id: id },
          _max: { attempt_no: true },
        });
        await tx.publication_attempts.create({
          data: {
            publication_id: id,
            attempt_no: (maxAttempt._max.attempt_no ?? 0) + 1,
            kind: 'manual',
            outcome: 'manual',
            request_summary: {},
            response_summary: { outcome: 'not_published', reason: body.reason },
            error: body.reason,
            job_id: null,
            started_at: at,
            finished_at: at,
          },
        });

        await tx.audit_log.create({
          data: {
            actor: actor.userId,
            action: 'publication.resolve',
            target_type: 'publication',
            target_id: id,
            details: { outcome: 'not_published', reason: body.reason, idempotencyKey: key ?? null },
          },
        });

        await settleOpportunity(tx, pub.review_actions.opportunity_id, at);
      });

      res.json({
        publication: {
          id,
          status: 'pending',
          retryAfter: at.toISOString(),
        },
      });
      return;
    }

    // outcome === 'abandon'
    await db.$transaction(async (tx) => {
      await tx.publications.update({
        where: { id },
        data: {
          status: 'failed',
          retry_after: null,
          last_error: body.reason,
        },
      });

      const maxAttempt = await tx.publication_attempts.aggregate({
        where: { publication_id: id },
        _max: { attempt_no: true },
      });
      await tx.publication_attempts.create({
        data: {
          publication_id: id,
          attempt_no: (maxAttempt._max.attempt_no ?? 0) + 1,
          kind: 'manual',
          outcome: 'manual',
          request_summary: {},
          response_summary: { outcome: 'abandon', reason: body.reason },
          error: body.reason,
          job_id: null,
          started_at: at,
          finished_at: at,
        },
      });

      await tx.audit_log.create({
        data: {
          actor: actor.userId,
          action: 'publication.resolve',
          target_type: 'publication',
          target_id: id,
          details: { outcome: 'abandon', reason: body.reason, idempotencyKey: key ?? null },
        },
      });

      await settleOpportunity(tx, pub.review_actions.opportunity_id, at);
    });

    res.json({
      publication: {
        id,
        status: 'failed',
        lastError: body.reason,
      },
    });
  });

  return router;
}
