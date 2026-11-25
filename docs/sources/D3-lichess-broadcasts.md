# D3: Lichess Broadcasts

|                 |                                                                                              |
| --------------- | -------------------------------------------------------------------------------------------- |
| Reliability     | `structured_feed` (structured tournament feed; the official source still wins for results)  |
| Access          | Public REST API, base `https://lichess.org/api/`, no authentication for public broadcasts     |
| Terms           | https://lichess.org/terms-of-service                                                         |
| Adapter         | `apps/api/src/sources/lichess/adapter.ts`, version `lichess-broadcast/1.0.0`                 |
| Capabilities    | `events`, `games`. `players` and `news` are not offered and fail with `unsupported_capability` |
| Policy checked  | 2026-11-04 (see below)                                                                       |

## Endpoints used

| Capability | Request                                         | Response                                                       |
| ---------- | ----------------------------------------------- | -------------------------------------------------------------- |
| events     | `GET /api/broadcast?nb=N`                       | NDJSON, one `{ tour, rounds, ... }` per broadcast              |
| events     | `GET /api/broadcast/{tourId}`                   | JSON `{ tour, rounds, ... }`                                   |
| games      | `GET /api/broadcast/round/{roundId}.pgn`        | Multi-game PGN of one round                                    |
| games      | `GET /api/broadcast/{tourId}.pgn`               | Multi-game PGN of every round                                  |

Recorded real responses used as test fixtures: `tests/fixtures/sources/lichess/`.

## What the provider says (checked 2026-11-04)

- API introduction: "Only make one request at a time." On HTTP 429: "In most cases, waiting one minute before retrying will be sufficient, but some limits may require longer."
- API description of the Broadcasts group: "Unauthenticated endpoints are heavily rate-limited and might stop functioning."
- Terms of service: "You can use our services for your own personal or commercial use, such as in your own applications", and "All use of our services are subject to reasonable caps, limits, restrictions, or other bottle-necking". Services include API access. Scraping and broadcast reuse are not mentioned.

## Limits applied

SMB uses `maxConcurrent: 1`, `minIntervalMs: 1000`, `rateLimitBackoffMs: 60000`, two retries and a 30 second timeout. A 429 pauses every request to this source for at least a minute. Responses are cached for 5 minutes (events) and 1 minute (games), which is also the polling floor for a live round.

## Normalisation notes

- **Event status** comes from the rounds: all finished is `completed`; any round started or finished is `in_progress` (this includes the gap between rounds); otherwise `upcoming`.
- **Games** keep the PGN exactly as published, hashed and stored per game. Lichess sometimes omits ratings or FIDE ids; those fields stay empty rather than being guessed.
- A game with a missing or unrecognised `Result` tag fails the whole call (`invalid_response`) instead of being skipped or defaulted.
- Moves are not parsed or validated here. Verifying results and positions is part of research (module 1.5).

## Reliability and use

This is a broadcast feed run by the tournament organisers' relayers, so it can be corrected or briefly wrong during a live round. Results used in a post should be cross-checked against an official source (D1) once one is approved. Attribution is required when quoting or showing games.

## How SMB polls it (module 1.16)

- During a World Championship SMB reads `GET /api/broadcast/{tourId}` (cached for 5 minutes), then the round PGN `GET /api/broadcast/round/{roundId}.pgn` **only** for rounds that are live, finished within the last 30 minutes, or still hold an unconfirmed game. On rest days it makes no games request at all. It polls every 2 minutes near live play and every 15 minutes otherwise.
- The streaming endpoint `GET /api/stream/broadcast/round/{roundId}.pgn` is deliberately not used: a 2-minute poll is well inside the 6-hour staleness budget, and a long-lived stream would add reconnection, partial-PGN and multi-instance handling.
- A result shown by this feed alone is never published. It must be confirmed by an administrator or corroborated by a second approved source over two syncs. If the feed shows a finished game as unfinished again, or changes its result, SMB keeps the first observation and flags it.

## Open points

- **Unauthenticated access may become restricted.** The public broadcast endpoints work without a token today (verified with real requests), but Lichess says unauthenticated endpoints may stop functioning. If that happens, register a personal API token, set `access.auth` to `token` in `config/sources.json` and send it from the adapter. Read-only public data should not need special scopes, but confirm this when it comes up.
- Whether Lichess's terms allow republishing broadcast PGNs inside an image or caption is not addressed by the terms and has not been confirmed with Lichess. Posts should link to the game rather than reproduce full PGNs until it is.
- The adapter sends a generic `User-Agent` (`XLChess-SMB/0.1 (chess news research bot)`). Lichess does not require one; add a contact URL in `sources/index.ts` once XLChess has one.
