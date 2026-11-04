import { z } from 'zod';
import { SourceCapability } from '../config/registries.js';

/**
 * Common data structures for approved chess data sources (module 1.4).
 * The rest of SMB works with these types and never sees a provider's own format.
 */

const IsoDateTime = z.string().datetime({ offset: true });
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);

/** Where a normalised item came from. `recordId` is the smb.source_records row that stores the evidence. */
export const Provenance = z
  .object({
    sourceId: z.string().regex(/^D\d+$/),
    recordId: z.string().uuid(),
    url: z.string().url(),
    retrievedAt: IsoDateTime,
    eventTime: IsoDateTime.optional(),
    adapterVersion: z.string().min(1),
    payloadHash: Sha256,
  })
  .strict();
export type Provenance = z.infer<typeof Provenance>;

export const EventStatus = z.enum(['upcoming', 'in_progress', 'completed']);
export type EventStatus = z.infer<typeof EventStatus>;

export const ChessRound = z
  .object({
    externalId: z.string().min(1),
    name: z.string().min(1),
    status: EventStatus,
    startsAt: IsoDateTime.optional(),
    finishedAt: IsoDateTime.optional(),
    url: z.string().url(),
  })
  .strict();
export type ChessRound = z.infer<typeof ChessRound>;

export const ChessEvent = z
  .object({
    sourceId: z.string(),
    externalId: z.string().min(1),
    name: z.string().min(1),
    url: z.string().url(),
    status: EventStatus,
    startDate: IsoDateTime.optional(),
    endDate: IsoDateTime.optional(),
    location: z.string().optional(),
    format: z.string().optional(),
    timeControl: z.string().optional(),
    website: z.string().url().optional(),
    rounds: z.array(ChessRound),
  })
  .strict();
export type ChessEvent = z.infer<typeof ChessEvent>;

export const GameResult = z.enum(['1-0', '0-1', '1/2-1/2', '*']);
export type GameResult = z.infer<typeof GameResult>;

export const GamePlayer = z
  .object({
    name: z.string().min(1),
    fideId: z.string().optional(),
    title: z.string().optional(),
    rating: z.number().int().positive().optional(),
    federation: z.string().optional(),
  })
  .strict();
export type GamePlayer = z.infer<typeof GamePlayer>;

export const ChessGame = z
  .object({
    sourceId: z.string(),
    externalId: z.string().min(1),
    eventExternalId: z.string().optional(),
    roundExternalId: z.string().optional(),
    /** Provider round label, such as "1.1" (round.board). */
    round: z.string().optional(),
    white: GamePlayer,
    black: GamePlayer,
    result: GameResult,
    playedAt: IsoDateTime.optional(),
    url: z.string().url(),
    /** The full PGN as published. Move validation is a research step (1.5). */
    pgn: z.string().min(1),
    headers: z.record(z.string(), z.string()),
  })
  .strict();
export type ChessGame = z.infer<typeof ChessGame>;

export const ChessPlayer = z
  .object({
    sourceId: z.string(),
    externalId: z.string().min(1),
    name: z.string().min(1),
    fideId: z.string().optional(),
    title: z.string().optional(),
    federation: z.string().optional(),
    rating: z.number().int().positive().optional(),
    url: z.string().url().optional(),
  })
  .strict();
export type ChessPlayer = z.infer<typeof ChessPlayer>;

export const ChessNews = z
  .object({
    sourceId: z.string(),
    externalId: z.string().min(1),
    title: z.string().min(1),
    url: z.string().url(),
    publishedAt: IsoDateTime,
    summary: z.string().optional(),
    author: z.string().optional(),
  })
  .strict();
export type ChessNews = z.infer<typeof ChessNews>;

/** Schema for each capability's item type, used to validate adapter output at the gateway. */
export const CAPABILITY_SCHEMAS = {
  events: ChessEvent,
  players: ChessPlayer,
  games: ChessGame,
  news: ChessNews,
} as const satisfies Record<SourceCapability, z.ZodTypeAny>;

export interface CapabilityItem {
  events: ChessEvent;
  players: ChessPlayer;
  games: ChessGame;
  news: ChessNews;
}

export const EventQuery = z
  .object({
    /** One event by its provider id. */
    externalId: z.string().min(1).optional(),
    /** Newest-first page size when listing. */
    limit: z.number().int().min(1).max(200).default(20),
    /** Case-insensitive match on the event name, applied after normalisation. */
    nameContains: z.string().min(1).optional(),
  })
  .strict();
export type EventQuery = z.input<typeof EventQuery>;

export const PlayerQuery = z
  .object({
    fideId: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
  })
  .strict();
export type PlayerQuery = z.input<typeof PlayerQuery>;

export const GameQuery = z
  .object({
    /** Games of one round (provider round id). */
    roundExternalId: z.string().min(1).optional(),
    /** Games of every round in one event. */
    eventExternalId: z.string().min(1).optional(),
  })
  .strict()
  .refine((q) => Boolean(q.roundExternalId) !== Boolean(q.eventExternalId), {
    message: 'give exactly one of roundExternalId or eventExternalId',
  });
export type GameQuery = z.input<typeof GameQuery>;

export const NewsQuery = z.object({ limit: z.number().int().min(1).max(100).default(20) }).strict();
export type NewsQuery = z.input<typeof NewsQuery>;

export interface CapabilityQuery {
  events: EventQuery;
  players: PlayerQuery;
  games: GameQuery;
  news: NewsQuery;
}

export const CAPABILITY_QUERY_SCHEMAS = {
  events: EventQuery,
  players: PlayerQuery,
  games: GameQuery,
  news: NewsQuery,
} as const;

/** A normalised item together with the evidence it was built from. */
export interface Sourced<T> {
  data: T;
  provenance: Provenance;
}

export interface SourceResult<T> {
  sourceId: string;
  capability: SourceCapability;
  items: Sourced<T>[];
  /** True when served from the in-memory cache instead of the provider. */
  fromCache: boolean;
}
