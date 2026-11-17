import { describe, expect, it } from 'vitest';
import {
  computeBackoff,
  nextState,
  settleDecision,
} from '../../../apps/api/src/publishing/service.js';
import { PublishError, PublishResult } from '../../../apps/api/src/publishing/types.js';

describe('publishing service pure functions', () => {
  const baseTime = new Date('2026-11-17T12:00:00.000Z');

  describe('computeBackoff', () => {
    it('computes exponential backoff correctly', () => {
      const policy = { backoffSeconds: 60, backoffMultiplier: 2 };

      // Attempt 1: 60 * 2^0 = 60s
      const t1 = computeBackoff(1, policy, baseTime);
      expect(t1.toISOString()).toBe('2026-11-17T12:01:00.000Z');

      // Attempt 2: 60 * 2^1 = 120s
      const t2 = computeBackoff(2, policy, baseTime);
      expect(t2.toISOString()).toBe('2026-11-17T12:02:00.000Z');

      // Attempt 3: 60 * 2^2 = 240s
      const t3 = computeBackoff(3, policy, baseTime);
      expect(t3.toISOString()).toBe('2026-11-17T12:04:00.000Z');
    });
  });

  describe('settleDecision', () => {
    it('returns in_progress when any publication is pending, publishing, or uncertain', () => {
      expect(settleDecision(['pending', 'published'])).toBe('in_progress');
      expect(settleDecision(['publishing', 'published'])).toBe('in_progress');
      expect(settleDecision(['uncertain', 'published'])).toBe('in_progress');
    });

    it('returns published when all publications are published or dry_run_recorded', () => {
      expect(settleDecision(['published'])).toBe('published');
      expect(settleDecision(['dry_run_recorded'])).toBe('published');
      expect(settleDecision(['published', 'dry_run_recorded'])).toBe('published');
    });

    it('returns failed when all publications failed', () => {
      expect(settleDecision(['failed'])).toBe('failed');
      expect(settleDecision(['failed', 'failed'])).toBe('failed');
    });

    it('returns partially_published when some succeeded and some failed', () => {
      expect(settleDecision(['published', 'failed'])).toBe('partially_published');
      expect(settleDecision(['dry_run_recorded', 'failed'])).toBe('partially_published');
    });

    it('returns cancelled when all are cancelled or empty', () => {
      expect(settleDecision(['cancelled'])).toBe('cancelled');
      expect(settleDecision([])).toBe('cancelled');
    });
  });

  describe('nextState', () => {
    const policy = { maxAttempts: 3, backoffSeconds: 60, backoffMultiplier: 2 };

    it('handles successful published and dry_run outcomes', () => {
      const pubResult: PublishResult = {
        kind: 'published',
        externalId: '123',
        url: 'https://x.com/post/123',
        publishedAt: baseTime,
        response: {},
      };
      const resPub = nextState({ attempt_count: 1, mode: 'sandbox' }, pubResult, policy, baseTime);
      expect(resPub.nextStatus).toBe('published');
      expect(resPub.outcome).toBe('success');
      expect(resPub.retryAfter).toBeNull();

      const dryResult: PublishResult = { kind: 'dry_run', request: {} };
      const resDry = nextState({ attempt_count: 1, mode: 'dry_run' }, dryResult, policy, baseTime);
      expect(resDry.nextStatus).toBe('dry_run_recorded');
      expect(resDry.outcome).toBe('dry_run');
    });

    it('handles before_send: retries with backoff until maxAttempts, then fails', () => {
      const err = new PublishError('before_send', 'net_err', 'Network error');

      const attempt1 = nextState({ attempt_count: 1, mode: 'sandbox' }, err, policy, baseTime);
      expect(attempt1.nextStatus).toBe('pending');
      expect(attempt1.retryAfter).not.toBeNull();
      expect(attempt1.outcome).toBe('failure');

      // Attempt 3 equals maxAttempts -> marks failed
      const attempt3 = nextState({ attempt_count: 3, mode: 'sandbox' }, err, policy, baseTime);
      expect(attempt3.nextStatus).toBe('failed');
      expect(attempt3.retryAfter).toBeNull();
    });

    it('handles rate_limited: stays pending with retryAt and decrements attempt count', () => {
      const retryAt = new Date('2026-11-17T12:15:00.000Z');
      const err = new PublishError('rate_limited', 'rate_limited', 'Too many requests', retryAt);

      const res = nextState({ attempt_count: 2, mode: 'sandbox' }, err, policy, baseTime);
      expect(res.nextStatus).toBe('pending');
      expect(res.retryAfter).toEqual(retryAt);
      expect(res.attemptDelta).toBe(-1);
      expect(res.outcome).toBe('rate_limited');
    });

    it('handles uncertain: sets status to uncertain and schedules reconcile after delay', () => {
      const err = new PublishError('uncertain', 'create_uncertain', 'Timeout');
      const res = nextState({ attempt_count: 1, mode: 'sandbox' }, err, policy, baseTime);
      expect(res.nextStatus).toBe('uncertain');
      expect(res.retryAfter?.getTime()).toBe(baseTime.getTime() + 60_000);
      expect(res.outcome).toBe('timeout');

      // 403 duplicate content outcome
      const errDup = new PublishError('uncertain', 'duplicate_content', 'Duplicate');
      const resDup = nextState({ attempt_count: 1, mode: 'sandbox' }, errDup, policy, baseTime);
      expect(resDup.nextStatus).toBe('uncertain');
      expect(resDup.outcome).toBe('refused');
    });

    it('handles permanent: marks failed immediately with no retry', () => {
      const err = new PublishError('permanent', 'x_refused', 'Bad request');
      const res = nextState({ attempt_count: 1, mode: 'sandbox' }, err, policy, baseTime);
      expect(res.nextStatus).toBe('failed');
      expect(res.retryAfter).toBeNull();
      expect(res.outcome).toBe('refused');
    });

    it('treats unknown unexpected bugs as uncertain', () => {
      const bug = new TypeError('Cannot read property of undefined');
      const res = nextState({ attempt_count: 1, mode: 'sandbox' }, bug, policy, baseTime);
      expect(res.nextStatus).toBe('uncertain');
      expect(res.outcome).toBe('timeout');
      expect(res.retryAfter).not.toBeNull();
    });
  });
});
