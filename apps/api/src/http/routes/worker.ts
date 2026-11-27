import type { PrismaClient } from '@prisma/client';
import { Router, type Request, type Response } from 'express';
import type { Logger } from 'pino';
import { z } from 'zod';
import {
  ClaimRequest,
  CompleteRequest,
  FailRequest,
  HeartbeatRequest,
  WorkerPairRequest,
  WorkerStatusRequest,
} from '@smb/shared';
import type { Env } from '../../env.js';
import type { WorkflowDeps } from '../../workflow/types.js';
import {
  PairingError,
  WorkerProtocolError,
  authenticateWorker,
  claimWorkerJob,
  completeWorkerJob,
  failWorkerJob,
  getWorkerConfig,
  heartbeatWorkerJob,
  pairWorker,
  recordWorkerStatus,
  workerOf,
} from '../../workers/index.js';
import { HttpError } from '../errors.js';
import { FixedWindowRateLimiter, rateLimitMiddleware } from '../rate-limit.js';
import { requireHttps } from '../security.js';

export interface WorkerRouteDeps {
  db: PrismaClient;
  workflow: WorkflowDeps;
  env: Env;
  logger: Logger;
  now?: () => Date;
  rateLimits?: {
    pairPerIp?: FixedWindowRateLimiter;
    pairGlobal?: FixedWindowRateLimiter;
    perWorker?: FixedWindowRateLimiter;
  };
}

const JobIdParam = z.object({ id: z.string().uuid() });

function translate(err: unknown): never {
  if (err instanceof PairingError) {
    throw new HttpError(err.status, err.code, err.message);
  }
  if (err instanceof WorkerProtocolError) {
    throw new HttpError(err.status, err.code, err.message, err.details);
  }
  throw err;
}

/**
 * Worker device API (`/worker/v1/*`, docs/ARCHITECTURE.md section 6).
 * Order: HTTPS check -> pairing rate limits -> authenticateWorker -> per-worker rate limit.
 */
export function workerRouter(deps: WorkerRouteDeps): Router {
  const router = Router();
  const { db, env, workflow } = deps;
  const at = () => (deps.now ? deps.now() : new Date());
  const protocolDeps = { db, workflow, env, now: deps.now };

  const pairPerIp =
    deps.rateLimits?.pairPerIp ?? new FixedWindowRateLimiter({ max: 5, windowMs: 60_000 });
  const pairGlobal =
    deps.rateLimits?.pairGlobal ?? new FixedWindowRateLimiter({ max: 50, windowMs: 3600_000 });
  const perWorker =
    deps.rateLimits?.perWorker ?? new FixedWindowRateLimiter({ max: 120, windowMs: 60_000 });

  router.use('/worker/v1', requireHttps(env.SMB_REQUIRE_HTTPS));

  router.post(
    '/worker/v1/pair',
    rateLimitMiddleware(pairPerIp, (req) => req.ip ?? 'unknown'),
    rateLimitMiddleware(pairGlobal, () => 'global'),
    async (req: Request, res: Response) => {
      const body = WorkerPairRequest.parse(req.body);
      try {
        const result = await pairWorker(db, body, at());
        res.status(201).json(result);
      } catch (err) {
        translate(err);
      }
    },
  );

  const workerAuth = [
    authenticateWorker(db, deps.now),
    rateLimitMiddleware(perWorker, (_req, res) => workerOf(res).id),
  ];

  router.post('/worker/v1/status', ...workerAuth, async (req: Request, res: Response) => {
    const body = WorkerStatusRequest.parse(req.body);
    const desired = await recordWorkerStatus(db, env, workerOf(res), body, at());
    res.json(desired);
  });

  router.get('/worker/v1/config', ...workerAuth, (_req: Request, res: Response) => {
    res.json(getWorkerConfig(env, workerOf(res)));
  });

  router.post('/worker/v1/jobs/claim', ...workerAuth, async (req: Request, res: Response) => {
    const body = ClaimRequest.parse(req.body);
    try {
      const claimed = await claimWorkerJob(protocolDeps, workerOf(res), body, at());
      if (!claimed) {
        res.status(204).end();
        return;
      }
      res.json(claimed);
    } catch (err) {
      translate(err);
    }
  });

  router.post(
    '/worker/v1/jobs/:id/heartbeat',
    ...workerAuth,
    async (req: Request, res: Response) => {
      const { id } = JobIdParam.parse(req.params);
      const body = HeartbeatRequest.parse(req.body);
      try {
        res.json(await heartbeatWorkerJob(protocolDeps, workerOf(res).id, id, body, at()));
      } catch (err) {
        translate(err);
      }
    },
  );

  router.post(
    '/worker/v1/jobs/:id/complete',
    ...workerAuth,
    async (req: Request, res: Response) => {
      const { id } = JobIdParam.parse(req.params);
      const body = CompleteRequest.parse(req.body);
      try {
        res.json(await completeWorkerJob(protocolDeps, workerOf(res).id, id, body, at()));
      } catch (err) {
        translate(err);
      }
    },
  );

  router.post('/worker/v1/jobs/:id/fail', ...workerAuth, async (req: Request, res: Response) => {
    const { id } = JobIdParam.parse(req.params);
    const body = FailRequest.parse(req.body);
    try {
      res.json(await failWorkerJob(protocolDeps, workerOf(res).id, id, body, at()));
    } catch (err) {
      translate(err);
    }
  });

  return router;
}
