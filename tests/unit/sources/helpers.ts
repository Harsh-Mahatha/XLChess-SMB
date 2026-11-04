import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfigSet } from '../../../apps/api/src/config/loader.js';
import {
  InMemorySourceRecordStore,
  createSourceGateway,
  type SourceGateway,
} from '../../../apps/api/src/sources/index.js';

export const FIXTURES = resolve(import.meta.dirname, '../../fixtures/sources/lichess');
export const fixture = (name: string): string => readFileSync(resolve(FIXTURES, name), 'utf8');

export const API = 'https://lichess.org/api/';
export const TOUR_ID = 'XtrsoyoQ';
export const ROUND_ID = 'QI8NMsem';

/** A clock that only moves when something sleeps, so rate-limit waits are instant but still observable. */
export function fakeClock(startIso = '2026-11-04T10:00:00.000Z') {
  const clock = {
    t: new Date(startIso).getTime(),
    sleeps: [] as number[],
    now: () => new Date(clock.t),
    sleep: async (ms: number) => {
      clock.sleeps.push(ms);
      clock.t += ms;
    },
  };
  return clock;
}

export type Reply = { status?: number; body?: string; headers?: Record<string, string> } | Error;
export type Routes = Record<string, Reply | Reply[]>;

/** Fake fetch: each URL maps to a reply, or a list of replies used in order (the last one repeats). */
export function fakeFetch(routes: Routes) {
  const calls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const entry = routes[url];
    if (entry === undefined) throw new Error(`unexpected request in test: ${url}`);
    const queue = Array.isArray(entry) ? entry : [entry];
    const reply = queue[Math.min(calls.filter((c) => c === url).length - 1, queue.length - 1)]!;
    if (reply instanceof Error) throw reply;
    return new Response(reply.body ?? '', { status: reply.status ?? 200, headers: reply.headers });
  }) as typeof fetch;
  return { impl, calls };
}

export const okRoutes = (): Routes => ({
  [`${API}broadcast?nb=20`]: { body: fixture('broadcasts.ndjson') },
  [`${API}broadcast/${TOUR_ID}`]: { body: fixture('tour.json') },
  [`${API}broadcast/round/${ROUND_ID}.pgn`]: { body: fixture('round.pgn') },
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function makeGateway(routes: Routes = okRoutes(), mutate?: (registry: any) => void) {
  const set = loadConfigSet();
  const registry = structuredClone(set.sources);
  mutate?.(registry);
  const store = new InMemorySourceRecordStore();
  const clock = fakeClock();
  const net = fakeFetch(routes);
  const gateway: SourceGateway = createSourceGateway(registry, store, {
    fetchImpl: net.impl,
    now: clock.now,
    sleep: clock.sleep,
  });
  return { gateway, store, clock, net, registry };
}
