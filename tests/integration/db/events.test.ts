import { PrismaClient } from '@prisma/client';
import type { Express } from 'express';
import { SignJWT } from 'jose';
import type pg from 'pg';
import { pino } from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import {
  GameCompletedEvent,
  MAX_BACKOFF_MS,
  type ChessEvent,
  type ChessGame,
  type EventStatus,
  type GamePlayer,
  type GameResult,
  type SourcesRegistry,
} from '@smb/shared';
import { createApp } from '../../../apps/api/src/app.js';
import { createTokenVerifier } from '../../../apps/api/src/auth/index.js';
import {
  CHAMPIONSHIP_DETECTOR_ID,
  addTiebreakGame,
  bindGame,
  championshipDetector,
  championshipResolver,
  confirmGame,
  emitPendingGameEvents,
  forcePhase,
  registerCycle,
} from '../../../apps/api/src/championship/index.js';
import { loadConfigSet } from '../../../apps/api/src/config/loader.js';
import { syncSources } from '../../../apps/api/src/config/sources-sync.js';
import { syncConfigs } from '../../../apps/api/src/config/sync.js';
import { loadEnv } from '../../../apps/api/src/env.js';
import {
  DetectorRegistry,
  EventIdentityConflict,
  ingestEvent,
  runEventPoll,
} from '../../../apps/api/src/events/index.js';
import { ContextResolvers } from '../../../apps/api/src/scheduling/context.js';
import {
  PrismaSourceRecordStore,
  SourceError,
  createSourceGateway,
  officialRecordAdapter,
  type ChessDataSource,
  type RawItem,
} from '../../../apps/api/src/sources/index.js';
import { freshDb, rows } from './harness.js';

let pgc: pg.Client;
let prisma: PrismaClient;
let baseRegistry: SourcesRegistry;
const logger = pino({ level: 'silent' });

const GUKESH: GamePlayer = { name: 'Gukesh D', fideId: '46616543', title: 'GM' };
const DING: GamePlayer = { name: 'Ding Liren', fideId: '8603677', title: 'GM' };

const PGN = (result: GameResult, white: string, black: string) =>
  `[Event "WCC"]\n[White "${white}"]\n[Black "${black}"]\n[Result "${result}"]\n\n1. e4 e5 2. Nf3 Nc6 ${result}\n`;

interface FeedRound {
  id: string;
  status: EventStatus;
  startsAt?: string;
  finishedAt?: string;
}
interface FeedGame {
  id: string;
  round: string;
  roundId: string;
  white: GamePlayer;
  black: GamePlayer;
  result: GameResult;
  playedAt?: string;
}
interface Feed {
  status: EventStatus;
  rounds: FeedRound[];
  games: FeedGame[];
  failEvents?: boolean;
  failGames?: boolean;
  requests: { capability: string; query: Record<string, unknown> }[];
}

const feed = (over: Partial<Feed> = {}): Feed => ({
  status: 'in_progress',
  rounds: [],
  games: [],
  requests: [],
  ...over,
});

function fakeAdapter(sourceId: string, state: Feed): ChessDataSource {
  return {
    id: sourceId,
    adapterVersion: `${sourceId.toLowerCase()}-events-test/1.0.0`,
    async fetchEvents(query): Promise<RawItem<ChessEvent>[]> {
      state.requests.push({ capability: 'events', query: { ...query } });
      if (state.failEvents) throw new SourceError('upstream_unavailable', sourceId, 'outage');
      const ref = query.externalId ?? 'ev';
      const url = `https://example.org/${sourceId}/${ref}`;
      const data: ChessEvent = {
        sourceId,
        externalId: ref,
        name: 'FIDE World Championship',
        url,
        status: state.status,
        rounds: state.rounds.map((r) => ({
          externalId: r.id,
          name: `Round ${r.id}`,
          status: r.status,
          ...(r.startsAt ? { startsAt: r.startsAt } : {}),
          ...(r.finishedAt ? { finishedAt: r.finishedAt } : {}),
          url: `${url}/${r.id}`,
        })),
      };
      return [{ url, raw: { ...data }, data }];
    },
    async fetchGames(query): Promise<RawItem<ChessGame>[]> {
      state.requests.push({ capability: 'games', query: { ...query } });
      if (state.failGames) throw new SourceError('upstream_unavailable', sourceId, 'outage');
      const games = query.roundExternalId
        ? state.games.filter((g) => g.roundId === query.roundExternalId)
        : state.games;
      return games.map((g) => {
        const url = `https://example.org/${sourceId}/${g.roundId}/${g.id}`;
        const pgn = PGN(g.result, g.white.name, g.black.name);
        return {
          url,
          eventTime: g.playedAt,
          raw: pgn,
          data: {
            sourceId,
            externalId: g.id,
            roundExternalId: g.roundId,
            round: g.round,
            white: g.white,
            black: g.black,
            result: g.result,
            ...(g.playedAt ? { playedAt: g.playedAt } : {}),
            url,
            pgn,
            headers: { Result: g.result },
          },
        };
      });
    },
  };
}

function registryWithD4(withD4 = true): SourcesRegistry {
  const reg = structuredClone(baseRegistry);
  for (const s of reg.sources) {
    if (s.kind !== 'data') continue;
    if (s.id === 'D3') {
      s.limits.cacheTtlSeconds = { events: 0, games: 0 };
      s.limits.minIntervalMs = 0;
    }
    if (s.id === 'D4' && withD4) {
      s.policy = {
        status: 'approved',
        verifiedAt: '2026-11-18',
        automatedRetrieval: true,
        attributionRequired: true,
      };
      s.capabilities = ['events', 'games'];
      s.limits.cacheTtlSeconds = { events: 0, games: 0 };
      s.limits.minIntervalMs = 0;
    }
  }
  return reg;
}

function detectorsFor(feeds: { D3: Feed; D4?: Feed }, stabilitySeconds = 120) {
  const registry = registryWithD4(!!feeds.D4);
  const adapters = [
    fakeAdapter('D3', feeds.D3),
    ...(feeds.D4 ? [fakeAdapter('D4', feeds.D4)] : []),
  ];
  const gateway = createSourceGateway(registry, new PrismaSourceRecordStore(prisma), {
    adapters: [officialRecordAdapter(() => prisma), ...adapters],
    sleep: async () => undefined,
  });
  const resolvers = new ContextResolvers();
  resolvers.register('1.1', championshipResolver(prisma));
  return new DetectorRegistry().register(
    championshipDetector({ db: prisma, gateway, registry, resolvers, logger, stabilitySeconds }),
  );
}

const poll = (detectors: DetectorRegistry, at: string, force = true) =>
  runEventPoll({ db: prisma, detectors, logger, rand: () => 0.5 }, { now: new Date(at), force });

async function finishCurrentCycle() {
  const current = await prisma.championship_cycles.findFirst({
    where: { post_type_id: '1.1', is_current: true },
  });
  if (current && current.phase !== 'post_tournament') {
    await forcePhase({ db: prisma, logger }, 'cleanup', current.id, {
      phase: 'post_tournament',
      reason: 'Reset between tests',
      lock: false,
      winner: 'a',
    });
  }
  // Each test starts with a fresh poller (no backoff carried over).
  await prisma.event_pollers.deleteMany({});
}

/** Registers a cycle and moves it to the tournament phase. */
async function tournament(cycleKey: string, opts: { totalGames?: number; refs?: object } = {}) {
  await finishCurrentCycle();
  const { cycle } = await registerCycle({ db: prisma, logger }, 'admin-1', {
    cycleKey,
    title: `World Championship (${cycleKey})`,
    officialUrl: 'https://www.fide.com/wcc',
    scheduledStart: '2026-11-20T09:00:00.000Z',
    scheduledEnd: '2026-12-08T09:00:00.000Z',
    totalGames: opts.totalGames ?? 14,
    playerA: GUKESH,
    playerB: DING,
    sourceEventRefs: (opts.refs ?? { D3: `d3-${cycleKey}` }) as Record<string, string>,
  });
  await forcePhase({ db: prisma, logger }, 'admin-1', cycle.id, {
    phase: 'tournament',
    reason: 'Match started',
    lock: false,
  });
  return cycle;
}

const confirm = (
  cycleId: string,
  n: number,
  result: '1-0' | '0-1' | '1/2-1/2',
  at: string,
  extra = {},
) =>
  confirmGame({ db: prisma, logger, now: () => new Date(at) }, 'admin-1', cycleId, 'classical', n, {
    result,
    attested: true,
    ...extra,
  });

const game = (cycleId: string, n: number, kind = 'classical') =>
  prisma.championship_games.findFirstOrThrow({
    where: { cycle_id: cycleId, kind, game_number: n },
  });

const ledger = (cycleKey: string, n: number, kind = 'game') =>
  prisma.detected_events.findUnique({ where: { identity_key: `${cycleKey}:${kind}-${n}:result` } });

const oppCount = async (cycleKey: string) =>
  prisma.post_opportunities.count({ where: { dedupe_key: { startsWith: `1.1:${cycleKey}:` } } });

beforeAll(async () => {
  pgc = await freshDb();
  prisma = new PrismaClient({ datasourceUrl: `${inject('dbUrl')}?schema=smb` });
  const set = loadConfigSet();
  baseRegistry = set.sources;
  await syncSources(prisma, registryWithD4());
  await syncConfigs(prisma, set);
});

afterAll(async () => {
  await prisma.$disconnect();
  await pgc.end();
});

describe('event detection and trigger ingestion (1.16)', () => {
  it('1-3. A confirmed result gives one ledger row and one opportunity; replays, concurrent polls and restarts add nothing', async () => {
    const key = 'wcc-ev-1';
    const cycle = await tournament(key);
    const d3 = feed({
      rounds: [{ id: 'r1', status: 'completed', finishedAt: '2026-11-21T14:50:00Z' }],
      games: [
        {
          id: 'g1',
          round: '1',
          roundId: 'r1',
          white: GUKESH,
          black: DING,
          result: '1-0',
          playedAt: '2026-11-21T14:45:00Z',
        },
      ],
    });
    const detectors = detectorsFor({ D3: d3 });

    await poll(detectors, '2026-11-21T15:00:00Z');
    expect((await game(cycle.id, 1)).state).toBe('result_observed');
    expect(await oppCount(key)).toBe(0); // one feed never opens an opportunity

    const confirmed = await confirm(cycle.id, 1, '1-0', '2026-11-21T15:10:00Z');
    expect(confirmed.emit?.created).toBe(1);

    const event = await ledger(key, 1);
    expect(event).not.toBeNull();
    expect(event!.version).toBe(1);
    expect(event!.state).toBe('opportunity_created');
    const payload = GameCompletedEvent.parse(event!.payload);
    expect(payload).toMatchObject({
      identityKey: `${key}:game-1:result`,
      championship: { cycleKey: key, postTypeId: '1.1' },
      game: { kind: 'classical', number: 1 },
      players: { white: { name: 'Gukesh D' }, black: { name: 'Ding Liren' } },
      result: '1-0',
      scoreAfter: { a: 1, b: 0, basis: 'classical' },
      completedAt: '2026-11-21T14:45:00.000Z',
      verification: 'official_entry',
    });
    expect(payload.sources.map((s) => s.sourceId)).toEqual(['D1', 'D3']);

    const opp = await prisma.post_opportunities.findUniqueOrThrow({
      where: { id: event!.opportunity_id! },
    });
    expect(opp.dedupe_key).toBe(`1.1:${key}:game-1:result`);
    expect(opp.trigger_event_id).toBe(event!.id);
    expect(opp.trigger_event_version).toBe(1);

    // Replays: five more polls and two direct emits.
    for (let i = 1; i <= 5; i++) await poll(detectors, `2026-11-21T15:1${i}:00Z`);
    await emitPendingGameEvents({ db: prisma, now: new Date('2026-11-21T15:20:00Z') }, cycle.id);
    await emitPendingGameEvents({ db: prisma, now: new Date('2026-11-21T15:21:00Z') }, cycle.id);
    // A replay through the ledger itself is counted, never re-opened.
    const replay = await ingestEvent(
      { db: prisma, now: new Date('2026-11-21T15:22:00Z') },
      { detectorId: CHAMPIONSHIP_DETECTOR_ID, postTypeId: '1.1', payload, actor: 'test' },
    );
    expect(replay).toMatchObject({ status: 'replay', opportunityId: opp.id, version: 1 });
    expect((await ledger(key, 1))!.seen_count).toBe(2);

    // Concurrent polls: one holds the lease, the other is turned away or runs after; still one opportunity.
    await Promise.all([
      poll(detectors, '2026-11-21T15:30:00Z'),
      poll(detectors, '2026-11-21T15:30:00Z'),
    ]);
    // A held lease is respected.
    await prisma.event_pollers.update({
      where: { detector_id: CHAMPIONSHIP_DETECTOR_ID },
      data: { lease_until: new Date('2026-11-21T16:00:00Z'), lease_holder: 'other-instance' },
    });
    const held = await poll(detectors, '2026-11-21T15:31:00Z');
    expect(held.detectors[0]!.outcome).toBe('lease_held');
    await prisma.event_pollers.update({
      where: { detector_id: CHAMPIONSHIP_DETECTOR_ID },
      data: { lease_until: null, lease_holder: null },
    });

    // Restart: a new registry and detector against the same database.
    await poll(detectorsFor({ D3: d3 }), '2026-11-21T15:40:00Z');

    expect(await oppCount(key)).toBe(1);
    expect(
      await prisma.detected_events.count({ where: { identity_key: { startsWith: key } } }),
    ).toBe(1);
    const duplicates = await rows(
      pgc,
      `select count(*)::int as n from smb.trigger_log where opportunity_id = $1 and outcome = 'duplicate'`,
      [opp.id],
    );
    expect((duplicates[0] as { n: number }).n).toBeGreaterThanOrEqual(1);
  });

  it('4-5. A clock stop or broadcast interruption never observes a game; an observed result is sticky through a flap', async () => {
    const key = 'wcc-ev-4';
    const cycle = await tournament(key);
    const g: FeedGame = {
      id: 'g1',
      round: '1',
      roundId: 'r1',
      white: GUKESH,
      black: DING,
      result: '*',
      playedAt: '2026-11-21T14:00:00Z',
    };
    const d3 = feed({ rounds: [{ id: 'r1', status: 'in_progress' }], games: [g] });
    const detectors = detectorsFor({ D3: d3 });

    for (let i = 0; i < 4; i++) await poll(detectors, `2026-11-21T15:0${i}:00Z`);
    d3.games = []; // the game disappears from the broadcast
    await poll(detectors, '2026-11-21T15:05:00Z');
    let row = await game(cycle.id, 1);
    expect(row.state).toBe('in_progress');
    expect(row.result).toBeNull();

    // Observed, then the feed flaps back to '*', then reports the result again.
    d3.games = [{ ...g, result: '1-0' }];
    await poll(detectors, '2026-11-21T15:10:00Z');
    d3.games = [{ ...g, result: '*' }];
    await poll(detectors, '2026-11-21T15:12:00Z');
    await poll(detectors, '2026-11-21T15:14:00Z');
    row = await game(cycle.id, 1);
    expect(row.state).toBe('result_observed');
    expect(row.result).toBe('1-0');
    expect(row.feed_regressed_at).not.toBeNull();
    d3.games = [{ ...g, result: '1-0' }];
    await poll(detectors, '2026-11-21T15:16:00Z');
    row = await game(cycle.id, 1);
    expect(row.state).toBe('result_observed');
    expect(row.feed_regressed_at).toBeNull();

    const regressions = await prisma.championship_log.count({
      where: { cycle_id: cycle.id, kind: 'feed_regressed_game' },
    });
    expect(regressions).toBe(1);
    expect(await oppCount(key)).toBe(0);
    expect(await ledger(key, 1)).toBeNull();
  });

  it('6, 8. Conflicting feeds never confirm; the admin result wins; a feed contradicting a confirmed result only flags', async () => {
    const key = 'wcc-ev-6';
    const cycle = await tournament(key, { refs: { D3: 'd3-ev6', D4: 'd4-ev6' } });
    const base: FeedGame = {
      id: 'g1',
      round: '1',
      roundId: 'r1',
      white: GUKESH,
      black: DING,
      result: '1-0',
      playedAt: '2026-11-21T14:00:00Z',
    };
    const rounds: FeedRound[] = [{ id: 'r1', status: 'in_progress' }];
    const d3 = feed({ rounds, games: [base] });
    const d4 = feed({ rounds, games: [{ ...base, id: 'd4g1', result: '1/2-1/2' }] });
    const detectors = detectorsFor({ D3: d3, D4: d4 });

    await poll(detectors, '2026-11-21T15:00:00Z');
    await poll(detectors, '2026-11-21T15:05:00Z');
    await poll(detectors, '2026-11-21T15:10:00Z');
    const row = await game(cycle.id, 1);
    expect(row.state).toBe('result_observed');
    const flag = await prisma.championship_flags.findFirst({
      where: { cycle_id: cycle.id, kind: 'observation_changed', status: 'open' },
    });
    expect(flag?.severity).toBe('advisory');
    expect(await oppCount(key)).toBe(0);

    const res = await confirm(cycle.id, 1, '1/2-1/2', '2026-11-21T15:20:00Z');
    expect(res.emit?.created).toBe(1);
    const event = await ledger(key, 1);
    expect((event!.payload as { result: string }).result).toBe('1/2-1/2');

    // D3 still says 1-0: game_conflict, no new version, no new opportunity.
    await poll(detectors, '2026-11-21T15:25:00Z');
    const conflict = await prisma.championship_flags.findFirst({
      where: { cycle_id: cycle.id, kind: 'game_conflict', status: 'open' },
    });
    expect(conflict).not.toBeNull();
    const cleared = await prisma.championship_flags.findFirst({
      where: { cycle_id: cycle.id, kind: 'observation_changed', status: 'open' },
    });
    expect(cleared).toBeNull();
    expect((await ledger(key, 1))!.version).toBe(1);
    expect(await oppCount(key)).toBe(1);
  });

  it('7. Corroboration needs two stable syncs; the event records the corroborating sources', async () => {
    const key = 'wcc-ev-7';
    const cycle = await tournament(key, { refs: { D3: 'd3-ev7', D4: 'd4-ev7' } });
    const g: FeedGame = {
      id: 'g1',
      round: '1',
      roundId: 'r1',
      white: DING,
      black: GUKESH,
      result: '0-1',
      playedAt: '2026-11-21T14:00:00Z',
    };
    const rounds: FeedRound[] = [{ id: 'r1', status: 'in_progress' }];
    const detectors = detectorsFor({
      D3: feed({ rounds, games: [g] }),
      D4: feed({ rounds, games: [{ ...g, id: 'd4g1' }] }),
    });

    await poll(detectors, '2026-11-21T15:00:00Z');
    expect((await game(cycle.id, 1)).state).toBe('result_observed');
    await poll(detectors, '2026-11-21T15:01:00Z'); // 60 s later: not stable yet
    expect((await game(cycle.id, 1)).state).toBe('result_observed');
    await poll(detectors, '2026-11-21T15:02:00Z'); // 120 s
    const row = await game(cycle.id, 1);
    expect(row.state).toBe('confirmed');
    expect(row.confirmation_basis).toBe('corroborated');

    const event = GameCompletedEvent.parse((await ledger(key, 1))!.payload);
    expect(event.verification).toBe('corroborated');
    expect(event.scoreAfter).toEqual({ a: 1, b: 0, basis: 'classical' }); // Gukesh won with black
    expect(event.sources.map((s) => s.sourceId)).toEqual(['D1', 'D3', 'D4']);
    expect(await oppCount(key)).toBe(1);
  });

  it('9. A correction versions the event and later events, keeps the opportunities, and marks them stale', async () => {
    const key = 'wcc-ev-9';
    const cycle = await tournament(key);
    await confirm(cycle.id, 1, '1-0', '2026-11-21T15:00:00Z');
    await confirm(cycle.id, 2, '1/2-1/2', '2026-11-22T15:00:00Z');
    expect(await oppCount(key)).toBe(2);
    const before2 = GameCompletedEvent.parse((await ledger(key, 2))!.payload);
    expect(before2.scoreAfter).toEqual({ a: 1.5, b: 0.5, basis: 'classical' });

    const res = await confirm(cycle.id, 1, '0-1', '2026-11-22T16:00:00Z', {
      reason: 'Official FIDE page shows Black won game 1',
    });
    expect(res.corrected).toBe(true);
    expect(res.correctedEvents).toHaveLength(2);

    const e1 = (await ledger(key, 1))!;
    const e2 = (await ledger(key, 2))!;
    expect(e1.version).toBe(2);
    expect((e1.payload as { result: string }).result).toBe('0-1');
    expect(e2.version).toBe(2);
    expect(GameCompletedEvent.parse(e2.payload).scoreAfter).toEqual({
      a: 0.5,
      b: 1.5,
      basis: 'classical',
    });
    expect(await oppCount(key)).toBe(2);
    for (const e of [e1, e2]) {
      const opp = await prisma.post_opportunities.findUniqueOrThrow({
        where: { id: e.opportunity_id! },
      });
      expect(opp.trigger_event_version).toBe(1); // built from v1: 1.17 re-researches it
    }
    const versions = await prisma.detected_event_versions.findMany({
      where: { event_id: e1.id },
      orderBy: { version: 'asc' },
    });
    expect(versions.map((v) => v.reason)).toEqual([
      'first_seen',
      'Official FIDE page shows Black won game 1',
    ]);

    const flag = await prisma.championship_flags.findFirstOrThrow({
      where: { cycle_id: cycle.id, kind: 'result_corrected', status: 'open' },
    });
    expect((flag.detail as { detectedEventId: string }).detectedEventId).toBe(e1.id);

    // Different facts without a reason are refused at the ledger.
    await expect(
      ingestEvent(
        { db: prisma },
        {
          detectorId: CHAMPIONSHIP_DETECTOR_ID,
          postTypeId: '1.1',
          payload: { ...GameCompletedEvent.parse(e1.payload), result: '1-0' },
          actor: 'test',
        },
      ),
    ).rejects.toBeInstanceOf(EventIdentityConflict);

    // The version history is append-only and the identity cannot change.
    await expect(
      pgc.query(`update smb.detected_event_versions set reason = 'x' where event_id = $1`, [e1.id]),
    ).rejects.toThrow(/append-only/);
    await expect(
      pgc.query(`update smb.detected_events set identity_key = 'x' where id = $1`, [e1.id]),
    ).rejects.toThrow(/immutable/);
  });

  it('10-11. A total outage backs off (at most 10 min) and changes nothing; a partial outage does not back off', async () => {
    const key = 'wcc-ev-10';
    const cycle = await tournament(key);
    const d3 = feed({
      rounds: [{ id: 'r1', status: 'in_progress' }],
      games: [{ id: 'g1', round: '1', roundId: 'r1', white: GUKESH, black: DING, result: '*' }],
    });
    const detectors = detectorsFor({ D3: d3 });
    await poll(detectors, '2026-11-21T15:00:00Z');
    const phaseBefore = (
      await prisma.championship_cycles.findUniqueOrThrow({ where: { id: cycle.id } })
    ).phase;

    d3.failEvents = true;
    d3.failGames = true;
    const delays: number[] = [];
    let t = new Date('2026-11-21T15:10:00Z');
    for (let i = 1; i <= 4; i++) {
      const res = await poll(detectors, t.toISOString(), false);
      expect(res.detectors[0]!.outcome).toBe('failed');
      expect(res.detectors[0]!.consecutiveFailures).toBe(i);
      const next = new Date(res.detectors[0]!.nextDueAt!);
      delays.push(next.getTime() - t.getTime());
      // Before the backoff ends the detector is not even asked.
      const early = await poll(detectors, new Date(t.getTime() + 1000).toISOString(), false);
      expect(early.detectors[0]!.outcome).toBe('backoff');
      t = next;
    }
    expect(delays).toEqual([4 * 60_000, 8 * 60_000, MAX_BACKOFF_MS, MAX_BACKOFF_MS]);
    const poller = await prisma.event_pollers.findUniqueOrThrow({
      where: { detector_id: CHAMPIONSHIP_DETECTOR_ID },
    });
    expect(poller.consecutive_failures).toBe(4);
    expect(poller.last_outcome).toBe('failed');
    const after = await prisma.championship_cycles.findUniqueOrThrow({ where: { id: cycle.id } });
    expect(after.phase).toBe(phaseBefore);
    expect((await game(cycle.id, 1)).state).toBe('in_progress');

    // Partial outage: events fail, games still read (whole event). Success resets the counter.
    d3.failGames = false;
    d3.games = [{ ...d3.games[0]!, result: '1/2-1/2' }];
    const partial = await poll(detectors, t.toISOString(), false);
    expect(partial.detectors[0]!.outcome).toBe('partial');
    expect(partial.detectors[0]!.consecutiveFailures).toBe(0);
    expect((await game(cycle.id, 1)).state).toBe('result_observed');
    const reset = await prisma.event_pollers.findUniqueOrThrow({
      where: { detector_id: CHAMPIONSHIP_DETECTOR_ID },
    });
    expect(reset.consecutive_failures).toBe(0);
    expect(reset.last_success_at?.toISOString()).toBe(t.toISOString());
  });

  it('12. Round-aware polling: no games request on a rest day, only the live round while games are played', async () => {
    const key = 'wcc-ev-12';
    await tournament(key);
    const d3 = feed({
      rounds: [
        { id: 'r1', status: 'completed', finishedAt: '2026-11-21T18:00:00Z' },
        { id: 'r2', status: 'upcoming', startsAt: '2026-11-23T14:00:00Z' },
      ],
      games: [
        {
          id: 'g1',
          round: '1',
          roundId: 'r1',
          white: GUKESH,
          black: DING,
          result: '1-0',
          playedAt: '2026-11-21T14:00:00Z',
        },
      ],
    });
    const detectors = detectorsFor({ D3: d3 });
    await poll(detectors, '2026-11-22T10:00:00Z'); // rest day
    expect(d3.requests.filter((r) => r.capability === 'games')).toEqual([]);
    const cycle = await prisma.championship_cycles.findFirstOrThrow({ where: { cycle_key: key } });
    expect(cycle.next_round_at?.toISOString()).toBe('2026-11-23T14:00:00.000Z');
    expect(cycle.any_round_live).toBe(false);

    // Not due 10 min later on a rest day (15 min cadence).
    const notDue = await poll(detectors, '2026-11-22T10:10:00Z', false);
    expect(notDue.detectors[0]!.outcome).toBe('not_due');

    // Round 2 is live: only its PGN is requested.
    d3.requests.length = 0;
    d3.rounds = [
      { id: 'r1', status: 'completed', finishedAt: '2026-11-21T18:00:00Z' },
      { id: 'r2', status: 'in_progress', startsAt: '2026-11-23T14:00:00Z' },
    ];
    await poll(detectors, '2026-11-23T14:30:00Z');
    expect(d3.requests.filter((r) => r.capability === 'games')).toEqual([
      { capability: 'games', query: { roundExternalId: 'r2' } },
    ]);
    const live = await prisma.championship_cycles.findFirstOrThrow({ where: { cycle_key: key } });
    expect(live.any_round_live).toBe(true);
  });

  it('13. Tiebreak games are observed only after an admin binding, then emit their own identity', async () => {
    const key = 'wcc-ev-13';
    const cycle = await tournament(key, { totalGames: 2 });
    await confirm(cycle.id, 1, '1-0', '2026-11-21T18:00:00Z');
    await confirm(cycle.id, 2, '1-0', '2026-11-22T18:00:00Z', { whitePlayer: 'b' }); // Ding won with white: 1-1
    await addTiebreakGame({ db: prisma, logger }, 'admin-1', cycle.id, {
      kind: 'tiebreak',
      gameNumber: 1,
    });

    const tb: FeedGame = {
      id: 'tb-g1',
      round: 'Tiebreak 1',
      roundId: 'tb-r1',
      white: GUKESH,
      black: DING,
      result: '1-0',
      playedAt: '2026-11-23T14:00:00Z',
    };
    const d3 = feed({ rounds: [{ id: 'tb-r1', status: 'in_progress' }], games: [tb] });
    const detectors = detectorsFor({ D3: d3 });
    await poll(detectors, '2026-11-23T14:30:00Z');
    await poll(detectors, '2026-11-23T14:32:00Z');
    expect((await game(cycle.id, 1, 'tiebreak')).state).toBe('scheduled');
    expect(
      await prisma.championship_log.count({
        where: { cycle_id: cycle.id, kind: 'unmapped_feed_game' },
      }),
    ).toBe(1); // logged once, not every sync

    await bindGame({ db: prisma, logger }, 'admin-1', cycle.id, 'tiebreak', 1, {
      d3RoundId: 'tb-r1',
    });
    await poll(detectors, '2026-11-23T14:34:00Z');
    const tbRow = await game(cycle.id, 1, 'tiebreak');
    expect(tbRow.state).toBe('result_observed');
    expect(tbRow.d3_game_id).toBe('tb-g1');

    const res = await confirmGame(
      { db: prisma, logger, now: () => new Date('2026-11-23T14:40:00Z') },
      'admin-1',
      cycle.id,
      'tiebreak',
      1,
      { result: '1-0', attested: true },
    );
    expect(res.emit?.created).toBe(1);
    const event = GameCompletedEvent.parse((await ledger(key, 1, 'tiebreak'))!.payload);
    expect(event.scoreAfter).toEqual({ a: 2, b: 1, basis: 'overall' });
    expect(
      await prisma.post_opportunities.count({
        where: { dedupe_key: `1.1:${key}:tiebreak-1:result` },
      }),
    ).toBe(1);

    // A confirmed, bound game keeps its binding unless forced with a reason.
    await expect(
      bindGame({ db: prisma, logger }, 'admin-1', cycle.id, 'tiebreak', 1, { d3RoundId: 'other' }),
    ).rejects.toMatchObject({ status: 409, code: 'game_confirmed' });
  });

  it('14. An event refused out of phase is recorded, then opens its opportunity once the phase allows it', async () => {
    const key = 'wcc-ev-14';
    await finishCurrentCycle();
    const { cycle } = await registerCycle({ db: prisma, logger }, 'admin-1', {
      cycleKey: key,
      title: 'WCC out of phase',
      officialUrl: 'https://www.fide.com/wcc',
      scheduledStart: '2026-11-20T09:00:00.000Z',
      scheduledEnd: '2026-12-08T09:00:00.000Z',
      totalGames: 14,
      playerA: GUKESH,
      playerB: DING,
    });
    await prisma.championship_cycles.update({
      where: { id: cycle.id },
      data: { phase_locked: true, phase_lock_reason: 'test' },
    });
    // The post type is switched off when the game is confirmed, so the scheduler refuses the event.
    await prisma.post_types.update({ where: { id: '1.1' }, data: { enabled: false } });
    try {
      await confirm(cycle.id, 1, '1-0', '2026-11-21T15:00:00Z');
      const refused = (await ledger(key, 1))!;
      expect(refused.state).toBe('refused');
      expect(refused.refusal_code).toBe('post_type_disabled');
      expect(await oppCount(key)).toBe(0);
    } finally {
      await prisma.post_types.update({ where: { id: '1.1' }, data: { enabled: true } });
    }

    const emit = await emitPendingGameEvents(
      { db: prisma, now: new Date('2026-11-21T15:05:00Z') },
      cycle.id,
    );
    expect(emit.created).toBe(1);
    const opened = (await ledger(key, 1))!;
    expect(opened.state).toBe('opportunity_created');
    expect(opened.refusal_code).toBeNull();
    expect(
      await prisma.detected_events.count({ where: { identity_key: { startsWith: key } } }),
    ).toBe(1);
    expect(await oppCount(key)).toBe(1);
  });
});

describe('event routes (1.16)', () => {
  const secret = new TextEncoder().encode('test-secret-test-secret-test-secret');
  const token = (role: string) =>
    new SignJWT({ smb_role: role })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('xlchess')
      .setAudience('smb')
      .setSubject(`user-${role}`)
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(secret);
  let app: Express;
  let detectors: DetectorRegistry;

  beforeAll(() => {
    detectors = detectorsFor({ D3: feed() });
    const verifier = createTokenVerifier({
      alg: 'HS256',
      key: secret,
      issuer: 'xlchess',
      audience: 'smb',
      userIdClaim: 'sub',
    });
    app = createApp({
      env: loadEnv({ NODE_ENV: 'test' }),
      logger,
      events: { verifier, db: prisma, detectors, logger },
      championships: { verifier, db: prisma, detectors, logger },
    });
  });

  it('15. are admin-only, filter the ledger, show staleness, and run or pause a detector', async () => {
    const admin = `Bearer ${await token('admin')}`;
    expect((await request(app).get('/v1/events')).status).toBe(401);
    expect(
      (
        await request(app)
          .get('/v1/events')
          .set('Authorization', `Bearer ${await token('reviewer')}`)
      ).status,
    ).toBe(403);

    const corrected = await request(app)
      .get('/v1/events?corrected=true&postTypeId=1.1')
      .set('Authorization', admin);
    expect(corrected.status).toBe(200);
    expect(corrected.body.events.length).toBeGreaterThanOrEqual(2);
    expect(corrected.body.events.every((e: { version: number }) => e.version > 1)).toBe(true);

    const detail = await request(app)
      .get(`/v1/events/${corrected.body.events[0].id}`)
      .set('Authorization', admin);
    expect(detail.status).toBe(200);
    expect(detail.body.opportunity.stale).toBe(true);
    expect(detail.body.versions.length).toBe(detail.body.event.version);
    expect(
      (await request(app).get('/v1/events?limit=500').set('Authorization', admin)).status,
    ).toBe(400);

    // Run under a held lease: 409.
    await prisma.event_pollers.upsert({
      where: { detector_id: CHAMPIONSHIP_DETECTOR_ID },
      create: {
        detector_id: CHAMPIONSHIP_DETECTOR_ID,
        post_type_id: '1.1',
        lease_until: new Date(Date.now() + 60_000),
        lease_holder: 'other',
      },
      update: { lease_until: new Date(Date.now() + 60_000), lease_holder: 'other' },
    });
    const busy = await request(app)
      .post(`/v1/event-pollers/${CHAMPIONSHIP_DETECTOR_ID}/run`)
      .set('Authorization', admin);
    expect(busy.status).toBe(409);
    await prisma.event_pollers.update({
      where: { detector_id: CHAMPIONSHIP_DETECTOR_ID },
      data: { lease_until: null, lease_holder: null },
    });
    const ran = await request(app)
      .post(`/v1/event-pollers/${CHAMPIONSHIP_DETECTOR_ID}/run`)
      .set('Authorization', admin);
    expect(ran.status).toBe(200);

    // Pause: the loop skips the detector.
    const paused = await request(app)
      .patch(`/v1/event-pollers/${CHAMPIONSHIP_DETECTOR_ID}`)
      .set('Authorization', admin)
      .send({ enabled: false });
    expect(paused.body.poller.enabled).toBe(false);
    const skipped = await runEventPoll({ db: prisma, detectors, logger });
    expect(skipped.detectors[0]!.outcome).toBe('disabled');
    const list = await request(app).get('/v1/event-pollers').set('Authorization', admin);
    expect(list.body.pollers[0]).toMatchObject({ id: CHAMPIONSHIP_DETECTOR_ID, enabled: false });
    expect(
      (
        await request(app)
          .patch('/v1/event-pollers/nope')
          .set('Authorization', admin)
          .send({ enabled: true })
      ).status,
    ).toBe(404);

    // Championship routes: bind a game, and sync through the poller.
    const current = await prisma.championship_cycles.findFirstOrThrow({
      where: { post_type_id: '1.1', is_current: true },
    });
    const bindUrl = `/v1/championships/${current.id}/games/classical/14`;
    const bound = await request(app)
      .patch(bindUrl)
      .set('Authorization', admin)
      .send({ d3RoundId: 'round-14' });
    expect(bound.status).toBe(200);
    expect(bound.body.game).toMatchObject({ gameNumber: 14, d3RoundId: 'round-14' });
    expect((await request(app).patch(bindUrl).set('Authorization', admin).send({})).status).toBe(
      400,
    );
    await request(app)
      .patch(`/v1/event-pollers/${CHAMPIONSHIP_DETECTOR_ID}`)
      .set('Authorization', admin)
      .send({ enabled: true });
    const synced = await request(app)
      .post(`/v1/championships/${current.id}/sync`)
      .set('Authorization', admin);
    expect(synced.status).toBe(200);
    expect(synced.body.poll).toMatchObject({ id: CHAMPIONSHIP_DETECTOR_ID, outcome: 'ok' });
    const cycleDetail = await request(app)
      .get(`/v1/championships/${current.id}`)
      .set('Authorization', admin);
    expect(cycleDetail.body.poller).toMatchObject({ lastOutcome: 'ok', consecutiveFailures: 0 });
    expect(cycleDetail.body.games[0]).toHaveProperty('detectedEventId');

    const audits = await prisma.audit_log.count({
      where: { target_type: 'event_poller', target_id: CHAMPIONSHIP_DETECTOR_ID },
    });
    expect(audits).toBe(3); // run, pause and resume; the 404 is not audited
    expect(
      await prisma.audit_log.count({ where: { action: 'championship.bind_game' } }),
    ).toBeGreaterThanOrEqual(1);
  });
});
