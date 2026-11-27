import { PrismaClient } from '@prisma/client';
import type { Express } from 'express';
import { SignJWT } from 'jose';
import pino from 'pino';
import request from 'supertest';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { WORKER_PROTOCOL_VERSION, promptVersions } from '@smb/shared';
import { createApp } from '../../../apps/api/src/app.js';
import { createTokenVerifier, type TokenVerifier } from '../../../apps/api/src/auth/index.js';
import { loadConfigSet } from '../../../apps/api/src/config/loader.js';
import { syncConfigs } from '../../../apps/api/src/config/sync.js';
import { loadEnv } from '../../../apps/api/src/env.js';
import { effectivePublishMode } from '../../../apps/api/src/publishing/mode.js';
import { InMemoryObjectStore } from '../../../apps/api/src/storage/index.js';
import { createWorkflowDeps } from '../../../apps/api/src/workflow/index.js';
import { ID, freshDb } from './harness.js';

let pgc: pg.Client;
let prisma: PrismaClient;
let app: Express;
let verifier: TokenVerifier;

const secret = new TextEncoder().encode('test-secret-test-secret-test-secret');

async function token(role: 'admin' | 'reviewer' = 'admin', sub = 'admin-1'): Promise<string> {
  return new SignJWT({ smb_role: role })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('xlchess')
    .setAudience('smb')
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(secret);
}

beforeAll(async () => {
  pgc = await freshDb();
  prisma = new PrismaClient({ datasourceUrl: `${inject('dbUrl')}?schema=smb` });
  const configSet = loadConfigSet();
  await syncConfigs(prisma, configSet);

  const env = loadEnv({ NODE_ENV: 'test', SMB_AI_PROVIDER: 'worker' });
  const logger = pino({ level: 'silent' });
  const store = new InMemoryObjectStore();
  verifier = createTokenVerifier({
    alg: 'HS256',
    key: secret,
    issuer: 'xlchess',
    audience: 'smb',
    userIdClaim: 'sub',
  });
  const wfDeps = createWorkflowDeps({ db: prisma, store, configSet, env, logger });
  app = createApp({
    env,
    logger,
    review: {
      verifier,
      read: { db: prisma, store, channels: configSet.channels, signedUrlSeconds: 300 },
      act: {
        db: prisma,
        store,
        channels: configSet.channels,
        publishModeOf: () => effectivePublishMode(prisma, env),
      },
    },
    worker: { db: prisma, workflow: wfDeps, env, logger },
    admin: { verifier, db: prisma, configSet, env },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
  await pgc.end();
});

describe('admin routes (config overrides, versions, audit, worker pause/resume, actor_role)', () => {
  it('supports PUT, GET, DELETE config overrides, 422 on invalid patch, 404 on unknown type, and lists versions', async () => {
    const admin = await token('admin');

    const badPut = await request(app)
      .put('/v1/admin/post-types/1.1/overrides')
      .set('Authorization', `Bearer ${admin}`)
      .send({ patch: { priority: -1 } });
    expect(badPut.status).toBe(422);
    expect(badPut.body.error.code).toBe('config_override_invalid');

    const unknown = await request(app)
      .put('/v1/admin/post-types/99.99/overrides')
      .set('Authorization', `Bearer ${admin}`)
      .send({ patch: { priority: 10 } });
    expect(unknown.status).toBe(404);

    const put = await request(app)
      .put('/v1/admin/post-types/1.1/overrides')
      .set('Authorization', `Bearer ${admin}`)
      .send({ patch: { priority: 42 } });
    expect(put.status).toBe(200);

    const get = await request(app)
      .get('/v1/admin/post-types/1.1/config')
      .set('Authorization', `Bearer ${admin}`);
    expect(get.status).toBe(200);
    expect(get.body.origin).toBe('override');
    expect(get.body.config.priority).toBe(42);

    const del = await request(app)
      .delete('/v1/admin/post-types/1.1/overrides')
      .set('Authorization', `Bearer ${admin}`);
    expect(del.status).toBe(200);

    const getAfter = await request(app)
      .get('/v1/admin/post-types/1.1/config')
      .set('Authorization', `Bearer ${admin}`);
    expect(getAfter.body.origin).toBe('file');

    const versions = await request(app)
      .get('/v1/admin/configs/versions?postTypeId=1.1')
      .set('Authorization', `Bearer ${admin}`);
    expect(versions.status).toBe(200);
    expect(versions.body.versions.length).toBeGreaterThanOrEqual(3);
    expect(versions.body.versions[0]).toMatchObject({
      postTypeId: '1.1',
      isActive: true,
      hasOverride: false,
    });
  });

  it('queries audit log with filters and cursor paging', async () => {
    const admin = await token('admin');
    for (let i = 0; i < 4; i++) {
      await prisma.audit_log.create({
        data: {
          actor: 'paging-actor',
          action: 'test.page',
          target_type: 'item',
          target_id: `item-${i}`,
          details: { seq: i },
        },
      });
    }

    const page1 = await request(app)
      .get('/v1/admin/audit?actor=paging-actor&action=test.page&limit=2')
      .set('Authorization', `Bearer ${admin}`);
    expect(page1.status).toBe(200);
    expect(page1.body.entries).toHaveLength(2);
    expect(page1.body.entries[0].details.seq).toBe(3);
    expect(page1.body.nextBefore).toBeTruthy();

    const page2 = await request(app)
      .get(
        `/v1/admin/audit?actor=paging-actor&action=test.page&limit=2&before=${page1.body.nextBefore}`,
      )
      .set('Authorization', `Bearer ${admin}`);
    expect(page2.status).toBe(200);
    expect(page2.body.entries).toHaveLength(2);
    expect(page2.body.entries[0].details.seq).toBe(1);
  });

  it('pauses and resumes a worker so pause blocks claims and resume allows them', async () => {
    const admin = await token('admin');
    const code = await request(app)
      .post('/v1/admin/workers/pairing-codes')
      .set('Authorization', `Bearer ${admin}`)
      .send({ label: 'pause-pc' });
    const paired = await request(app).post('/worker/v1/pair').send({
      pairingCode: code.body.code,
      workerVersion: '0.1.0',
      hostname: 'pause-pc',
      os: 'Windows 11',
      gpu: null,
    });
    const { workerId, deviceToken } = paired.body as { workerId: string; deviceToken: string };

    const pause = await request(app)
      .post(`/v1/admin/workers/${workerId}/pause`)
      .set('Authorization', `Bearer ${admin}`)
      .send({});
    expect(pause.status).toBe(200);
    expect(pause.body.paused).toBe(true);

    const blocked = await request(app)
      .post('/worker/v1/jobs/claim')
      .set('Authorization', `Bearer ${deviceToken}`)
      .send({
        protocolVersion: WORKER_PROTOCOL_VERSION,
        workerVersion: '0.1.0',
        promptVersions: promptVersions(),
      });
    expect(blocked.status).toBe(204);

    const resume = await request(app)
      .post(`/v1/admin/workers/${workerId}/resume`)
      .set('Authorization', `Bearer ${admin}`)
      .send({});
    expect(resume.status).toBe(200);
    expect(resume.body.paused).toBe(false);

    const claimed = await request(app)
      .post('/worker/v1/jobs/claim')
      .set('Authorization', `Bearer ${deviceToken}`)
      .send({
        protocolVersion: WORKER_PROTOCOL_VERSION,
        workerVersion: '0.1.0',
        promptVersions: promptVersions(),
      });
    expect(claimed.status).toBe(200);
    expect(claimed.body.kind).toBe('worker_selftest');
  });

  it('records actor_role on review_actions and audit_log details from reviewer JWT', async () => {
    const reviewer = await token('reviewer', 'reviewer-99');
    await prisma.post_opportunities.update({
      where: { id: ID.opportunity },
      data: { status: 'awaiting_review' },
    });

    const res = await request(app)
      .post(`/v1/opportunities/${ID.opportunity}/defer`)
      .set('Authorization', `Bearer ${reviewer}`)
      .send({ feedback: 'Hold for tomorrow morning' });
    expect(res.status).toBe(201);

    const action = await prisma.review_actions.findUniqueOrThrow({
      where: { id: res.body.actionId },
    });
    expect(action.actor_role).toBe('reviewer');

    const audit = await prisma.audit_log.findFirstOrThrow({
      where: { action: 'review.defer', target_id: ID.opportunity },
      orderBy: { id: 'desc' },
    });
    expect((audit.details as { role?: string }).role).toBe('reviewer');
  });
});
