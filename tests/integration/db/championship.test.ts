/* eslint-disable @typescript-eslint/no-explicit-any */
import { PrismaClient } from '@prisma/client';
import type {
  ChessEvent,
  ChessGame,
  EventStatus,
  GamePlayer,
  GameResult,
  SourcesRegistry,
} from '@smb/shared';
import type pg from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import {
  addTiebreakGame,
  championshipResolver,
  concludeCycle,
  confirmGame,
  editCycle,
  emitPendingGameEvents,
  forcePhase,
  registerCycle,
  resolveFlag,
  syncChampionship,
  unlockCycle,
} from '../../../apps/api/src/championship/index.js';
import { loadConfigSet } from '../../../apps/api/src/config/loader.js';
import { syncSources } from '../../../apps/api/src/config/sources-sync.js';
import { syncConfigs } from '../../../apps/api/src/config/sync.js';
import { buildResearchPackage } from '../../../apps/api/src/research/index.js';
import { ContextResolvers } from '../../../apps/api/src/scheduling/context.js';
import { runSchedulerTick } from '../../../apps/api/src/scheduling/tick.js';
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

const GUKESH: GamePlayer = {
  name: 'Gukesh D',
  fideId: '46616543',
  title: 'GM',
  federation: 'IND',
};
const DING: GamePlayer = {
  name: 'Ding Liren',
  fideId: '8603677',
  title: 'GM',
  federation: 'CHN',
};

const OK_PGN = (result: GameResult, white = 'Gukesh D', black = 'Ding Liren') =>
  `[Event "WCC 2026"]\n[White "${white}"]\n[Black "${black}"]\n[Result "${result}"]\n\n1. e4 e5 2. Nf3 Nc6 ${result}\n`;

interface FakeFeedState {
  status: EventStatus;
  roundsCount: number;
  completedRounds: number;
  throwError: boolean;
  games: {
    id: string;
    round: string;
    roundId: string;
    white: GamePlayer;
    black: GamePlayer;
    result: GameResult;
    playedAt?: string;
    pgn?: string;
  }[];
}

function makeFakeAdapter(sourceId: string, state: FakeFeedState): ChessDataSource {
  return {
    id: sourceId,
    adapterVersion: `${sourceId.toLowerCase()}-fake/1.0.0`,
    async fetchEvents(query): Promise<RawItem<ChessEvent>[]> {
      if (state.throwError) {
        throw new SourceError('upstream_unavailable', sourceId, 'Simulated outage');
      }
      const ref = query.externalId ?? 'ev-1';
      const rounds = Array.from({ length: state.roundsCount }, (_, idx) => {
        const n = idx + 1;
        const rStatus: EventStatus =
          n <= state.completedRounds
            ? 'completed'
            : state.status === 'in_progress' && n === state.completedRounds + 1
              ? 'in_progress'
              : 'upcoming';
        return {
          externalId: `round-${n}`,
          name: `Round ${n}`,
          status: rStatus,
          startsAt: new Date(Date.UTC(2026, 10, 20 + idx, 9)).toISOString(),
          url: `https://example.org/${sourceId}/${ref}/round-${n}`,
        };
      });
      const url = `https://example.org/${sourceId}/${ref}`;
      return [
        {
          url,
          raw: { ref, status: state.status, rounds },
          data: {
            sourceId,
            externalId: ref,
            name: 'FIDE World Championship 2026',
            url,
            status: state.status,
            startDate: '2026-11-20T09:00:00.000Z',
            endDate: '2026-12-08T09:00:00.000Z',
            location: 'Singapore',
            format: '14-game classical match',
            timeControl: '120 min + 30 sec',
            rounds,
          },
        },
      ];
    },
    async fetchGames(query): Promise<RawItem<ChessGame>[]> {
      if (state.throwError) {
        throw new SourceError('upstream_unavailable', sourceId, 'Simulated outage');
      }
      const ref = query.eventExternalId ?? 'ev-1';
      return state.games.map((g) => {
        const url = `https://example.org/${sourceId}/${ref}/${g.roundId}/${g.id}`;
        const pgn = g.pgn ?? OK_PGN(g.result, g.white.name, g.black.name);
        return {
          url,
          eventTime: g.playedAt,
          raw: pgn,
          data: {
            sourceId,
            externalId: g.id,
            eventExternalId: ref,
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

function makeRegistry(opts: { enableD4?: boolean; zeroCache?: boolean } = {}): SourcesRegistry {
  const reg = structuredClone(baseRegistry);
  for (const s of reg.sources) {
    if (s.kind !== 'data') continue;
    if (s.id === 'D3' && opts.zeroCache) {
      s.limits.cacheTtlSeconds = { events: 0, games: 0 };
      s.limits.minIntervalMs = 0;
    }
    if (s.id === 'D4' && opts.enableD4) {
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

function makeGateway(
  adapters: ChessDataSource[],
  opts: { enableD4?: boolean; zeroCache?: boolean; now?: () => Date } = {},
) {
  const reg = makeRegistry(opts);
  const gw = createSourceGateway(reg, new PrismaSourceRecordStore(prisma), {
    adapters: [officialRecordAdapter(() => prisma), ...adapters],
    now: opts.now,
    sleep: async () => undefined,
  });
  return { gateway: gw, registry: reg };
}

async function finishCurrentCycle() {
  const current = await prisma.championship_cycles.findFirst({
    where: { post_type_id: '1.1', is_current: true },
  });
  if (current && current.phase !== 'post_tournament') {
    await forcePhase({ db: prisma, logger }, 'test-cleanup', current.id, {
      phase: 'post_tournament',
      reason: 'Reset between tests',
      lock: false,
      winner: 'a',
    });
  }
}

async function registerStandard(
  cycleKey: string,
  overrides: Partial<Parameters<typeof registerCycle>[2]> = {},
) {
  await finishCurrentCycle();
  return registerCycle({ db: prisma, logger }, 'admin-1', {
    cycleKey,
    title: `World Championship (${cycleKey})`,
    officialUrl: 'https://www.fide.com/wcc-2026',
    venue: 'Singapore',
    scheduledStart: '2026-11-20T09:00:00.000Z',
    scheduledEnd: '2026-12-08T09:00:00.000Z',
    totalGames: 14,
    playerA: GUKESH,
    playerB: DING,
    sourceEventRefs: { D3: `d3-${cycleKey}` },
    ...overrides,
  });
}

beforeAll(async () => {
  pgc = await freshDb();
  prisma = new PrismaClient({ datasourceUrl: `${inject('dbUrl')}?schema=smb` });
  const set = loadConfigSet();
  baseRegistry = set.sources;
  await syncSources(prisma, makeRegistry({ enableD4: true }));
  await syncConfigs(prisma, set);
});

afterAll(async () => {
  await prisma.$disconnect();
  await pgc.end();
});

describe('World Championship lifecycle (1.15)', () => {
  it('1-2. Register & Resolver: no cycle holds, registration creates rows, 409 while active, ready with D1 ref', async () => {
    const resolver = championshipResolver(prisma);
    const cfg = loadConfigSet().configs.find((c) => c.config.id === '1.1')!.config;

    // No cycle yet -> hold
    const holdRes = await resolver.resolve({
      postTypeId: '1.1',
      config: cfg,
      trigger: 'schedule',
      now: new Date('2026-11-10T09:00:00Z'),
      db: prisma,
    });
    expect(holdRes).toEqual({
      kind: 'hold',
      code: 'no_championship_record',
      reason: expect.stringContaining('POST /v1/championships'),
    });

    const { cycle, games } = await registerStandard('wcc-test-1');
    expect(cycle.phase).toBe('pre_tournament');
    expect(cycle.is_current).toBe(true);
    expect(games).toHaveLength(14);
    expect(games[0]!.idempotency_key).toBe('wcc-test-1:game-1:result');
    expect(games[13]!.idempotency_key).toBe('wcc-test-1:game-14:result');

    // Second register while in pre_tournament -> 409 cycle_in_progress
    await expect(
      registerCycle({ db: prisma, logger }, 'admin-1', {
        cycleKey: 'wcc-test-1b',
        title: 'Duplicate active',
        officialUrl: 'https://www.fide.com/wcc-2026b',
        scheduledStart: '2026-11-20T09:00:00.000Z',
        scheduledEnd: '2026-12-08T09:00:00.000Z',
        totalGames: 14,
        playerA: GUKESH,
        playerB: DING,
      }),
    ).rejects.toMatchObject({ status: 409, code: 'cycle_in_progress' });

    // Resolver now ready
    const readyRes = await resolver.resolve({
      postTypeId: '1.1',
      config: cfg,
      trigger: 'schedule',
      now: new Date('2026-11-10T09:00:00Z'),
      db: prisma,
    });
    expect(readyRes).toEqual({
      kind: 'ready',
      context: {
        phase: 'pre_tournament',
        subject: { eventRefs: { D1: 'wcc-test-1', D3: 'd3-wcc-test-1' } },
        eventKey: 'wcc-test-1',
      },
    });
  });

  it('3. Pre-tournament weekly with 1.14 scheduler: Friday tick creates opportunity; no cycle holds schedule', async () => {
    await finishCurrentCycle();
    // Simulate no current cycle at all for the "no cycle" check by temporarily marking is_current = false
    await prisma.championship_cycles.updateMany({
      where: { post_type_id: '1.1', is_current: true },
      data: { is_current: false },
    });

    const resolvers = new ContextResolvers();
    resolvers.register('1.1', championshipResolver(prisma));

    // Anchor on Wed Nov 11
    await runSchedulerTick(
      { db: prisma, resolvers, logger },
      { now: new Date('2026-11-11T10:00:00Z') },
    );
    const heldSched = await prisma.schedules.findFirstOrThrow({
      where: { post_type_id: '1.1' },
    });
    expect(heldSched.state).toBe('inactive');
    expect(heldSched.inactive_reason).toBe('held_for_review');

    // Register a cycle, then tick across Friday Nov 13 09:00Z
    await registerStandard('wcc-test-3');
    // Activate rule first on Thu Nov 12, then tick Fri Nov 13 09:05Z
    await runSchedulerTick(
      { db: prisma, resolvers, logger },
      { now: new Date('2026-11-12T10:00:00Z') },
    );
    const friTick = await runSchedulerTick(
      { db: prisma, resolvers, logger },
      { now: new Date('2026-11-13T09:05:00Z') },
    );
    expect(friTick.created).toBe(1);

    const opp = await prisma.post_opportunities.findFirstOrThrow({
      where: {
        post_type_id: '1.1',
        dedupe_key: { contains: 'wcc-test-3' },
      },
    });
    expect(opp.phase).toBe('pre_tournament');
    expect(opp.trigger_ref).toEqual({
      eventRefs: { D1: 'wcc-test-3', D3: 'd3-wcc-test-3' },
    });
  });

  it('4. Start: upcoming stays pre; early in_progress flags premature_start & holds; within 24h moves to tournament & suspends weekly', async () => {
    const { cycle } = await registerStandard('wcc-test-4');
    const feed: FakeFeedState = {
      status: 'upcoming',
      roundsCount: 14,
      completedRounds: 0,
      throwError: false,
      games: [],
    };
    const { gateway, registry } = makeGateway([makeFakeAdapter('D3', feed)], { zeroCache: true });

    // Upcoming stays pre
    const s1 = await syncChampionship(
      { db: prisma, gateway, registry, logger },
      { now: new Date('2026-11-17T09:00:00Z'), force: true },
    );
    expect(s1.phase).toBe('pre_tournament');

    // 2 days before start with feed in_progress -> premature_start (blocking)
    feed.status = 'in_progress';
    const s2 = await syncChampionship(
      { db: prisma, gateway, registry, logger },
      { now: new Date('2026-11-18T08:00:00Z'), force: true },
    );
    expect(s2.phase).toBe('pre_tournament');
    expect(s2.flagsOpened).toBe(1);

    const resolvers = new ContextResolvers();
    resolvers.register('1.1', championshipResolver(prisma));
    const heldRes = await resolvers.for('1.1').resolve({
      postTypeId: '1.1',
      config: loadConfigSet().configs.find((c) => c.config.id === '1.1')!.config,
      trigger: 'schedule',
      now: new Date('2026-11-18T08:00:00Z'),
      db: prisma,
    });
    expect(heldRes).toMatchObject({ kind: 'hold', code: 'premature_start' });

    // Within 24h of start -> moves to tournament, sets confirmed_start, clears premature_start
    const s3 = await syncChampionship(
      { db: prisma, gateway, registry, logger },
      { now: new Date('2026-11-20T09:05:00Z'), force: true },
    );
    expect(s3.previousPhase).toBe('pre_tournament');
    expect(s3.phase).toBe('tournament');
    expect(s3.flagsCleared).toBe(1);

    const fresh = await prisma.championship_cycles.findUniqueOrThrow({ where: { id: cycle.id } });
    expect(fresh.confirmed_start).not.toBeNull();

    // Weekly rule becomes inactive/phase_inactive on next 1.14 tick
    await runSchedulerTick(
      { db: prisma, resolvers, logger },
      { now: new Date('2026-11-20T09:10:00Z') },
    );
    const weekly = await prisma.schedules.findFirstOrThrow({ where: { post_type_id: '1.1' } });
    expect(weekly.state).toBe('inactive');
    expect(weekly.inactive_reason).toBe('phase_inactive');
  });

  it('5-6. Game flow, admin confirmation, D3-alone guard, and verified research package (including PGN/round conflicts)', async () => {
    const { cycle } = await registerStandard('wcc-test-5');
    const playedAt = '2026-11-20T14:00:00.000Z';
    const feed: FakeFeedState = {
      status: 'in_progress',
      roundsCount: 2, // intentionally differs from D1's 14 rounds to verify D1 resolves roundsRemaining conflict!
      completedRounds: 1,
      throwError: false,
      games: [
        {
          id: 'g1-d3',
          round: '1.1',
          roundId: 'round-1',
          white: GUKESH,
          black: DING,
          result: '1-0',
          playedAt,
        },
      ],
    };
    const { gateway, registry } = makeGateway([makeFakeAdapter('D3', feed)], { zeroCache: true });

    const syncAt = new Date('2026-11-20T14:05:00Z');
    const s = await syncChampionship(
      { db: prisma, gateway, registry, logger },
      { now: syncAt, force: true },
    );
    expect(s.phase).toBe('tournament');
    expect(s.observedGames).toBe(1);

    // D3 alone only observes; zero opportunities emitted
    const game1Before = await prisma.championship_games.findFirstOrThrow({
      where: { cycle_id: cycle.id, kind: 'classical', game_number: 1 },
    });
    expect(game1Before.state).toBe('result_observed');
    expect(game1Before.post_status).toBe('none');
    expect(game1Before.opportunity_id).toBeNull();

    const emptyEmit = await emitPendingGameEvents({ db: prisma, now: syncAt }, cycle.id);
    expect(emptyEmit.created).toBe(0);

    // Guard check (6): hand-made opportunity pointing only to D3 produces a partial package
    const configRow = await prisma.post_configs.findFirstOrThrow({
      where: { post_type_id: '1.1', is_active: true },
    });
    const d3OnlyOpp = await prisma.post_opportunities.create({
      data: {
        post_type_id: '1.1',
        post_config_id: configRow.id,
        dedupe_key: 'test:d3-only-guard',
        trigger_kind: 'manual',
        trigger_ref: {
          eventRefs: { D3: 'd3-wcc-test-5' },
          gameRef: { sourceId: 'D3', externalId: 'g1-d3' },
        },
        phase: 'tournament',
      },
    });
    const partialPkg = await buildResearchPackage({ db: prisma, gateway, registry }, d3OnlyOpp.id);
    expect(partialPkg.status).toBe('partial');

    // Admin confirms game 1 (attested: true) -> emits immediately
    const confirmAt = new Date('2026-11-20T14:15:00Z');
    const confirmed = await confirmGame(
      { db: prisma, now: () => confirmAt, logger },
      'admin-1',
      cycle.id,
      'classical',
      1,
      { result: '1-0', attested: true },
    );
    expect(confirmed.game.state).toBe('confirmed');
    expect(confirmed.game.post_status).toBe('opportunity_created');
    expect(confirmed.emit?.created).toBe(1);

    const opp = await prisma.post_opportunities.findUniqueOrThrow({
      where: { id: confirmed.game.opportunity_id! },
    });
    expect(opp.dedupe_key).toBe('1.1:wcc-test-5:game-1:result');
    expect(opp.priority).toBe(5);
    expect(opp.phase).toBe('tournament');
    expect((opp.trigger_ref as any).gameRef).toEqual({
      sourceId: 'D1',
      externalId: 'wcc-test-5:game-1',
    });

    // Idempotent repeat confirm + emit -> nothing new
    const repeat = await confirmGame(
      { db: prisma, now: () => confirmAt, logger },
      'admin-1',
      cycle.id,
      'classical',
      1,
      { result: '1-0', attested: true },
    );
    expect(repeat.noOp).toBe(true);
    const repeatEmit = await emitPendingGameEvents({ db: prisma, now: confirmAt }, cycle.id);
    expect(repeatEmit.checked).toBe(0);

    // Research package on the emitted opportunity -> game.result, match.score, match.situation all verified!
    const pkg = await buildResearchPackage({ db: prisma, gateway, registry }, opp.id);
    const claims = await prisma.research_claims.findMany({ where: { package_id: pkg.packageId } });
    const byKey = new Map(claims.map((c) => [c.claim_key, c]));
    expect(byKey.get('game.result')?.verification).toBe('verified');
    expect(byKey.get('match.score')?.verification).toBe('verified');
    expect(byKey.get('match.situation')?.verification).toBe('verified');
    // D1 official settles D3 vs D1 rounds-remaining difference as a resolved conflict
    const pkgRow = await prisma.research_packages.findUniqueOrThrow({
      where: { id: pkg.packageId },
    });
    expect((pkgRow.summary as any).conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          claimKey: 'match.situation',
          resolved: true,
          resolvedAgainst: 'D1',
        }),
      ]),
    );

    // Verify section 7.3 rule: if D3 returns a PGN ending in checkmate for Black while D1 confirmed 1-0,
    // D1 wins and the issue is listed in summary.issues.
    const mateBlackPgn = '[Event "WCC"]\n[Result "1-0"]\n\n1. f3 e5 2. g4 Qh4# 1-0\n';
    feed.games[0]!.pgn = mateBlackPgn;
    await prisma.championship_games.update({
      where: { id: confirmed.game.id },
      data: { pgn: mateBlackPgn },
    });
    const pkgConflict = await buildResearchPackage({ db: prisma, gateway, registry }, opp.id);
    const claims2 = await prisma.research_claims.findMany({
      where: { package_id: pkgConflict.packageId },
    });
    expect(claims2.find((c) => c.claim_key === 'game.result')?.verification).toBe('verified');
    const pkg2Row = await prisma.research_packages.findUniqueOrThrow({
      where: { id: pkgConflict.packageId },
    });
    expect((pkg2Row.summary as any).issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'result_mismatch' })]),
    );
  });

  it('7. Corroboration: two agreeing non-D1 sources confirm & emit; disagreeing sources stay result_observed', async () => {
    const { cycle } = await registerStandard('wcc-test-7', {
      sourceEventRefs: { D3: 'd3-wcc-7', D4: 'd4-wcc-7' },
    });
    const playedAt = '2026-11-20T14:00:00.000Z';
    const d3State: FakeFeedState = {
      status: 'in_progress',
      roundsCount: 14,
      completedRounds: 2,
      throwError: false,
      games: [
        {
          id: 'd3-g1',
          round: '1',
          roundId: 'r1',
          white: GUKESH,
          black: DING,
          result: '1-0',
          playedAt,
        },
        {
          id: 'd3-g2',
          round: '2',
          roundId: 'r2',
          white: DING,
          black: GUKESH,
          result: '1-0',
          playedAt,
        },
      ],
    };
    const d4State: FakeFeedState = {
      status: 'in_progress',
      roundsCount: 14,
      completedRounds: 2,
      throwError: false,
      games: [
        {
          id: 'd4-g1',
          round: '1',
          roundId: 'r1',
          white: GUKESH,
          black: DING,
          result: '1-0',
          playedAt,
        },
        {
          id: 'd4-g2',
          round: '2',
          roundId: 'r2',
          white: DING,
          black: GUKESH,
          result: '0-1',
          playedAt,
        }, // disagrees!
      ],
    };
    const { gateway, registry } = makeGateway(
      [makeFakeAdapter('D3', d3State), makeFakeAdapter('D4', d4State)],
      { enableD4: true, zeroCache: true },
    );

    const s = await syncChampionship(
      { db: prisma, gateway, registry, logger },
      { now: new Date('2026-11-20T14:30:00Z'), force: true },
    );
    expect(s.corroboratedGames).toBe(1);
    expect(s.emit?.created).toBe(1);

    const g1 = await prisma.championship_games.findFirstOrThrow({
      where: { cycle_id: cycle.id, kind: 'classical', game_number: 1 },
    });
    expect(g1.state).toBe('confirmed');
    expect(g1.confirmation_basis).toBe('corroborated');
    expect(g1.confirmed_by).toBe('system');
    expect(g1.post_status).toBe('opportunity_created');

    const g2 = await prisma.championship_games.findFirstOrThrow({
      where: { cycle_id: cycle.id, kind: 'classical', game_number: 2 },
    });
    expect(g2.state).toBe('result_observed');
    expect(g2.post_status).toBe('none');
  });

  it('8. Order (D9): confirming game 3 while game 2 is unconfirmed holds game 3; confirming game 2 emits 2 then 3 in order', async () => {
    const { cycle } = await registerStandard('wcc-test-8');
    await forcePhase({ db: prisma, logger }, 'admin-1', cycle.id, {
      phase: 'tournament',
      reason: 'Start match',
      lock: false,
    });
    const t = new Date('2026-11-21T14:00:00Z');
    await confirmGame({ db: prisma, now: () => t, logger }, 'admin-1', cycle.id, 'classical', 1, {
      result: '1/2-1/2',
      attested: true,
    });

    // Confirm game 3 before game 2 -> held
    const c3 = await confirmGame(
      { db: prisma, now: () => t, logger },
      'admin-1',
      cycle.id,
      'classical',
      3,
      {
        result: '1-0',
        attested: true,
      },
    );
    expect(c3.game.post_status).toBe('held');
    expect(c3.emit?.held).toBe(1);

    // Confirm game 2 -> emits game 2 AND game 3 in order
    const t2 = new Date('2026-11-21T14:10:00Z');
    const c2 = await confirmGame(
      { db: prisma, now: () => t2, logger },
      'admin-1',
      cycle.id,
      'classical',
      2,
      {
        result: '1/2-1/2',
        attested: true,
      },
    );
    expect(c2.emit?.created).toBe(2);

    const gamesAfter = await prisma.championship_games.findMany({
      where: { cycle_id: cycle.id, game_number: { in: [2, 3] } },
      orderBy: { game_number: 'asc' },
    });
    expect(gamesAfter.map((g) => g.post_status)).toEqual([
      'opportunity_created',
      'opportunity_created',
    ]);
  });

  it('9. Stale (D8): confirming game 4 8h after played_at skips as stale; game 5 posts with game 4 in match.score', async () => {
    const { cycle } = await registerStandard('wcc-test-9', { totalGames: 5 });
    await forcePhase({ db: prisma, logger }, 'admin-1', cycle.id, {
      phase: 'tournament',
      reason: 'Start match',
      lock: false,
    });
    const t = new Date('2026-11-22T14:00:00Z');
    for (const n of [1, 2, 3]) {
      await confirmGame({ db: prisma, now: () => t, logger }, 'admin-1', cycle.id, 'classical', n, {
        result: '1/2-1/2',
        attested: true,
      });
    }

    // Set played_at on game 4 to 8 hours earlier
    await prisma.championship_games.updateMany({
      where: { cycle_id: cycle.id, kind: 'classical', game_number: 4 },
      data: { played_at: new Date('2026-11-22T06:00:00Z') },
    });

    const c4 = await confirmGame(
      { db: prisma, now: () => t, logger },
      'admin-1',
      cycle.id,
      'classical',
      4,
      {
        result: '1-0',
        attested: true,
      },
    );
    expect(c4.game.post_status).toBe('stale_skipped');
    expect(c4.game.opportunity_id).toBeNull();
    expect(c4.emit?.staleSkipped).toBe(1);

    const skipLog = await prisma.championship_log.findFirst({
      where: { cycle_id: cycle.id, kind: 'emission_skipped' },
    });
    expect(skipLog).toBeDefined();

    // Game 5 confirmed promptly -> posts and includes game 4 in match.score
    const c5 = await confirmGame(
      { db: prisma, now: () => t, logger },
      'admin-1',
      cycle.id,
      'classical',
      5,
      {
        result: '1/2-1/2',
        attested: true,
      },
    );
    expect(c5.game.post_status).toBe('opportunity_created');

    const { gateway, registry } = makeGateway(
      [
        makeFakeAdapter('D3', {
          status: 'in_progress',
          roundsCount: 5,
          completedRounds: 5,
          throwError: false,
          games: [],
        }),
      ],
      { zeroCache: true },
    );
    const pkg = await buildResearchPackage(
      { db: prisma, gateway, registry },
      c5.game.opportunity_id!,
    );
    const scoreClaim = await prisma.research_claims.findFirstOrThrow({
      where: { package_id: pkg.packageId, claim_key: 'match.score' },
    });
    expect((scoreClaim.value as any).completedGames).toBe(5);
  });

  it('10. Blocking flag: identity_mismatch holds resolver and emission; clears automatically when feed fixed', async () => {
    const { cycle } = await registerStandard('wcc-test-10');
    const feed: FakeFeedState = {
      status: 'in_progress',
      roundsCount: 14,
      completedRounds: 1,
      throwError: false,
      games: [
        {
          id: 'bad-1',
          round: '1',
          roundId: 'r1',
          white: { name: 'Magnus Carlsen', fideId: '1503014' },
          black: DING,
          result: '1-0',
          playedAt: '2026-11-20T14:00:00Z',
        },
      ],
    };
    const { gateway, registry } = makeGateway([makeFakeAdapter('D3', feed)], { zeroCache: true });

    const s1 = await syncChampionship(
      { db: prisma, gateway, registry, logger },
      { now: new Date('2026-11-20T14:05:00Z'), force: true },
    );
    expect(s1.flagsOpened).toBe(1);

    // Confirm game 1 manually -> held/not emitted because blocking flag is open
    const c1 = await confirmGame(
      { db: prisma, now: () => new Date('2026-11-20T14:10:00Z'), logger },
      'admin-1',
      cycle.id,
      'classical',
      1,
      { result: '1-0', attested: true },
    );
    expect(c1.emit?.blocked).toBe(true);
    expect(c1.game.post_status).toBe('none');

    // Resolver holds
    const resolvers = new ContextResolvers();
    resolvers.register('1.1', championshipResolver(prisma));
    const held = await resolvers.for('1.1').resolve({
      postTypeId: '1.1',
      config: loadConfigSet().configs.find((c) => c.config.id === '1.1')!.config,
      trigger: 'schedule',
      now: new Date('2026-11-20T14:15:00Z'),
      db: prisma,
    });
    expect(held).toMatchObject({ kind: 'hold', code: 'identity_mismatch' });

    // Fix feed data -> next sync clears identity_mismatch and emits game 1
    feed.games[0]!.white = GUKESH;
    const s2 = await syncChampionship(
      { db: prisma, gateway, registry, logger },
      { now: new Date('2026-11-20T14:20:00Z'), force: true },
    );
    expect(s2.flagsCleared).toBe(1);
    expect(s2.emit?.created).toBe(1);
  });

  it('11. Correction (D10): bumps result_version, opens result_corrected with opp status, leaves opp untouched; manual resolve only', async () => {
    const { cycle } = await registerStandard('wcc-test-11');
    await forcePhase({ db: prisma, logger }, 'admin-1', cycle.id, {
      phase: 'tournament',
      reason: 'Start',
      lock: false,
    });
    const t = new Date('2026-11-20T14:00:00Z');
    await confirmGame({ db: prisma, now: () => t, logger }, 'admin-1', cycle.id, 'classical', 1, {
      result: '1-0',
      attested: true,
    });
    const g2 = await confirmGame(
      { db: prisma, now: () => t, logger },
      'admin-1',
      cycle.id,
      'classical',
      2,
      { result: '1-0', attested: true },
    );
    const oppId = g2.game.opportunity_id!;
    await prisma.post_opportunities.update({
      where: { id: oppId },
      data: { status: 'awaiting_review' },
    });

    // Correct game 2 to 1/2-1/2
    const corrected = await confirmGame(
      { db: prisma, now: () => new Date('2026-11-20T15:00:00Z'), logger },
      'admin-1',
      cycle.id,
      'classical',
      2,
      { result: '1/2-1/2', attested: true, reason: 'Official FIDE table updated' },
    );
    expect(corrected.corrected).toBe(true);
    expect(corrected.game.result_version).toBe(2);
    expect(corrected.game.result).toBe('1/2-1/2');

    // Opportunity untouched
    const oppAfter = await prisma.post_opportunities.findUniqueOrThrow({ where: { id: oppId } });
    expect(oppAfter.status).toBe('awaiting_review');

    const flag = await prisma.championship_flags.findFirstOrThrow({
      where: { cycle_id: cycle.id, kind: 'result_corrected', status: 'open' },
    });
    expect(flag.detail).toMatchObject({
      oldResult: '1-0',
      newResult: '1/2-1/2',
      opportunityId: oppId,
      opportunityStatus: 'awaiting_review',
    });

    // Resolving manual flag succeeds
    const resolved = await resolveFlag({ db: prisma, logger }, 'admin-1', flag.id, {
      note: 'Reviewer updated candidate post',
    });
    expect(resolved.status).toBe('resolved');

    // Auto-clear flag cannot be resolved manually (400)
    const feed: FakeFeedState = {
      status: 'in_progress',
      roundsCount: 14,
      completedRounds: 0,
      throwError: false,
      games: [],
    };
    feed.status = 'upcoming';
    const { gateway, registry } = makeGateway([makeFakeAdapter('D3', feed)], { zeroCache: true });
    await syncChampionship(
      { db: prisma, gateway, registry, logger },
      { now: new Date('2026-11-20T15:10:00Z'), force: true },
    );
    const autoFlag = await prisma.championship_flags.findFirstOrThrow({
      where: { cycle_id: cycle.id, kind: 'feed_regressed', status: 'open' },
    });
    await expect(
      resolveFlag({ db: prisma, logger }, 'admin-1', autoFlag.id, { note: 'Cannot resolve' }),
    ).rejects.toMatchObject({ status: 400, code: 'auto_clear_flag' });
  });

  it('12. Conclusion: auto-concludes on 14 confirmed + completed + unique winner; early clinch -> flag + conclude; tie -> tiebreak + conclude', async () => {
    // 12a. Auto conclusion (14 games, 7.5 - 6.5)
    const { cycle: c1 } = await registerStandard('wcc-test-12a');
    await forcePhase({ db: prisma, logger }, 'admin-1', c1.id, {
      phase: 'tournament',
      reason: 'Start',
      lock: false,
    });
    const t = new Date('2026-12-05T14:00:00Z');
    for (let n = 1; n <= 14; n++) {
      await confirmGame({ db: prisma, now: () => t, logger }, 'admin-1', c1.id, 'classical', n, {
        result: n === 1 ? '1-0' : '1/2-1/2',
        attested: true,
        whitePlayer: n % 2 === 1 ? 'a' : 'b',
      });
    }
    const feed: FakeFeedState = {
      status: 'completed',
      roundsCount: 14,
      completedRounds: 14,
      throwError: false,
      games: [],
    };
    const { gateway, registry } = makeGateway([makeFakeAdapter('D3', feed)], { zeroCache: true });
    const s = await syncChampionship(
      { db: prisma, gateway, registry, logger },
      { now: new Date('2026-12-05T15:00:00Z'), force: true },
    );
    expect(s.phase).toBe('post_tournament');
    const c1After = await prisma.championship_cycles.findUniqueOrThrow({ where: { id: c1.id } });
    expect(c1After.winner).toBe('a');
    expect(c1After.confirmed_end).not.toBeNull();

    // Weekly rule was inactive during tournament; now active again with no backlog and creates post_tournament opp
    const resolvers = new ContextResolvers();
    resolvers.register('1.1', championshipResolver(prisma));
    // First tick in post_tournament anchors the post_tournament weekly rule with zero backlog
    const anchorTick = await runSchedulerTick(
      { db: prisma, resolvers, logger },
      { now: new Date('2026-12-06T09:00:00Z') },
    );
    expect(anchorTick).toMatchObject({ created: 0, missed: 0, errors: 0 });
    const weekly = await prisma.schedules.findFirstOrThrow({
      where: { post_type_id: '1.1', phase_id: 'post_tournament' },
    });
    expect(weekly.state).toBe('active');

    // Next Friday tick creates the first post_tournament opportunity
    const friTick = await runSchedulerTick(
      { db: prisma, resolvers, logger },
      { now: new Date('2026-12-11T09:05:00Z') },
    );
    expect(friTick).toMatchObject({ created: 1, errors: 0 });
    const postOpp = await prisma.post_opportunities.findFirstOrThrow({
      where: { post_type_id: '1.1', dedupe_key: { contains: 'wcc-test-12a:s20261211' } },
    });
    expect(postOpp.phase).toBe('post_tournament');

    // 12b. Early clinch (8 wins out of 14 in 10 games -> 8.0 > 7.0)
    const { cycle: c2 } = await registerStandard('wcc-test-12b');
    await forcePhase({ db: prisma, logger }, 'admin-1', c2.id, {
      phase: 'tournament',
      reason: 'Start',
      lock: false,
    });
    for (let n = 1; n <= 10; n++) {
      await confirmGame({ db: prisma, now: () => t, logger }, 'admin-1', c2.id, 'classical', n, {
        result: n <= 8 ? '1-0' : '1/2-1/2',
        attested: true,
        whitePlayer: 'a',
      });
    }
    feed.status = 'in_progress';
    feed.completedRounds = 10;
    const sClinch = await syncChampionship(
      { db: prisma, gateway, registry, logger },
      { now: new Date('2026-12-01T15:00:00Z'), force: true },
    );
    expect(sClinch.phase).toBe('tournament');
    const clinchFlag = await prisma.championship_flags.findFirst({
      where: { cycle_id: c2.id, kind: 'conclusion_unconfirmed', status: 'open' },
    });
    expect(clinchFlag).toBeDefined();

    const concluded2 = await concludeCycle({ db: prisma, logger }, 'admin-1', c2.id, {
      winner: 'a',
      attested: true,
      note: 'Player A clinched 9.0-1.0',
    });
    expect(concluded2.phase).toBe('post_tournament');

    // 12c. Tie after 14 -> no_unique_winner -> add tiebreak -> conclude
    const { cycle: c3 } = await registerStandard('wcc-test-12c');
    await forcePhase({ db: prisma, logger }, 'admin-1', c3.id, {
      phase: 'tournament',
      reason: 'Start',
      lock: false,
    });
    for (let n = 1; n <= 14; n++) {
      await confirmGame({ db: prisma, now: () => t, logger }, 'admin-1', c3.id, 'classical', n, {
        result: '1/2-1/2',
        attested: true,
      });
    }
    feed.status = 'completed';
    feed.completedRounds = 14;
    const sTie = await syncChampionship(
      { db: prisma, gateway, registry, logger },
      { now: new Date('2026-12-05T15:00:00Z'), force: true },
    );
    expect(sTie.phase).toBe('tournament');
    const tieFlag = await prisma.championship_flags.findFirst({
      where: { cycle_id: c3.id, kind: 'no_unique_winner', status: 'open' },
    });
    expect(tieFlag).toBeDefined();

    const tb1 = await addTiebreakGame({ db: prisma, logger }, 'admin-1', c3.id, {
      kind: 'tiebreak',
      gameNumber: 1,
    });
    expect(tb1.idempotency_key).toBe('wcc-test-12c:tiebreak-1:result');
    await concludeCycle({ db: prisma, logger }, 'admin-1', c3.id, {
      winner: 'b',
      attested: true,
      note: 'Player B won rapid tiebreaks',
    });
  });

  it('13. No backwards move (DB guard), forcePhase locks phase, sync only logs while locked', async () => {
    const { cycle } = await registerStandard('wcc-test-13');
    await forcePhase({ db: prisma, logger }, 'admin-1', cycle.id, {
      phase: 'tournament',
      reason: 'Manual advance',
      lock: false,
    });

    await expect(
      pgc.query(`update smb.championship_cycles set phase = 'pre_tournament' where id = $1`, [
        cycle.id,
      ]),
    ).rejects.toThrow(/may not move backwards/);

    const forced = await forcePhase({ db: prisma, logger }, 'admin-1', cycle.id, {
      phase: 'pre_tournament',
      reason: 'Started accidentally',
      lock: true,
    });
    expect(forced.phase).toBe('pre_tournament');
    expect(forced.phase_locked).toBe(true);

    // Sync with feed in_progress within start window -> locked prevents transition, logs reason
    const feed: FakeFeedState = {
      status: 'in_progress',
      roundsCount: 14,
      completedRounds: 1,
      throwError: false,
      games: [],
    };
    const { gateway, registry } = makeGateway([makeFakeAdapter('D3', feed)], { zeroCache: true });
    const s = await syncChampionship(
      { db: prisma, gateway, registry, logger },
      { now: new Date('2026-11-20T10:00:00Z'), force: true },
    );
    expect(s.phase).toBe('pre_tournament');
    const lockedLog = await prisma.championship_log.findFirst({
      where: { cycle_id: cycle.id, message: { contains: 'locked' } },
    });
    expect(lockedLog).toBeDefined();

    await unlockCycle({ db: prisma, logger }, 'admin-1', cycle.id);
  });

  it('14. Outage: source_error leaves phase/games untouched; after 6h opens feed_unavailable advisory flag', async () => {
    const { cycle } = await registerStandard('wcc-test-14');
    const feed: FakeFeedState = {
      status: 'in_progress',
      roundsCount: 14,
      completedRounds: 0,
      throwError: false,
      games: [],
    };
    const { gateway, registry } = makeGateway([makeFakeAdapter('D3', feed)], { zeroCache: true });
    await syncChampionship(
      { db: prisma, gateway, registry, logger },
      { now: new Date('2026-11-20T10:00:00Z'), force: true },
    );

    feed.throwError = true;
    const sErr = await syncChampionship(
      { db: prisma, gateway, registry, logger },
      { now: new Date('2026-11-20T17:00:00Z'), force: true }, // 7h later
    );
    expect(sErr.lastSyncStatus).toBe('source_error');
    expect(sErr.phase).toBe('tournament');
    expect(sErr.flagsOpened).toBe(1);

    const outageFlag = await prisma.championship_flags.findFirstOrThrow({
      where: { cycle_id: cycle.id, kind: 'feed_unavailable', status: 'open' },
    });
    expect(outageFlag.severity).toBe('advisory');

    // Advisory flag does NOT hold the resolver
    const resolvers = new ContextResolvers();
    resolvers.register('1.1', championshipResolver(prisma));
    const resolved = await resolvers.for('1.1').resolve({
      postTypeId: '1.1',
      config: loadConfigSet().configs.find((c) => c.config.id === '1.1')!.config,
      trigger: 'schedule',
      now: new Date('2026-11-20T17:00:00Z'),
      db: prisma,
    });
    expect(resolved.kind).toBe('ready');
  });

  it('15. Pre- and post-tournament research completeness via D1 + nextCycle edit + registering next championship', async () => {
    // 15a. Pre-tournament package complete with participants from D1
    const { cycle: c1 } = await registerStandard('wcc-test-15a');
    const preFeed: FakeFeedState = {
      status: 'upcoming',
      roundsCount: 14,
      completedRounds: 0,
      throwError: false,
      games: [],
    };
    const { gateway, registry } = makeGateway([makeFakeAdapter('D3', preFeed)], {
      zeroCache: true,
    });
    const configRow = await prisma.post_configs.findFirstOrThrow({
      where: { post_type_id: '1.1', is_active: true },
    });
    const preOpp = await prisma.post_opportunities.create({
      data: {
        post_type_id: '1.1',
        post_config_id: configRow.id,
        dedupe_key: 'test:15a:pre',
        trigger_kind: 'manual',
        trigger_ref: { eventRefs: { D1: 'wcc-test-15a', D3: 'd3-wcc-test-15a' } },
        phase: 'pre_tournament',
      },
    });
    const prePkg = await buildResearchPackage({ db: prisma, gateway, registry }, preOpp.id);
    expect(prePkg.status).toBe('complete');
    const participantsClaim = await prisma.research_claims.findFirstOrThrow({
      where: { package_id: prePkg.packageId, claim_key: 'participants' },
    });
    expect((participantsClaim.value as any[]).length).toBe(2);

    // 15b. Complete cycle + nextCycle -> post_tournament package complete with verified event.outcome & next_cycle.stage
    await forcePhase({ db: prisma, logger }, 'admin-1', c1.id, {
      phase: 'tournament',
      reason: 'Start',
      lock: false,
    });
    const t = new Date('2026-12-05T14:00:00Z');
    await confirmGame({ db: prisma, now: () => t, logger }, 'admin-1', c1.id, 'classical', 1, {
      result: '1-0',
      attested: true,
    });
    await concludeCycle({ db: prisma, logger }, 'admin-1', c1.id, {
      winner: 'a',
      attested: true,
      note: 'Concluded',
    });
    await editCycle({ db: prisma, logger }, 'admin-1', c1.id, {
      nextCycle: {
        stage: 'FIDE Candidates 2028',
        summary: 'Qualification begins early 2027',
        url: 'https://www.fide.com/candidates-2028',
      },
    });

    preFeed.status = 'completed';
    const postOpp = await prisma.post_opportunities.create({
      data: {
        post_type_id: '1.1',
        post_config_id: configRow.id,
        dedupe_key: 'test:15b:post',
        trigger_kind: 'manual',
        trigger_ref: { eventRefs: { D1: 'wcc-test-15a', D3: 'd3-wcc-test-15a' } },
        phase: 'post_tournament',
      },
    });
    const postPkg = await buildResearchPackage({ db: prisma, gateway, registry }, postOpp.id);
    expect(postPkg.status).toBe('complete');
    const postClaims = await prisma.research_claims.findMany({
      where: { package_id: postPkg.packageId },
    });
    expect(postClaims.find((c) => c.claim_key === 'event.outcome')?.verification).toBe('verified');
    expect(postClaims.find((c) => c.claim_key === 'next_cycle.stage')?.verification).toBe(
      'verified',
    );

    // 15c. Registering next cycle resets phase to pre_tournament for the new current record
    const { cycle: c2 } = await registerStandard('wcc-test-15b');
    expect(c2.phase).toBe('pre_tournament');
    expect(c2.is_current).toBe(true);
    const oldCycle = await prisma.championship_cycles.findUniqueOrThrow({ where: { id: c1.id } });
    expect(oldCycle.is_current).toBe(false);
  });

  it('16. Cadence: syncChampionship without force inside interval returns not_due with 0 gateway calls', async () => {
    await registerStandard('wcc-test-16');
    let eventCalls = 0;
    const countingAdapter: ChessDataSource = {
      ...makeFakeAdapter('D3', {
        status: 'upcoming',
        roundsCount: 14,
        completedRounds: 0,
        throwError: false,
        games: [],
      }),
      async fetchEvents(q, ctx) {
        eventCalls++;
        return makeFakeAdapter('D3', {
          status: 'upcoming',
          roundsCount: 14,
          completedRounds: 0,
          throwError: false,
          games: [],
        }).fetchEvents!(q, ctx);
      },
    };
    const { gateway, registry } = makeGateway([countingAdapter], { zeroCache: true });

    const t0 = new Date('2026-11-10T10:00:00Z'); // > 3 days before start -> 60 min cadence
    const s1 = await syncChampionship({ db: prisma, gateway, registry, logger }, { now: t0 });
    expect(s1.lastSyncStatus).toBe('ok');
    expect(eventCalls).toBe(1);

    // 10 min later without force -> not_due, 0 extra calls
    const s2 = await syncChampionship(
      { db: prisma, gateway, registry, logger },
      { now: new Date('2026-11-10T10:10:00Z') },
    );
    expect(s2.skipped).toBe('not_due');
    expect(s2.lastSyncStatus).toBe('not_due');
    expect(eventCalls).toBe(1);
  });

  it('17. championship_log is immutable (update and delete rejected)', async () => {
    const [log] = await rows<{ id: string }>(
      pgc,
      'select id::text from smb.championship_log limit 1',
    );
    expect(log).toBeDefined();

    await expect(
      pgc.query(`update smb.championship_log set message = 'tampered' where id = $1`, [log!.id]),
    ).rejects.toThrow(/append-only/);
    await expect(
      pgc.query(`delete from smb.championship_log where id = $1`, [log!.id]),
    ).rejects.toThrow(/append-only/);
  });
});
