import type { PrismaClient } from '@prisma/client';
import type {
  ChessEvent,
  ChessGame,
  ChessNews,
  ChessPlayer,
  ChessRound,
  EventStatus,
  GamePlayer,
  GameResult,
} from '@smb/shared';
import { getDb as defaultGetDb } from '../../db/client.js';
import { checkGame } from '../../research/chess.js';
import { normaliseName } from '../../research/identity.js';
import type { ChessDataSource, RawItem } from '../types.js';

export const OFFICIAL_SOURCE_ID = 'D1';
export const OFFICIAL_ADAPTER_VERSION = 'official-record/1.0.0';

export interface OfficialPlayerJson {
  name: string;
  fideId?: string;
  title?: string;
  federation?: string;
}

export interface OfficialNextCycleJson {
  stage: string;
  summary?: string;
  expectedStart?: string;
  url?: string;
}

export interface OfficialCycleRow {
  id: string;
  cycle_key: string;
  title: string;
  official_url: string;
  venue: string | null;
  scheduled_start: Date;
  scheduled_end: Date;
  total_games: number;
  player_a: unknown;
  player_b: unknown;
  confirmed_start: Date | null;
  confirmed_end: Date | null;
  winner: string | null;
  next_cycle: unknown;
  updated_at: Date;
}

export interface OfficialGameRow {
  id: string;
  kind: string;
  game_number: number;
  idempotency_key: string;
  state: string;
  scheduled_at: Date | null;
  white_player: string | null;
  result: string | null;
  d3_game_id: string | null;
  d3_round_id: string | null;
  round_label: string | null;
  round_name: string | null;
  round_url: string | null;
  pgn: string | null;
  played_at: Date | null;
  confirmed_at: Date | null;
  confirmed_by: string | null;
  confirmation_basis: string | null;
  result_version: number;
}

function gameSlotId(cycleKey: string, g: Pick<OfficialGameRow, 'kind' | 'game_number'>): string {
  return g.kind === 'tiebreak'
    ? `${cycleKey}:tiebreak-${g.game_number}`
    : `${cycleKey}:game-${g.game_number}`;
}

function toJsonSafe(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

function eventStatus(c: OfficialCycleRow): EventStatus {
  if (c.confirmed_end) return 'completed';
  if (c.confirmed_start) return 'in_progress';
  return 'upcoming';
}

function roundStatus(g: OfficialGameRow): EventStatus {
  if (g.state === 'confirmed') return 'completed';
  if (g.state === 'in_progress' || g.state === 'result_observed') return 'in_progress';
  return 'upcoming';
}

function escapeTag(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function parsePgnHeaders(pgn: string): Record<string, string> {
  const headers: Record<string, string> = {};
  const tag = /^\[([A-Za-z0-9_]+)\s+"((?:[^"\\]|\\.)*)"\]\s*$/;
  for (const line of pgn.replace(/\r\n/g, '\n').split('\n')) {
    if (!line.startsWith('[')) break;
    const m = tag.exec(line);
    if (m) headers[m[1]!] = m[2]!.replace(/\\(["\\])/g, '$1');
  }
  return headers;
}

function headerOnlyPgn(
  eventName: string,
  round: string,
  whiteName: string,
  blackName: string,
  result: Exclude<GameResult, '*'>,
): { pgn: string; headers: Record<string, string> } {
  const headers: Record<string, string> = {
    Event: eventName,
    Round: round,
    White: whiteName,
    Black: blackName,
    Result: result,
  };
  const lines = Object.entries(headers).map(([k, v]) => `[${k} "${escapeTag(v)}"]`);
  const pgn = `${lines.join('\n')}\n\n${result}\n`;
  return { pgn, headers };
}

function toGamePlayer(p: OfficialPlayerJson): GamePlayer {
  return {
    name: p.name,
    ...(p.fideId ? { fideId: p.fideId } : {}),
    ...(p.title ? { title: p.title } : {}),
    ...(p.federation ? { federation: p.federation } : {}),
  };
}

export function mapCycleToEvent(
  cycle: OfficialCycleRow,
  games: OfficialGameRow[],
): RawItem<ChessEvent> {
  const startDate = (cycle.confirmed_start ?? cycle.scheduled_start).toISOString();
  const endDate = (cycle.confirmed_end ?? cycle.scheduled_end).toISOString();
  const rounds: ChessRound[] = games.map((g) => ({
    externalId: gameSlotId(cycle.cycle_key, g),
    name:
      g.round_name ??
      (g.kind === 'tiebreak' ? `Tiebreak ${g.game_number}` : `Game ${g.game_number}`),
    status: roundStatus(g),
    ...(g.scheduled_at ? { startsAt: g.scheduled_at.toISOString() } : {}),
    ...(g.state === 'confirmed' && (g.played_at ?? g.confirmed_at)
      ? { finishedAt: (g.played_at ?? g.confirmed_at)!.toISOString() }
      : {}),
    url: g.round_url ?? cycle.official_url,
  }));

  return {
    url: cycle.official_url,
    eventTime: startDate,
    raw: toJsonSafe({ cycle, games }),
    data: {
      sourceId: OFFICIAL_SOURCE_ID,
      externalId: cycle.cycle_key,
      name: cycle.title,
      url: cycle.official_url,
      status: eventStatus(cycle),
      startDate,
      endDate,
      ...(cycle.venue ? { location: cycle.venue } : {}),
      rounds,
    },
  };
}

export function mapConfirmedGame(
  cycle: OfficialCycleRow,
  g: OfficialGameRow,
): RawItem<ChessGame> | null {
  if (g.state !== 'confirmed' || !g.result) return null;
  if (g.result !== '1-0' && g.result !== '0-1' && g.result !== '1/2-1/2') return null;

  const playerA = cycle.player_a as OfficialPlayerJson;
  const playerB = cycle.player_b as OfficialPlayerJson;
  const whiteJson = g.white_player === 'b' ? playerB : playerA;
  const blackJson = g.white_player === 'b' ? playerA : playerB;

  const round = g.round_label ?? String(g.game_number);
  const url = g.round_url ?? cycle.official_url;
  const playedAt = (g.played_at ?? g.confirmed_at)?.toISOString();

  // Reuse stored feed PGN only if it passes legality and agrees with the confirmed result;
  // otherwise build a clean header-only PGN so an erroneous feed PGN never poisons D1.
  const canUseFeedPgn = Boolean(g.pgn && checkGame(g.pgn, g.result).ok);
  const built = canUseFeedPgn
    ? { pgn: g.pgn!, headers: parsePgnHeaders(g.pgn!) }
    : headerOnlyPgn(cycle.title, round, whiteJson.name, blackJson.name, g.result);

  return {
    url,
    eventTime: playedAt,
    raw: toJsonSafe({
      cycleKey: cycle.cycle_key,
      idempotencyKey: g.idempotency_key,
      kind: g.kind,
      gameNumber: g.game_number,
      whitePlayer: g.white_player ?? 'a',
      result: g.result,
      resultVersion: g.result_version,
      confirmedAt: g.confirmed_at?.toISOString() ?? null,
      confirmedBy: g.confirmed_by,
      confirmationBasis: g.confirmation_basis,
      pgn: built.pgn,
    }),
    data: {
      sourceId: OFFICIAL_SOURCE_ID,
      externalId: gameSlotId(cycle.cycle_key, g),
      eventExternalId: cycle.cycle_key,
      ...(g.d3_round_id ? { roundExternalId: g.d3_round_id } : {}),
      round,
      white: toGamePlayer(whiteJson),
      black: toGamePlayer(blackJson),
      result: g.result,
      ...(playedAt ? { playedAt } : {}),
      url,
      pgn: built.pgn,
      headers: built.headers,
    },
  };
}

export function mapCycleToPlayers(cycle: OfficialCycleRow): RawItem<ChessPlayer>[] {
  const players = [cycle.player_a as OfficialPlayerJson, cycle.player_b as OfficialPlayerJson];
  return players.map((p) => {
    const externalId = p.fideId ?? normaliseName(p.name);
    return {
      url: cycle.official_url,
      eventTime: cycle.updated_at.toISOString(),
      raw: toJsonSafe({ cycleKey: cycle.cycle_key, player: p }),
      data: {
        sourceId: OFFICIAL_SOURCE_ID,
        externalId,
        name: p.name,
        ...(p.fideId ? { fideId: p.fideId } : {}),
        ...(p.title ? { title: p.title } : {}),
        ...(p.federation ? { federation: p.federation } : {}),
        url: cycle.official_url,
      },
    };
  });
}

export function mapCycleToNews(cycle: OfficialCycleRow): RawItem<ChessNews>[] {
  if (!cycle.next_cycle || typeof cycle.next_cycle !== 'object') return [];
  const nc = cycle.next_cycle as OfficialNextCycleJson;
  if (!nc.stage || typeof nc.stage !== 'string') return [];

  const url = nc.url ?? cycle.official_url;
  const publishedAt = cycle.updated_at.toISOString();
  return [
    {
      url,
      eventTime: publishedAt,
      raw: toJsonSafe({ cycleKey: cycle.cycle_key, nextCycle: nc, updatedAt: publishedAt }),
      data: {
        sourceId: OFFICIAL_SOURCE_ID,
        externalId: `${cycle.cycle_key}:next-cycle`,
        title: nc.stage,
        url,
        publishedAt,
        ...(nc.summary ? { summary: nc.summary } : {}),
      },
    },
  ];
}

export function officialRecordAdapter(
  getDb: () => Promise<PrismaClient> | PrismaClient = defaultGetDb,
): ChessDataSource {
  async function findCycle(cycleKey?: string) {
    const db = await getDb();
    if (cycleKey) {
      return db.championship_cycles.findUnique({ where: { cycle_key: cycleKey } });
    }
    return db.championship_cycles.findFirst({ where: { is_current: true } });
  }

  return {
    id: OFFICIAL_SOURCE_ID,
    adapterVersion: OFFICIAL_ADAPTER_VERSION,

    async fetchEvents(query) {
      const db = await getDb();
      if (query.externalId) {
        const cycle = await db.championship_cycles.findUnique({
          where: { cycle_key: query.externalId },
          include: {
            championship_games: { orderBy: [{ kind: 'asc' }, { game_number: 'asc' }] },
          },
        });
        if (!cycle) return [];
        return [mapCycleToEvent(cycle, cycle.championship_games)];
      }
      const cycles = await db.championship_cycles.findMany({
        orderBy: { created_at: 'desc' },
        take: query.limit ?? 20,
        include: {
          championship_games: { orderBy: [{ kind: 'asc' }, { game_number: 'asc' }] },
        },
      });
      const out = cycles.map((c) => mapCycleToEvent(c, c.championship_games));
      const needle = query.nameContains?.toLowerCase();
      return needle ? out.filter((e) => e.data.name.toLowerCase().includes(needle)) : out;
    },

    async fetchGames(query) {
      if (!query.eventExternalId) return [];
      const db = await getDb();
      const cycle = await db.championship_cycles.findUnique({
        where: { cycle_key: query.eventExternalId },
        include: {
          championship_games: {
            where: { state: 'confirmed' },
            orderBy: [{ kind: 'asc' }, { game_number: 'asc' }],
          },
        },
      });
      if (!cycle) return [];
      const items: RawItem<ChessGame>[] = [];
      for (const g of cycle.championship_games) {
        const mapped = mapConfirmedGame(cycle, g);
        if (mapped) items.push(mapped);
      }
      return items;
    },

    async fetchPlayers(query) {
      const cycle = await findCycle(query.eventExternalId);
      if (!cycle) return [];
      let items = mapCycleToPlayers(cycle);
      if (query.fideId) {
        items = items.filter((p) => p.data.fideId === query.fideId);
      }
      if (query.name) {
        const needle = normaliseName(query.name);
        items = items.filter((p) => normaliseName(p.data.name) === needle);
      }
      return items;
    },

    async fetchNews(query) {
      const cycle = await findCycle(query.eventExternalId);
      if (!cycle) return [];
      return mapCycleToNews(cycle).slice(0, query.limit ?? 20);
    },
  };
}
