import { PrismaClient } from '@prisma/client';
import type { Express } from 'express';
import { SignJWT } from 'jose';
import request from 'supertest';
import type pg from 'pg';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { createApp } from '../../../apps/api/src/app.js';
import { createTokenVerifier, type TokenVerifier } from '../../../apps/api/src/auth/index.js';
import { loadConfigSet } from '../../../apps/api/src/config/loader.js';
import { syncConfigs } from '../../../apps/api/src/config/sync.js';
import { loadEnv } from '../../../apps/api/src/env.js';
import { ContextResolvers } from '../../../apps/api/src/scheduling/context.js';
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

beforeAll(async () => {
  pgc = await freshDb();
  prisma = new PrismaClient({ datasourceUrl: `${inject('dbUrl')}?schema=smb` });
  const set = loadConfigSet();
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

  app = createApp({
    env,
    logger,
    scheduling: {
      verifier,
      db: prisma,
      resolvers,
      logger,
    },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
  await pgc.end();
});

describe('scheduling administration routes', () => {
  it('answers 401 without a token', async () => {
    const res = await request(app).get('/v1/schedules');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthorized');
  });

  it('answers 403 for a reviewer role (admin required)', async () => {
    const reviewerToken = await token({ smb_role: 'reviewer' });
    const res = await request(app)
      .get('/v1/schedules')
      .set('Authorization', `Bearer ${reviewerToken}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('forbidden');
  });

  it('validates request bodies (400)', async () => {
    const adminToken = await token({ smb_role: 'admin' });

    // Invalid suspend: reason too short
    const resSuspend = await request(app)
      .post('/v1/schedules/suspend')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ postTypeId: '1.1', reason: 'no' });
    expect(resSuspend.status).toBe(400);

    // Invalid suspend: until in the past
    const pastUntil = new Date(Date.now() - 3600_000).toISOString();
    const resPast = await request(app)
      .post('/v1/schedules/suspend')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ postTypeId: '1.1', reason: 'valid reason', until: pastUntil });
    expect(resPast.status).toBe(400);

    // Invalid manual: reason missing
    const resManual = await request(app)
      .post('/v1/opportunities/manual')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ postTypeId: '1.1' });
    expect(resManual.status).toBe(400);
  });

  it('suspend and resume round trip', async () => {
    const adminToken = await token({ smb_role: 'admin' });
    const futureUntil = new Date(Date.now() + 86400_000).toISOString();

    // 1. Suspend
    const suspendRes = await request(app)
      .post('/v1/schedules/suspend')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        postTypeId: '1.1',
        until: futureUntil,
        reason: 'Temporary editorial suspension',
      });
    expect(suspendRes.status).toBe(200);
    expect(suspendRes.body.postTypeId).toBe('1.1');
    expect(suspendRes.body.reason).toBe('Temporary editorial suspension');

    // 2. Check hold in GET /v1/schedules
    const listRes = await request(app)
      .get('/v1/schedules?postTypeId=1.1')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.holds.length).toBe(1);
    expect(listRes.body.holds[0].postTypeId).toBe('1.1');

    // 3. Resume
    const resumeRes = await request(app)
      .post('/v1/schedules/resume')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ postTypeId: '1.1' });
    expect(resumeRes.status).toBe(200);
    expect(resumeRes.body.resumed).toBe(true);

    // 4. Second resume returns 404
    const repeatResume = await request(app)
      .post('/v1/schedules/resume')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ postTypeId: '1.1' });
    expect(repeatResume.status).toBe(404);
  });

  it('GET /v1/schedules returns schedules with nextRunAt and state', async () => {
    const adminToken = await token({ smb_role: 'admin' });

    // Seed a schedule row
    await prisma.schedules.upsert({
      where: {
        post_type_id_rule_key: { post_type_id: '1.1', rule_key: 'base|UTC|weekly|fri|09:00' },
      },
      create: {
        post_type_id: '1.1',
        rule_key: 'base|UTC|weekly|fri|09:00',
        rule: { kind: 'weekly', day: 'fri', time: '09:00' },
        timezone: 'UTC',
        anchor_at: new Date('2026-11-20T00:00:00Z'),
        cursor_at: new Date('2026-11-20T00:00:00Z'),
        next_run_at: new Date('2026-11-20T09:00:00Z'),
        state: 'active',
      },
      update: {},
    });

    const res = await request(app)
      .get('/v1/schedules?postTypeId=1.1')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.schedules.length).toBeGreaterThan(0);
    const s = res.body.schedules[0];
    expect(s.postTypeId).toBe('1.1');
    expect(s.nextRunAt).toBe('2026-11-20T09:00:00.000Z');
    expect(s.state).toBe('active');
  });

  it('manual opportunity creation: 201 on first call, 200 duplicate on replay, 409 on refusal', async () => {
    const adminToken = await token({ smb_role: 'admin' });
    const idKey = 'custom-unique-idempotency-key-1234';

    // 1. Create opportunity 201
    const createRes = await request(app)
      .post('/v1/opportunities/manual')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', idKey)
      .send({
        postTypeId: '1.1',
        reason: 'Breaking candidate match report',
        phase: 'tournament',
      });

    expect(createRes.status).toBe(201);
    expect(createRes.body.status).toBe('created');
    expect(createRes.body.opportunityId).toBeDefined();

    // 2. Replay with same Idempotency-Key returns 200 duplicate
    const replayRes = await request(app)
      .post('/v1/opportunities/manual')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', idKey)
      .send({
        postTypeId: '1.1',
        reason: 'Breaking candidate match report retry',
        phase: 'tournament',
      });

    expect(replayRes.status).toBe(200);
    expect(replayRes.body.status).toBe('duplicate');
    expect(replayRes.body.opportunityId).toBe(createRes.body.opportunityId);

    // 3. Unknown phase refuses with 409
    const badPhaseRes = await request(app)
      .post('/v1/opportunities/manual')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        postTypeId: '1.1',
        reason: 'Breaking news invalid phase',
        phase: 'invalid_phase_name',
      });

    expect(badPhaseRes.status).toBe(409);
    expect(badPhaseRes.body.error.code).toBe('unknown_phase');
  });

  it('GET /v1/scheduler/log returns newest entries first', async () => {
    const adminToken = await token({ smb_role: 'admin' });

    const res = await request(app)
      .get('/v1/scheduler/log?limit=10')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.log)).toBe(true);
    if (res.body.log.length > 1) {
      const t0 = new Date(res.body.log[0].at).getTime();
      const t1 = new Date(res.body.log[1].at).getTime();
      expect(t0).toBeGreaterThanOrEqual(t1);
    }
  });
});
