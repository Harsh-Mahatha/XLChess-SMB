import { PrismaClient } from '@prisma/client';
import type { Express } from 'express';
import { SignJWT } from 'jose';
import type pg from 'pg';
import pino from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { createApp } from '../../../apps/api/src/app.js';
import { createTokenVerifier, type TokenVerifier } from '../../../apps/api/src/auth/index.js';
import { loadConfigSet } from '../../../apps/api/src/config/loader.js';
import { syncSources } from '../../../apps/api/src/config/sources-sync.js';
import { syncConfigs } from '../../../apps/api/src/config/sync.js';
import { loadEnv } from '../../../apps/api/src/env.js';
import { ContextResolvers } from '../../../apps/api/src/scheduling/context.js';
import {
  PrismaSourceRecordStore,
  createSourceGateway,
  officialRecordAdapter,
  type ChessDataSource,
} from '../../../apps/api/src/sources/index.js';
import { freshDb } from './harness.js';

let pgc: pg.Client;
let prisma: PrismaClient;
let app: Express;
let verifier: TokenVerifier;

const secret = new TextEncoder().encode('test-secret-test-secret-test-secret');

async function token(
  claims: Record<string, unknown> = { smb_role: 'admin' },
  sub = 'user-admin',
): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('xlchess')
    .setAudience('smb')
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(secret);
}

const fakeD3: ChessDataSource = {
  id: 'D3',
  adapterVersion: 'd3-route-test/1.0.0',
  async fetchEvents(q) {
    const id = q.externalId ?? 'ev';
    return [
      {
        url: `https://lichess.org/broadcast/${id}`,
        raw: { id },
        data: {
          sourceId: 'D3',
          externalId: id,
          name: 'WCC 2026',
          url: `https://lichess.org/broadcast/${id}`,
          status: 'upcoming',
          rounds: [],
        },
      },
    ];
  },
  async fetchGames() {
    return [];
  },
};

beforeAll(async () => {
  pgc = await freshDb();
  prisma = new PrismaClient({ datasourceUrl: `${inject('dbUrl')}?schema=smb` });
  const set = loadConfigSet();
  await syncSources(prisma, set.sources);
  await syncConfigs(prisma, set);

  const env = loadEnv({ NODE_ENV: 'test' });
  const logger = pino({ level: 'silent' });
  verifier = createTokenVerifier({
    alg: 'HS256',
    key: secret,
    issuer: 'xlchess',
    audience: 'smb',
    userIdClaim: 'sub',
  });

  const resolvers = new ContextResolvers();
  const gateway = createSourceGateway(set.sources, new PrismaSourceRecordStore(prisma), {
    adapters: [officialRecordAdapter(() => prisma), fakeD3],
  });

  app = createApp({
    env,
    logger,
    championships: {
      verifier,
      db: prisma,
      gateway,
      registry: set.sources,
      resolvers,
      logger,
      now: () => new Date('2026-11-20T10:00:00.000Z'),
    },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
  await pgc.end();
});

describe('championship administration routes', () => {
  it('answers 401 without a token and 403 for reviewer role', async () => {
    const unauth = await request(app).get('/v1/championships');
    expect(unauth.status).toBe(401);
    expect(unauth.body.error.code).toBe('invalid_token');

    const reviewerToken = await token({ smb_role: 'reviewer' });
    const forbidden = await request(app)
      .get('/v1/championships')
      .set('Authorization', `Bearer ${reviewerToken}`);
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error.code).toBe('forbidden');
  });

  it('validates payloads (400): bad register, confirm without attested, force-phase without reason', async () => {
    const adminToken = await token({ smb_role: 'admin' });

    const badReg = await request(app)
      .post('/v1/championships')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ cycleKey: 'bad' });
    expect(badReg.status).toBe(400);

    const reg = await request(app)
      .post('/v1/championships')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        cycleKey: 'wcc-routes-2026',
        title: 'World Championship 2026',
        officialUrl: 'https://www.fide.com/wcc-2026',
        venue: 'Singapore',
        scheduledStart: '2026-11-20T09:00:00.000Z',
        scheduledEnd: '2026-12-08T09:00:00.000Z',
        totalGames: 14,
        playerA: { name: 'Gukesh D', fideId: '46616543' },
        playerB: { name: 'Ding Liren', fideId: '8603677' },
        sourceEventRefs: { D3: 'd3-route-test' },
      });
    expect(reg.status).toBe(201);
    const cycleId = reg.body.cycle.id as string;

    const noAttest = await request(app)
      .post(`/v1/championships/${cycleId}/games/classical/1/confirm`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ result: '1-0', attested: false });
    expect(noAttest.status).toBe(400);
    expect(noAttest.body.error.code).toBe('attestation_required');

    const noReason = await request(app)
      .post(`/v1/championships/${cycleId}/phase`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ phase: 'tournament', lock: true });
    expect(noReason.status).toBe(400);
  });

  it('full route lifecycle: list, detail, patch, confirm + concurrent confirm, tiebreak, force/unlock, conclude, resolve flag, sync, and audit_log', async () => {
    const adminToken = await token({ smb_role: 'admin' });

    const listRes = await request(app)
      .get('/v1/championships?current=true')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.championships).toHaveLength(1);
    const cycleId = listRes.body.championships[0].id as string;

    // PATCH edit venue
    const patchRes = await request(app)
      .patch(`/v1/championships/${cycleId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ venue: 'Resorts World Sentosa, Singapore' });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.cycle.venue).toBe('Resorts World Sentosa, Singapore');

    // Sync via route
    const syncRes = await request(app)
      .post(`/v1/championships/${cycleId}/sync`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(syncRes.status).toBe(200);
    expect(syncRes.body.summary.lastSyncStatus).toBe('ok');

    // Force phase to tournament + unlock
    const forceRes = await request(app)
      .post(`/v1/championships/${cycleId}/phase`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ phase: 'tournament', reason: 'Opening ceremony complete', lock: true });
    expect(forceRes.status).toBe(200);
    expect(forceRes.body.cycle.phase).toBe('tournament');
    expect(forceRes.body.cycle.phaseLocked).toBe(true);

    const unlockRes = await request(app)
      .post(`/v1/championships/${cycleId}/unlock`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(unlockRes.status).toBe(200);
    expect(unlockRes.body.cycle.phaseLocked).toBe(false);

    // Add tiebreak game
    const tbRes = await request(app)
      .post(`/v1/championships/${cycleId}/games`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ kind: 'tiebreak', gameNumber: 1 });
    expect(tbRes.status).toBe(201);
    expect(tbRes.body.game.idempotencyKey).toBe('wcc-routes-2026:tiebreak-1:result');

    // Concurrent double confirm on game 1 -> 1 opportunity total
    const [c1a, c1b] = await Promise.all([
      request(app)
        .post(`/v1/championships/${cycleId}/games/classical/1/confirm`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ result: '1-0', attested: true }),
      request(app)
        .post(`/v1/championships/${cycleId}/games/classical/1/confirm`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ result: '1-0', attested: true }),
    ]);
    expect(c1a.status).toBe(200);
    expect(c1b.status).toBe(200);

    const g1OppCount = await prisma.post_opportunities.count({
      where: { dedupe_key: '1.1:wcc-routes-2026:game-1:result' },
    });
    expect(g1OppCount).toBe(1);

    // Correct game 1 -> opens result_corrected flag -> resolve it via route
    const corrRes = await request(app)
      .post(`/v1/championships/${cycleId}/games/classical/1/confirm`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ result: '1/2-1/2', attested: true, reason: 'Corrected by arbiter' });
    expect(corrRes.status).toBe(200);
    expect(corrRes.body.corrected).toBe(true);

    const detailRes = await request(app)
      .get(`/v1/championships/${cycleId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(detailRes.status).toBe(200);
    expect(detailRes.body.score).toEqual({ a: 0.5, b: 0.5, confirmed: 1 });
    expect(detailRes.body.openFlags).toHaveLength(1);
    expect(detailRes.body.nextAction.length).toBeGreaterThan(0);

    const flagId = detailRes.body.openFlags[0].id as string;
    const resolveRes = await request(app)
      .post(`/v1/championships/${cycleId}/flags/${flagId}/resolve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ note: 'Acknowledged by editor' });
    expect(resolveRes.status).toBe(200);
    expect(resolveRes.body.flag.status).toBe('resolved');

    // Conclude cycle
    const concludeRes = await request(app)
      .post(`/v1/championships/${cycleId}/conclude`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ winner: 'a', attested: true, note: 'Match concluded' });
    expect(concludeRes.status).toBe(200);
    expect(concludeRes.body.cycle.phase).toBe('post_tournament');

    // Every mutating route wrote an audit_log row
    const auditActions = (
      await prisma.audit_log.findMany({
        where: { action: { startsWith: 'championship.' } },
        select: { action: true },
      })
    ).map((a) => a.action);
    for (const expectedAction of [
      'championship.register',
      'championship.edit',
      'championship.force_phase',
      'championship.unlock',
      'championship.confirm',
      'championship.correct',
      'championship.resolve_flag',
      'championship.conclude',
    ]) {
      expect(auditActions).toContain(expectedAction);
    }
  });
});
