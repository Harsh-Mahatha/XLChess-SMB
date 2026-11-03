import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import type { ErrorBody } from '@smb/shared';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export function notFoundHandler(_req: Request, _res: Response, next: NextFunction): void {
  next(new HttpError(404, 'not_found', 'Route not found'));
}

/** Single error shape for the whole API: { error: { code, message, details? } } */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  let status = 500;
  let body: ErrorBody = { error: { code: 'internal_error', message: 'Internal server error' } };

  if (err instanceof HttpError) {
    status = err.status;
    body = { error: { code: err.code, message: err.message, details: err.details } };
  } else if (err instanceof ZodError) {
    status = 400;
    body = { error: { code: 'validation_error', message: 'Invalid request', details: err.issues } };
  } else {
    req.log?.error({ err }, 'unhandled error');
  }
  res.status(status).json(body);
}
