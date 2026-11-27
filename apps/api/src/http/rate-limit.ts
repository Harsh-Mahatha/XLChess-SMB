import type { Request, RequestHandler, Response } from 'express';
import { HttpError } from './errors.js';

export interface RateLimitOptions {
  max: number;
  windowMs: number;
  now?: () => number;
}

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * In-memory fixed-window rate limiter keyed by a caller string (IP, worker id, or global).
 * Per API instance in V1.
 */
export class FixedWindowRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly timer: NodeJS.Timeout;
  private readonly now: () => number;

  constructor(private readonly o: RateLimitOptions) {
    this.now = o.now ?? Date.now;
    this.timer = setInterval(() => this.prune(), Math.max(o.windowMs, 10_000));
    this.timer.unref();
  }

  check(key: string): RateLimitDecision {
    const t = this.now();
    const existing = this.buckets.get(key);
    if (!existing || existing.resetAt <= t) {
      const resetAt = t + this.o.windowMs;
      this.buckets.set(key, { count: 1, resetAt });
      return {
        allowed: true,
        remaining: Math.max(0, this.o.max - 1),
        retryAfterSeconds: Math.ceil(this.o.windowMs / 1000),
      };
    }
    if (existing.count >= this.o.max) {
      const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetAt - t) / 1000));
      return { allowed: false, remaining: 0, retryAfterSeconds };
    }
    existing.count += 1;
    return {
      allowed: true,
      remaining: Math.max(0, this.o.max - existing.count),
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - t) / 1000)),
    };
  }

  prune(): void {
    const t = this.now();
    for (const [k, b] of this.buckets) {
      if (b.resetAt <= t) this.buckets.delete(k);
    }
  }

  stop(): void {
    clearInterval(this.timer);
  }
}

export function rateLimitMiddleware(
  limiter: FixedWindowRateLimiter,
  keyOf: (req: Request, res: Response) => string,
): RequestHandler {
  return (req, res, next) => {
    const decision = limiter.check(keyOf(req, res));
    if (!decision.allowed) {
      res.setHeader('Retry-After', String(decision.retryAfterSeconds));
      next(new HttpError(429, 'rate_limited', 'Too many requests; try again later'));
      return;
    }
    next();
  };
}
