import { z } from 'zod';
import { GamePlayer } from '../sources/index.js';

/**
 * Normalised event payloads recorded in `smb.detected_events` (module 1.16).
 * One payload per detected event identity. A detector builds it, `ingestEvent` validates and stores it.
 */

const IsoDateTime = z.string().datetime({ offset: true });

/** Where the event was seen: D1 (the operator-confirmed record) first, then the feeds that observed it. */
export const EventSourceRef = z
  .object({
    sourceId: z.string().regex(/^D\d+$/),
    externalId: z.string().min(1),
    url: z.string().url().optional(),
    /** smb.source_records id, when the observation came through the gateway. */
    recordId: z.string().uuid().optional(),
  })
  .strict();
export type EventSourceRef = z.infer<typeof EventSourceRef>;

/** How the event's facts were confirmed. Equal to `championship_games.confirmation_basis`. */
export const EventVerification = z.enum(['official_entry', 'corroborated']);
export type EventVerification = z.infer<typeof EventVerification>;

/** Match score after the event. `classical` counts classical games only; `overall` adds tiebreaks. */
export const EventMatchScore = z
  .object({
    a: z.number().min(0),
    b: z.number().min(0),
    basis: z.enum(['classical', 'overall']),
  })
  .strict();
export type EventMatchScore = z.infer<typeof EventMatchScore>;

const ChampionshipRef = z
  .object({
    postTypeId: z.string().min(1),
    cycleKey: z.string().min(1),
    title: z.string().min(1),
  })
  .strict();

/**
 * A confirmed game result. Carries every field the Development Guide requires of a game-completion event:
 * championship and game identifiers, both players, official result, updated match score,
 * completion timestamp, source reference and verification status.
 */
export const GameCompletedEvent = z
  .object({
    kind: z.literal('game_completed'),
    identityKey: z.string().regex(/^[a-z0-9][a-z0-9-]*:(game|tiebreak)-\d+:result$/),
    championship: ChampionshipRef,
    game: z
      .object({
        kind: z.enum(['classical', 'tiebreak']),
        number: z.number().int().positive(),
        roundLabel: z.string().min(1).optional(),
      })
      .strict(),
    players: z.object({ white: GamePlayer, black: GamePlayer }).strict(),
    /** Official result. Never '*'. */
    result: z.enum(['1-0', '0-1', '1/2-1/2']),
    /** Confirmed score counting this game and every confirmed game of the same kind before it. */
    scoreAfter: EventMatchScore,
    /** When the game finished: played_at, else observed_at, else confirmed_at. */
    completedAt: IsoDateTime,
    confirmedAt: IsoDateTime,
    verification: EventVerification,
    sources: z.array(EventSourceRef).min(1),
  })
  .strict();
export type GameCompletedEvent = z.infer<typeof GameCompletedEvent>;

/** Contract only in 1.16: no detector raises it yet. */
export const RoundCompletedEvent = z
  .object({
    kind: z.literal('round_completed'),
    identityKey: z.string().regex(/^[a-z0-9][a-z0-9-]*:round-[a-z0-9-]+:completed$/),
    eventRefs: z.record(z.string().regex(/^D\d+$/), z.string().min(1)),
    round: z.object({ externalId: z.string().min(1), name: z.string().min(1) }).strict(),
    completedAt: IsoDateTime,
    sources: z.array(EventSourceRef).min(1),
  })
  .strict();
export type RoundCompletedEvent = z.infer<typeof RoundCompletedEvent>;

/** Contract only in 1.16: no detector raises it yet. */
export const TournamentStartedEvent = z
  .object({
    kind: z.literal('tournament_started'),
    identityKey: z.string().regex(/^[a-z0-9][a-z0-9-]*:started$/),
    eventRefs: z.record(z.string().regex(/^D\d+$/), z.string().min(1)),
    name: z.string().min(1),
    startedAt: IsoDateTime,
    sources: z.array(EventSourceRef).min(1),
  })
  .strict();
export type TournamentStartedEvent = z.infer<typeof TournamentStartedEvent>;

/** Contract only in 1.16: no detector raises it yet. */
export const TournamentCompletedEvent = z
  .object({
    kind: z.literal('tournament_completed'),
    identityKey: z.string().regex(/^[a-z0-9][a-z0-9-]*:completed$/),
    eventRefs: z.record(z.string().regex(/^D\d+$/), z.string().min(1)),
    name: z.string().min(1),
    completedAt: IsoDateTime,
    sources: z.array(EventSourceRef).min(1),
  })
  .strict();
export type TournamentCompletedEvent = z.infer<typeof TournamentCompletedEvent>;

export const DetectedEventPayload = z.discriminatedUnion('kind', [
  GameCompletedEvent,
  RoundCompletedEvent,
  TournamentStartedEvent,
  TournamentCompletedEvent,
]);
export type DetectedEventPayload = z.infer<typeof DetectedEventPayload>;
export type DetectedEventKind = DetectedEventPayload['kind'];
