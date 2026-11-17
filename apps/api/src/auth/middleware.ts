import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { HttpError } from '../http/errors.js';
import { AuthError, type Actor, type SmbRole, type TokenVerifier } from './verify.js';

/** The signed-in person for this request. Only valid after `authenticate` has run. */
export function actorOf(res: Response): Actor {
  const actor = res.locals['actor'] as Actor | undefined;
  if (!actor) throw new HttpError(500, 'internal_error', 'No signed-in actor on this request');
  return actor;
}

/**
 * Checks the `Authorization: Bearer <XLChess token>` header. A worker's opaque device token is not a valid
 * token here, so a worker can never reach /v1.
 */
export function authenticate(verifier: TokenVerifier | undefined): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!verifier) {
        throw new AuthError(503, 'auth_not_configured', 'Reviewer sign-in is not configured');
      }
      const header = req.header('authorization') ?? '';
      const match = /^Bearer\s+(\S+)$/i.exec(header);
      if (!match) throw new AuthError(401, 'invalid_token', 'Send Authorization: Bearer <token>');
      res.locals['actor'] = await verifier.verify(match[1]!);
      next();
    } catch (err) {
      if (err instanceof AuthError) next(new HttpError(err.status, err.code, err.message));
      else next(err);
    }
  };
}

/** Lets through only the listed roles. Reviewer routes list both; administrator routes list `admin`. */
export function requireRole(...roles: SmbRole[]): RequestHandler {
  return (_req, res, next) => {
    const actor = actorOf(res);
    if (!roles.includes(actor.role)) {
      next(new HttpError(403, 'forbidden', 'Your role may not do this'));
      return;
    }
    next();
  };
}
