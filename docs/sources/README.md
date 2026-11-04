# Approved data sources: verification notes

The development guide treats D1–D5 as _candidate_ sources, not blanket permission to retrieve or republish. A source becomes usable by SMB only after someone has read its API, usage limits and licence terms and recorded the result here, and `config/sources.json` marks it `approved`. Until then it has no capabilities and every request fails with `source_not_approved`.

| ID  | Source                   | Access                        | Status                 | Capabilities    | Notes                                                                                                                                         |
| --- | ------------------------ | ----------------------------- | ---------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | FIDE                     | Downloadable rating lists     | `pending_verification` | none            | Not an API. Needs a terms check, then a `players` adapter that parses the downloaded list.                                                    |
| D2  | Chess.com News           | None suitable                 | `pending_verification` | none            | The public API covers players and games, not news. Scraping news is not allowed without permission; needs permission or a feed with clear terms. |
| D3  | Lichess Broadcasts       | Public REST API, no auth      | **`approved`**         | events, games   | [D3-lichess-broadcasts.md](D3-lichess-broadcasts.md)                                                                                          |
| D4  | The Week in Chess (TWIC) | Downloadable weekly PGN files | `pending_verification` | none            | Not an API. Needs a terms check, then a `games` adapter that parses the downloaded archive.                                                   |
| D5  | ChessBase                | RSS only                      | `pending_verification` | none            | Reuse terms unclear.                                                                                                                          |

Notes marked `pending_verification` were written from general knowledge of each provider and have **not** been checked against current terms. Treat them as a to-do list, not as findings.
