import { createHash, randomUUID } from 'node:crypto';
import type {
  ChessEvent,
  ChessGame,
  EventStatus,
  GameResult,
  ResearchSubject,
  SourceReliability,
  Sourced,
} from '@smb/shared';
import type { Gathered } from '../../../apps/api/src/research/index.js';

export const RELIABILITY: Record<string, SourceReliability> = {
  D1: 'official',
  D2: 'publication',
  D3: 'structured_feed',
  D4: 'publication',
  D5: 'publication',
};
export const reliabilityOf = (id: string): SourceReliability => RELIABILITY[id] ?? 'unverified';

const NOW = '2026-11-04T10:00:00.000Z';

function prov(sourceId: string, url: string, seed: string) {
  return {
    sourceId,
    recordId: randomUUID(),
    url,
    retrievedAt: NOW,
    adapterVersion: 'test/1',
    payloadHash: createHash('sha256').update(`${sourceId}:${seed}`).digest('hex'),
  };
}

export const OK_PGN = (result: GameResult, extra = '') =>
  `[Event "t"]\n[Result "${result}"]\n\n1. e4 e5 2. Nf3 Nc6 ${extra}${result}\n`;

export interface GameSpec {
  id: string;
  round: string;
  white: string;
  black: string;
  result: GameResult;
  source?: string;
  pgn?: string;
  fide?: [string, string];
}

export function game(s: GameSpec): Sourced<ChessGame> {
  const source = s.source ?? 'D3';
  const url = `https://example.org/${source}/${s.id}`;
  return {
    data: {
      sourceId: source,
      externalId: s.id,
      round: s.round,
      white: { name: s.white, fideId: s.fide?.[0] },
      black: { name: s.black, fideId: s.fide?.[1] },
      result: s.result,
      playedAt: '2026-11-03T12:00:00.000Z',
      url,
      pgn: s.pgn ?? OK_PGN(s.result),
      headers: {},
    },
    provenance: prov(source, url, `${s.id}:${s.result}:${s.pgn ?? ''}`),
  };
}

export interface EventSpec {
  source?: string;
  id?: string;
  name?: string;
  status?: EventStatus;
  rounds?: EventStatus[];
  location?: string;
  start?: string;
  end?: string;
}

export function event(s: EventSpec = {}): Sourced<ChessEvent> {
  const source = s.source ?? 'D3';
  const id = s.id ?? 'EV1';
  const url = `https://example.org/${source}/event/${id}`;
  const rounds = (s.rounds ?? ['completed', 'upcoming']).map((status, i) => ({
    externalId: `R${i + 1}`,
    name: `Round ${i + 1}`,
    status,
    startsAt: new Date(Date.UTC(2026, 10, 3 + i, 12)).toISOString(),
    url: `${url}/round-${i + 1}`,
  }));
  return {
    data: {
      sourceId: source,
      externalId: id,
      name: s.name ?? 'Test Championship 2026',
      url,
      status: s.status ?? 'in_progress',
      startDate: s.start ?? '2026-11-03T12:00:00.000Z',
      endDate: s.end ?? '2026-11-20T12:00:00.000Z',
      location: s.location ?? 'Singapore',
      format: '14-game match',
      timeControl: '120 min + 30 sec',
      rounds,
    },
    provenance: prov(source, url, `${id}:${s.name}:${s.status}:${s.location}:${rounds.length}`),
  };
}

export function gathered(p: Partial<Gathered> & Pick<Gathered, 'events' | 'games'>): Gathered {
  return {
    failures: [],
    skipped: [],
    attempted: 1,
    succeeded: 1,
    retrievedAt: [NOW],
    ...p,
  };
}

export const subject = (gameId?: string, source = 'D3'): ResearchSubject => ({
  eventRefs: { [source]: 'EV1' },
  ...(gameId ? { gameRef: { sourceId: source, externalId: gameId } } : {}),
});
