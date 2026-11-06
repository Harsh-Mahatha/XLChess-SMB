import type { SourceLimits } from '@smb/shared';
import { SourceError } from './errors.js';
import type { RateLimiter } from './limiter.js';
import type { HttpFetcher, HttpResponse } from './types.js';

export interface HttpOptions {
  sourceId: string;
  limits: SourceLimits;
  limiter: RateLimiter;
  userAgent: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

/** Retry-After in seconds or as an HTTP date. Returns milliseconds, or undefined if absent or unusable. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/**
 * GET with a timeout, retries with exponential backoff and jitter for network errors and 5xx, and a
 * source-wide pause on 429. All failures surface as SourceError; a non-2xx response is never returned.
 */
export function createHttpFetcher(opts: HttpOptions): HttpFetcher {
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = opts.random ?? Math.random;
  const { sourceId, limits } = opts;

  async function attempt(url: string, accept: string): Promise<HttpResponse> {
    let res: Response;
    try {
      res = await doFetch(url, {
        headers: { 'user-agent': opts.userAgent, accept },
        signal: AbortSignal.timeout(limits.timeoutMs),
      });
    } catch (err) {
      throw new SourceError('upstream_unavailable', sourceId, `request to ${url} failed`, {
        cause: err instanceof Error ? err.message : String(err),
      });
    }
    if (res.status === 429) {
      const wait = parseRetryAfter(res.headers.get('retry-after')) ?? limits.rateLimitBackoffMs;
      const pause = Math.max(wait, limits.rateLimitBackoffMs);
      opts.limiter.blockFor(pause);
      throw new SourceError('rate_limited', sourceId, `rate limited by provider (${url})`, {
        retryAfterMs: pause,
      });
    }
    if (res.status === 404) throw new SourceError('not_found', sourceId, `not found: ${url}`);
    if (res.status >= 500) {
      throw new SourceError('upstream_unavailable', sourceId, `HTTP ${res.status} from ${url}`);
    }
    if (!res.ok) {
      throw new SourceError(
        'invalid_response',
        sourceId,
        `unexpected HTTP ${res.status} from ${url}`,
      );
    }
    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      throw new SourceError('upstream_unavailable', sourceId, `reading ${url} failed`, {
        cause: err instanceof Error ? err.message : String(err),
      });
    }
    return { status: res.status, url, text };
  }

  return {
    async get(url, init) {
      const accept = init?.accept ?? 'application/json';
      for (let n = 0; ; n++) {
        try {
          return await opts.limiter.run(() => attempt(url, accept));
        } catch (err) {
          // Outages are retried with backoff. After a 429 the limiter is already paused, so one
          // retry follows the pause; a second 429 is reported to the caller.
          const retriable =
            err instanceof SourceError &&
            (err.code === 'upstream_unavailable' || (err.code === 'rate_limited' && n === 0));
          if (!retriable || n >= limits.maxRetries) throw err;
          if (err.code === 'upstream_unavailable') {
            const base = Math.min(30_000, 500 * 2 ** n);
            await sleep(base + Math.floor(random() * base * 0.25));
          }
        }
      }
    },
  };
}
