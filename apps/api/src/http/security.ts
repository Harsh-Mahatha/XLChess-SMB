import type { RequestHandler } from 'express';
import { HttpError } from './errors.js';

/** Sets baseline security headers on every response and `Cache-Control: no-store` on API routes. */
export function securityHeaders(): RequestHandler {
  return (req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
    if (
      req.path === '/v1' ||
      req.path.startsWith('/v1/') ||
      req.path === '/worker/v1' ||
      req.path.startsWith('/worker/v1/')
    ) {
      res.setHeader('Cache-Control', 'no-store');
    }
    next();
  };
}

/** Refuses non-TLS requests to `/worker/v1/*` when `required` is true (default in production). */
export function requireHttps(required: boolean): RequestHandler {
  return (req, _res, next) => {
    if (required && !req.secure) {
      next(new HttpError(403, 'https_required', 'HTTPS is required for worker endpoints'));
      return;
    }
    next();
  };
}
