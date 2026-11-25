# D1: Official Championship Record (Operator-Confirmed)

|                 |                                                                                           |
| --------------- | ----------------------------------------------------------------------------------------- |
| Reliability     | `official` (authoritative record entered by an administrator after checking FIDE pages)   |
| Access          | `manual` (no automated FIDE API or scraping; reads SMB's own confirmed championship DB)   |
| Terms           | https://www.fide.com/                                                                     |
| Adapter         | `apps/api/src/sources/official/adapter.ts`, version `official-record/1.0.0`               |
| Capabilities    | `events`, `games`, `players`, `news`                                                      |
| Policy checked  | 2026-11-18 (see below)                                                                    |

## What it is

FIDE does not provide a public API for live championship events, and FIDE's website terms have not been approved for automated scraping. To keep the verification bar honest without inventing data or downgrading `game.result` / `match.score` / `event.outcome` / `next_cycle.stage`, SMB models the **operator-confirmed official record** (`smb.championship_cycles` and `smb.championship_games`) as source **D1**.

An administrator registers the championship (title, official FIDE URL, scheduled dates, players, game count) and confirms each game result only after checking the official FIDE / World Championship pages (`attested: true`). Every administrator action is logged in `smb.championship_log` and `smb.audit_log`.

## Capabilities returned

| Capability | Source table(s) | Behaviour |
| ---------- | --------------- | --------- |
| `events`   | `championship_cycles`, `championship_games` | Returns one `ChessEvent` keyed by `cycle_key`. Status is `completed` when `confirmed_end` is set, `in_progress` when `confirmed_start` is set, otherwise `upcoming`. Rounds mirror the classical and tiebreak game rows. |
| `games`    | `championship_games` | Returns **only `confirmed` games** (`state = 'confirmed'`). Unconfirmed or merely observed games are never returned, and unattested values never enter D1. |
| `players`  | `championship_cycles` | Returns `player_a` and `player_b` from the championship record (no ratings are invented). |
| `news`     | `championship_cycles` | Returns at most one `ChessNews` item when `next_cycle` is populated on the cycle record. |

## Why `official`

Every fact served by D1 has been explicitly entered or attested by an administrator against the recorded `official_url`. Research verification (`assess()`) therefore treats D1 claims as `verified` and lets D1 settle conflicts against structured feeds such as D3 (Lichess Broadcasts), while keeping the disagreement visible as a `resolved` conflict in the package summary.

`automatedRetrieval: true` in `config/sources.json` permits the gateway to invoke `officialRecordAdapter` against SMB's own database; **SMB never scrapes or polls FIDE directly**.

## Limits and caching

`cacheTtlSeconds` is `0` for all four capabilities because an administrator can confirm a game, conclude a cycle, or update `next_cycle` at any time.
