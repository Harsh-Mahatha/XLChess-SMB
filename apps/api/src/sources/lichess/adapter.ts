import { z } from 'zod';
import type { ChessEvent, ChessGame, ChessRound, EventStatus, GamePlayer } from '@smb/shared';
import { SourceError } from '../errors.js';
import type { AdapterContext, ChessDataSource, RawItem } from '../types.js';
import { parsePgnGames, type PgnGame } from './pgn.js';

export const LICHESS_SOURCE_ID = 'D3';
export const LICHESS_ADAPTER_VERSION = 'lichess-broadcast/1.0.0';

const Millis = z.number().int().nonnegative();

const LichessRound = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    url: z.string().url(),
    startsAt: Millis.optional(),
    finishedAt: Millis.optional(),
    finished: z.boolean().optional(),
    ongoing: z.boolean().optional(),
  })
  .passthrough();

const LichessBroadcast = z
  .object({
    tour: z
      .object({
        id: z.string().min(1),
        name: z.string().min(1),
        url: z.string().url(),
        dates: z.array(Millis).optional(),
        info: z
          .object({
            format: z.string().optional(),
            tc: z.string().optional(),
            location: z.string().optional(),
            website: z.string().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough(),
    rounds: z.array(LichessRound),
  })
  .passthrough();
type LichessBroadcast = z.infer<typeof LichessBroadcast>;

const iso = (ms: number): string => new Date(ms).toISOString();

function roundStatus(r: z.infer<typeof LichessRound>): EventStatus {
  if (r.finished) return 'completed';
  if (r.ongoing) return 'in_progress';
  return 'upcoming';
}

function eventStatus(rounds: ChessRound[]): EventStatus {
  if (rounds.length > 0 && rounds.every((r) => r.status === 'completed')) return 'completed';
  // Between rounds counts as in progress, so a tournament is not "upcoming" after round 1 has finished.
  if (rounds.some((r) => r.status !== 'upcoming')) return 'in_progress';
  return 'upcoming';
}

function validUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).toString();
  } catch {
    return undefined;
  }
}

export function normaliseBroadcast(b: LichessBroadcast): ChessEvent {
  const rounds: ChessRound[] = b.rounds.map((r) => ({
    externalId: r.id,
    name: r.name,
    status: roundStatus(r),
    startsAt: r.startsAt === undefined ? undefined : iso(r.startsAt),
    finishedAt: r.finishedAt === undefined ? undefined : iso(r.finishedAt),
    url: r.url,
  }));
  const { tour } = b;
  return {
    sourceId: LICHESS_SOURCE_ID,
    externalId: tour.id,
    name: tour.name,
    url: tour.url,
    status: eventStatus(rounds),
    startDate: tour.dates?.[0] === undefined ? undefined : iso(tour.dates[0]),
    endDate: tour.dates?.[1] === undefined ? undefined : iso(tour.dates[1]),
    location: tour.info?.location,
    format: tour.info?.format,
    timeControl: tour.info?.tc,
    website: validUrl(tour.info?.website),
    rounds,
  };
}

function parseBroadcast(value: unknown, where: string): LichessBroadcast {
  const parsed = LichessBroadcast.safeParse(value);
  if (!parsed.success) {
    throw new SourceError(
      'invalid_response',
      LICHESS_SOURCE_ID,
      `unexpected broadcast shape (${where})`,
      parsed.error.issues,
    );
  }
  return parsed.data;
}

function parseJson(text: string, where: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new SourceError(
      'invalid_response',
      LICHESS_SOURCE_ID,
      `response is not valid JSON (${where})`,
    );
  }
}

function toPlayer(h: Record<string, string>, side: 'White' | 'Black'): GamePlayer {
  const rating = Number.parseInt(h[`${side}Elo`] ?? '', 10);
  return {
    name: h[side] ?? '',
    fideId: h[`${side}FideId`] || undefined,
    title: h[`${side}Title`] || undefined,
    rating: Number.isFinite(rating) && rating > 0 ? rating : undefined,
  };
}

/** "2026.11.03" + "13:15:49" (UTC) to an ISO timestamp. Undefined when the tags are missing or unusable. */
function playedAt(h: Record<string, string>): string | undefined {
  const d = h['UTCDate'];
  const t = h['UTCTime'];
  if (!d || !t || !/^\d{4}\.\d{2}\.\d{2}$/.test(d) || !/^\d{2}:\d{2}:\d{2}$/.test(t))
    return undefined;
  const at = new Date(`${d.replaceAll('.', '-')}T${t}Z`);
  return Number.isNaN(at.getTime()) ? undefined : at.toISOString();
}

export function normaliseGame(
  game: PgnGame,
  fallback: { url: string; eventExternalId?: string; roundExternalId?: string },
): RawItem<ChessGame> {
  const h = game.headers;
  const result = h['Result'];
  if (result !== '1-0' && result !== '0-1' && result !== '1/2-1/2' && result !== '*') {
    throw new SourceError(
      'invalid_response',
      LICHESS_SOURCE_ID,
      `game has missing or unknown Result tag: ${JSON.stringify(result)}`,
    );
  }
  const url = validUrl(h['GameURL']) ?? validUrl(h['Site']) ?? fallback.url;
  // Game URLs look like .../<tour-slug>/<round-slug>/<roundId>/<gameId>.
  const parts = new URL(url).pathname.split('/').filter(Boolean);
  const externalId = parts.at(-1) ?? url;
  const roundExternalId =
    (h['GameURL'] || h['Site']) && parts.length >= 2 ? parts.at(-2) : fallback.roundExternalId;
  const at = playedAt(h);
  return {
    url,
    eventTime: at,
    raw: game.pgn,
    data: {
      sourceId: LICHESS_SOURCE_ID,
      externalId,
      eventExternalId: fallback.eventExternalId,
      roundExternalId: fallback.roundExternalId ?? roundExternalId,
      round: h['Round'],
      white: toPlayer(h, 'White'),
      black: toPlayer(h, 'Black'),
      result,
      playedAt: at,
      url,
      pgn: game.pgn,
      headers: h,
    },
  };
}

function gamesFromPgn(
  text: string,
  fallback: { url: string; eventExternalId?: string; roundExternalId?: string },
): RawItem<ChessGame>[] {
  let games: PgnGame[];
  try {
    games = parsePgnGames(text);
  } catch (err) {
    throw new SourceError('invalid_response', LICHESS_SOURCE_ID, 'response is not valid PGN', {
      cause: err instanceof Error ? err.message : String(err),
    });
  }
  return games.map((g) => normaliseGame(g, fallback));
}

/** Lichess Broadcasts (D3): events (tournaments with rounds) and games (PGN). Players and news are not offered. */
export const lichessAdapter: ChessDataSource = {
  id: LICHESS_SOURCE_ID,
  adapterVersion: LICHESS_ADAPTER_VERSION,

  async fetchEvents(query, ctx: AdapterContext) {
    const out: RawItem<ChessEvent>[] = [];
    if (query.externalId) {
      const url = `${ctx.baseUrl}broadcast/${encodeURIComponent(query.externalId)}`;
      const res = await ctx.http.get(url);
      const b = parseBroadcast(parseJson(res.text, url), url);
      out.push({
        url: b.tour.url,
        eventTime: normaliseBroadcast(b).startDate,
        raw: b,
        data: normaliseBroadcast(b),
      });
      return out;
    }
    const url = `${ctx.baseUrl}broadcast?nb=${query.limit ?? 20}`;
    const res = await ctx.http.get(url, { accept: 'application/x-ndjson' });
    const lines = res.text.split('\n').filter((l) => l.trim() !== '');
    for (const [i, line] of lines.entries()) {
      const b = parseBroadcast(parseJson(line, `${url} line ${i + 1}`), `${url} line ${i + 1}`);
      const data = normaliseBroadcast(b);
      out.push({ url: b.tour.url, eventTime: data.startDate, raw: b, data });
    }
    const needle = query.nameContains?.toLowerCase();
    return needle ? out.filter((e) => e.data.name.toLowerCase().includes(needle)) : out;
  },

  async fetchGames(query, ctx: AdapterContext) {
    if (query.roundExternalId) {
      const id = encodeURIComponent(query.roundExternalId);
      const url = `${ctx.baseUrl}broadcast/round/${id}.pgn`;
      const res = await ctx.http.get(url, { accept: 'application/x-chess-pgn' });
      return gamesFromPgn(res.text, { url, roundExternalId: query.roundExternalId });
    }
    const eventId = encodeURIComponent(query.eventExternalId ?? '');
    const url = `${ctx.baseUrl}broadcast/${eventId}.pgn`;
    const res = await ctx.http.get(url, { accept: 'application/x-chess-pgn' });
    return gamesFromPgn(res.text, { url, eventExternalId: query.eventExternalId });
  },
};
