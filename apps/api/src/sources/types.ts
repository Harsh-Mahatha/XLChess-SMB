import type { CapabilityItem, CapabilityQuery, SourceCapability, SourceLimits } from '@smb/shared';

/**
 * One normalised item plus the raw payload it was built from. The gateway hashes `raw`, stores both
 * in smb.source_records and attaches the resulting provenance.
 */
export interface RawItem<T> {
  /** The specific provider URL for this item (a human-checkable link). */
  url: string;
  eventTime?: string;
  /** JSON-compatible value or a string (for example one PGN game). */
  raw: unknown;
  data: T;
}

type Fetcher<C extends SourceCapability> = (
  query: CapabilityQuery[C],
  ctx: AdapterContext,
) => Promise<RawItem<CapabilityItem[C]>[]>;

/**
 * Shared interface for approved chess data sources. An adapter implements only the capabilities its
 * provider actually supports; the gateway refuses the rest with `unsupported_capability`.
 */
export interface ChessDataSource {
  readonly id: string;
  readonly adapterVersion: string;
  fetchEvents?: Fetcher<'events'>;
  fetchPlayers?: Fetcher<'players'>;
  fetchGames?: Fetcher<'games'>;
  fetchNews?: Fetcher<'news'>;
}

export const METHOD_FOR = {
  events: 'fetchEvents',
  players: 'fetchPlayers',
  games: 'fetchGames',
  news: 'fetchNews',
} as const satisfies Record<SourceCapability, keyof ChessDataSource>;

/** What the gateway gives an adapter: a rate-limited HTTP client and the source's limits. */
export interface AdapterContext {
  http: HttpFetcher;
  limits: SourceLimits;
  baseUrl: string;
}

export interface HttpResponse {
  status: number;
  url: string;
  text: string;
}

/** Rate-limited, retrying HTTP GET bound to one source. Throws SourceError on every failure. */
export interface HttpFetcher {
  get(url: string, init?: { accept?: string }): Promise<HttpResponse>;
}
