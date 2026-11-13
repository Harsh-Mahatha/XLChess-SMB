import type { ImageSourceEntry, SourcesRegistry } from '@smb/shared';
import { createHttpFetcher } from '../sources/http.js';
import { RateLimiter } from '../sources/limiter.js';
import { wikimediaAdapter } from './wikimedia.js';
import type { ImageAdapterContext, ImageSourceAdapter } from './types.js';

/** Every image adapter that exists in code. config/sources.json must also approve it. */
export const IMAGE_ADAPTERS: ImageSourceAdapter[] = [wikimediaAdapter];

export interface ImageSourceRuntime {
  entry: ImageSourceEntry;
  adapter: ImageSourceAdapter;
  ctx: ImageAdapterContext;
  /** Shared by searches and downloads so the provider's rate limits hold for both. */
  limiter: RateLimiter;
}

export interface RuntimeOptions {
  userAgent: string;
  adapters?: ImageSourceAdapter[];
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Builds a ready-to-use runtime for each image source that is enabled, approved for automated retrieval and
 * has roles. Everything else is left out, so it can never be called. A source that declares roles but has no
 * adapter in code stops startup instead of failing later.
 */
export function createImageRuntimes(
  registry: SourcesRegistry,
  opts: RuntimeOptions,
): Map<string, ImageSourceRuntime> {
  const adapters = new Map((opts.adapters ?? IMAGE_ADAPTERS).map((a) => [a.id, a]));
  const runtimes = new Map<string, ImageSourceRuntime>();
  for (const s of registry.sources) {
    if (s.kind !== 'image' || !s.enabled) continue;
    if (s.policy.status !== 'approved' || !s.policy.automatedRetrieval || s.roles.length === 0)
      continue;
    const adapter = adapters.get(s.id);
    if (!adapter) {
      throw new Error(
        `Image source ${s.id} declares roles in config/sources.json but has no adapter in code`,
      );
    }
    const limiter = new RateLimiter({
      maxConcurrent: s.limits.maxConcurrent,
      minIntervalMs: s.limits.minIntervalMs,
      sleep: opts.sleep,
    });
    const http = createHttpFetcher({
      sourceId: s.id,
      limits: s.limits,
      limiter,
      userAgent: opts.userAgent,
      fetchImpl: opts.fetchImpl,
      sleep: opts.sleep,
    });
    runtimes.set(s.id, {
      entry: s,
      adapter,
      ctx: { http, limits: s.limits, baseUrl: s.access.baseUrl ?? '' },
      limiter,
    });
  }
  return runtimes;
}
