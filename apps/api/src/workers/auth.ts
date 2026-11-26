import type { PrismaClient, workers } from '@prisma/client';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { HttpError } from '../http/errors.js';
import { hashToken } from './tokens.js';

const LAST_SEEN_THROTTLE_MS = 30_000;

/** The authenticated worker for this request. Valid only after `authenticateWorker`. */
export function workerOf(res: Response): workers {
  const worker = res.locals['worker'] as workers | undefined;
  if (!worker)
    throw new HttpError(500, 'internal_error', 'No authenticated worker on this request');
  return worker;
}

/**
 * Verifies `Authorization: Bearer smbw_<token>`. Any other token (including XLChess JWTs) is rejected
 * with 401 `invalid_worker_token`. Revoked workers receive 401 `worker_revoked`.
 */
export function authenticateWorker(
  db: PrismaClient,
  now: () => Date = () => new Date(),
): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const header = req.header('authorization') ?? '';
      const match = /^Bearer\s+(\S+)$/i.exec(header);
      const token = match?.[1];
      if (!token || !token.startsWith('smbw_')) {
        throw new HttpError(401, 'invalid_worker_token', 'Invalid or missing worker device token');
      }

      const worker = await db.workers.findUnique({ where: { token_hash: hashToken(token) } });
      if (!worker) {
        throw new HttpError(401, 'invalid_worker_token', 'Invalid or missing worker device token');
      }
      if (worker.revoked_at !== null) {
        throw new HttpError(401, 'worker_revoked', 'This worker device token has been revoked');
      }

      const at = now();
      if (
        !worker.last_seen_at ||
        at.getTime() - worker.last_seen_at.getTime() > LAST_SEEN_THROTTLE_MS
      ) {
        await db.workers.update({
          where: { id: worker.id },
          data: { last_seen_at: at },
        });
      }

      res.locals['worker'] = worker;
      next();
    } catch (err) {
      next(err);
    }
  };
}
