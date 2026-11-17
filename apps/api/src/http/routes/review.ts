import { Router } from 'express';
import { actorOf, authenticate, requireRole, type TokenVerifier } from '../../auth/index.js';
import {
  ActionBody,
  ApproveBody,
  EditBody,
  IdParam,
  QueueQuery,
  ReviewError,
  ReviewNotFoundError,
  ReviseBody,
  approveRevision,
  editCandidate,
  opportunityDetail,
  requestRevision,
  reviewQueue,
  transitionOpportunity,
  type ActionContext,
  type ReviewContext,
  type ReviewTransition,
} from '../../review/index.js';
import { HttpError } from '../errors.js';
import { idempotencyKey } from '../idempotency.js';

export interface ReviewRouteDeps {
  verifier: TokenVerifier | undefined;
  read: ReviewContext;
  act: ActionContext;
}

/** Turns the review module's refusals into the API's one error shape. */
function translate(err: unknown): never {
  if (err instanceof ReviewError)
    throw new HttpError(err.status, err.code, err.message, err.details);
  if (err instanceof ReviewNotFoundError) throw new HttpError(404, 'not_found', err.message);
  throw err;
}

/**
 * The reviewer API (docs/ARCHITECTURE.md section 7). Every route needs a valid XLChess token carrying a
 * reviewer or administrator role.
 */
export function reviewRouter({ verifier, read, act }: ReviewRouteDeps): Router {
  const r = Router();
  r.use('/v1/review', authenticate(verifier), requireRole('reviewer', 'admin'));
  r.use('/v1/opportunities', authenticate(verifier), requireRole('reviewer', 'admin'));
  r.use('/v1/candidates', authenticate(verifier), requireRole('reviewer', 'admin'));
  r.use('/v1/revisions', authenticate(verifier), requireRole('reviewer', 'admin'));

  r.get('/v1/review/queue', async (req, res) => {
    const q = QueueQuery.parse(req.query);
    res.json({ items: await reviewQueue(read.db, q) });
  });

  r.get('/v1/opportunities/:id', async (req, res) => {
    const { id } = IdParam.parse(req.params);
    try {
      res.json(await opportunityDetail(read, id));
    } catch (err) {
      translate(err);
    }
  });

  r.post('/v1/candidates/:id/revisions', async (req, res) => {
    const { id } = IdParam.parse(req.params);
    const body = EditBody.parse(req.body);
    try {
      const result = await editCandidate(act, { userId: actorOf(res).userId }, id, body);
      res.status(201).json(result);
    } catch (err) {
      translate(err);
    }
  });

  // Ask the model to rewrite this candidate from the reviewer's feedback (module 1.12).
  r.post('/v1/candidates/:id/revise', async (req, res) => {
    const { id } = IdParam.parse(req.params);
    const body = ReviseBody.parse(req.body);
    const key = idempotencyKey(req);
    try {
      const result = await requestRevision(act, { userId: actorOf(res).userId }, id, {
        ...body,
        idempotencyKey: key,
      });
      res.status(result.replayed ? 200 : 202).json(result);
    } catch (err) {
      translate(err);
    }
  });

  r.post('/v1/revisions/:id/approve', async (req, res) => {
    const { id } = IdParam.parse(req.params);
    const body = ApproveBody.parse(req.body);
    const key = idempotencyKey(req);
    try {
      const result = await approveRevision(
        act,
        { userId: actorOf(res).userId },
        {
          revisionId: id,
          contentHash: body.contentHash,
          channels: body.channels,
          scheduledFor: body.scheduledFor,
          acknowledgeFailedChecks: body.acknowledgeFailedChecks,
          idempotencyKey: key,
        },
      );
      res.status(result.replayed ? 200 : 201).json(result);
    } catch (err) {
      translate(err);
    }
  });

  const transitions: [string, ReviewTransition][] = [
    ['reject', 'reject'],
    ['defer', 'defer'],
    ['regenerate', 'regenerate'],
    ['request-research', 'request_research'],
    ['reopen', 'reopen'],
  ];
  for (const [path, kind] of transitions) {
    r.post(`/v1/opportunities/:id/${path}`, async (req, res) => {
      const { id } = IdParam.parse(req.params);
      const body = ActionBody.parse(req.body ?? {});
      const key = idempotencyKey(req);
      try {
        const result = await transitionOpportunity(act, { userId: actorOf(res).userId }, id, kind, {
          ...body,
          idempotencyKey: key,
        });
        res.status(result.replayed ? 200 : 201).json(result);
      } catch (err) {
        translate(err);
      }
    });
  }
  return r;
}
