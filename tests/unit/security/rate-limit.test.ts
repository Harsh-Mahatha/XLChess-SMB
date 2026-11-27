import { describe, expect, it } from 'vitest';
import { FixedWindowRateLimiter } from '../../../apps/api/src/http/rate-limit.js';

describe('FixedWindowRateLimiter', () => {
  it('counts requests, blocks past max with Retry-After, and resets after the window', () => {
    let now = 1_000_000;
    const limiter = new FixedWindowRateLimiter({
      max: 3,
      windowMs: 60_000,
      now: () => now,
    });
    try {
      expect(limiter.check('ip-1')).toMatchObject({ allowed: true, remaining: 2 });
      now += 10_000;
      expect(limiter.check('ip-1')).toMatchObject({ allowed: true, remaining: 1 });
      now += 10_000;
      expect(limiter.check('ip-1')).toMatchObject({ allowed: true, remaining: 0 });

      const blocked = limiter.check('ip-1');
      expect(blocked.allowed).toBe(false);
      expect(blocked.retryAfterSeconds).toBe(40);

      // Different key is independent.
      expect(limiter.check('ip-2').allowed).toBe(true);

      // Window resets after expiry.
      now += 40_001;
      expect(limiter.check('ip-1')).toMatchObject({ allowed: true, remaining: 2 });
    } finally {
      limiter.stop();
    }
  });
});
