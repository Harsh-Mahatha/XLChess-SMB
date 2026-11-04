import {
  CAPABILITY_QUERY_SCHEMAS,
  CAPABILITY_SCHEMAS,
  type CapabilityItem,
  type CapabilityQuery,
  type DataSourceEntry,
  type SourceCapability,
  type SourceResult,
  type SourcesRegistry,
  type Sourced,
} from '@smb/shared';
import { TtlCache } from './cache.js';
import { SourceError } from './errors.js';
import { createHttpFetcher } from './http.js';
import { RateLimiter } from './limiter.js';
import { payloadHash, type SourceRecordStore } from './store.js';
import { METHOD_FOR, type AdapterContext, type ChessDataSource, type RawItem } from './types.js';

export interface GatewayOptions {
  registry: SourcesRegistry;
  adapters: ChessDataSource[];
  store: SourceRecordStore;
  userAgent: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

interface Runtime {
  entry: DataSourceEntry;
  adapter?: ChessDataSource;
  ctx: AdapterContext;
}

/**
 * The only way the rest of SMB asks a provider for data. It enforces the registry (enabled, approved,
 * capability declared), then cache, rate limits and the adapter, validates the normalised output, and
 * stores evidence in source_records. Any failure is thrown as a SourceError, never returned as "no data".
 */
export class SourceGateway {
  private readonly runtimes = new Map<string, Runtime>();
  private readonly cache: TtlCache<Sourced<unknown>[]>;
  private readonly now: () => Date;

  constructor(private readonly opts: GatewayOptions) {
    this.now = opts.now ?? (() => new Date());
    this.cache = new TtlCache(() => this.now().getTime());
    const adapters = new Map(opts.adapters.map((a) => [a.id, a]));

    for (const s of opts.registry.sources) {
      if (s.kind !== 'data') continue;
      const adapter = adapters.get(s.id);
      // Fail at startup, not at 3am: a declared capability must have code behind it.
      for (const cap of s.capabilities) {
        if (typeof adapter?.[METHOD_FOR[cap]] !== 'function') {
          throw new Error(
            `Source ${s.id} declares capability "${cap}" in config/sources.json but has no adapter implementing it`,
          );
        }
      }
      const limiter = new RateLimiter({
        maxConcurrent: s.limits.maxConcurrent,
        minIntervalMs: s.limits.minIntervalMs,
        sleep: opts.sleep,
        now: () => this.now().getTime(),
      });
      const http = createHttpFetcher({
        sourceId: s.id,
        limits: s.limits,
        limiter,
        userAgent: opts.userAgent,
        fetchImpl: opts.fetchImpl,
        sleep: opts.sleep,
      });
      this.runtimes.set(s.id, {
        entry: s,
        adapter,
        ctx: { http, limits: s.limits, baseUrl: s.access.baseUrl ?? '' },
      });
    }
    for (const id of adapters.keys()) {
      if (!this.runtimes.has(id)) {
        throw new Error(`Adapter ${id} has no data source entry in config/sources.json`);
      }
    }
  }

  /** What `sourceId` may be asked for right now (empty unless enabled and approved). */
  capabilitiesOf(sourceId: string): SourceCapability[] {
    const rt = this.runtimes.get(sourceId);
    if (!rt) return [];
    try {
      this.assertUsable(rt.entry);
    } catch {
      return [];
    }
    return [...rt.entry.capabilities];
  }

  async fetch<C extends SourceCapability>(
    sourceId: string,
    capability: C,
    query: CapabilityQuery[C],
  ): Promise<SourceResult<CapabilityItem[C]>> {
    const rt = this.runtimes.get(sourceId);
    if (!rt) {
      throw new SourceError(
        'source_not_registered',
        sourceId,
        'not in the approved source registry',
      );
    }
    this.assertUsable(rt.entry);
    if (!rt.entry.capabilities.includes(capability)) {
      throw new SourceError(
        'unsupported_capability',
        sourceId,
        `"${capability}" is not a capability of this source (supported: ${rt.entry.capabilities.join(', ') || 'none'})`,
      );
    }
    const fetcher = rt.adapter?.[METHOD_FOR[capability]] as
      ((q: unknown, ctx: AdapterContext) => Promise<RawItem<unknown>[]>) | undefined;
    if (!rt.adapter || !fetcher) {
      throw new SourceError(
        'unsupported_capability',
        sourceId,
        `adapter does not implement "${capability}"`,
      );
    }

    const parsedQuery = CAPABILITY_QUERY_SCHEMAS[capability].safeParse(query);
    if (!parsedQuery.success) {
      throw new SourceError('invalid_query', sourceId, 'query rejected', parsedQuery.error.issues);
    }

    const key = TtlCache.key(sourceId, capability, parsedQuery.data);
    const cached = this.cache.get(key);
    if (cached) {
      return {
        sourceId,
        capability,
        items: cached as Sourced<CapabilityItem[C]>[],
        fromCache: true,
      };
    }

    const raws = await fetcher.call(rt.adapter, parsedQuery.data, rt.ctx);

    const itemSchema = CAPABILITY_SCHEMAS[capability];
    const retrievedAt = this.now();
    const items: Sourced<unknown>[] = [];
    for (const raw of raws) {
      const checked = itemSchema.safeParse(raw.data);
      if (!checked.success) {
        throw new SourceError(
          'invalid_response',
          sourceId,
          `adapter output for ${raw.url} failed validation`,
          checked.error.issues,
        );
      }
      const hash = payloadHash(raw.raw);
      const stored = await this.opts.store.save({
        sourceId,
        url: raw.url,
        retrievedAt,
        eventTime: raw.eventTime ? new Date(raw.eventTime) : undefined,
        adapterVersion: rt.adapter.adapterVersion,
        rawPayload: raw.raw,
        payloadHash: hash,
        normalised: checked.data,
      });
      items.push({
        data: checked.data,
        provenance: {
          sourceId,
          recordId: stored.id,
          url: raw.url,
          retrievedAt: stored.retrievedAt.toISOString(),
          eventTime: raw.eventTime,
          adapterVersion: rt.adapter.adapterVersion,
          payloadHash: hash,
        },
      });
    }

    this.cache.set(key, items, rt.entry.limits.cacheTtlSeconds[capability] ?? 0);
    return { sourceId, capability, items: items as Sourced<CapabilityItem[C]>[], fromCache: false };
  }

  private assertUsable(entry: DataSourceEntry): void {
    if (!entry.enabled) {
      throw new SourceError('source_disabled', entry.id, 'source is disabled in the registry');
    }
    if (entry.policy.status !== 'approved' || !entry.policy.automatedRetrieval) {
      throw new SourceError(
        'source_not_approved',
        entry.id,
        `automated retrieval is not approved (policy: ${entry.policy.status}); verify its API and terms first`,
      );
    }
  }
}
