import { PrismaClient } from '@prisma/client';
import type { Express } from 'express';
import { SignJWT } from 'jose';
import request from 'supertest';
import type pg from 'pg';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { createApp } from '../../../apps/api/src/app.js';
import { createTokenVerifier } from '../../../apps/api/src/auth/index.js';
import { loadConfigSet } from '../../../apps/api/src/config/loader.js';
import { syncConfigs } from '../../../apps/api/src/config/sync.js';
import { loadEnv } from '../../../apps/api/src/env.js';
import { freshDb, rows } from './harness.js';

let pgc: pg.Client;
let prisma: PrismaClient;
let app: Express;
let configId: string;
let counter = 0;

const secret = new TextEncoder().encode('test-secret-test-secret-test-secret');
const token = (role: string): Promise<string> =>
  new SignJWT({ smb_role: role })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('xlchess')
    .setAudience('smb')
    .setSubject('user-1')
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(secret);

async function failedOpportunity(): Promise<{ opportunity: string; job: string }> {
  const n = ++counter;
  const [o] = await rows<{ id: string }>(
    pgc,
    `insert into smb.post_opportunities (post_type_id, post_config_id, dedupe_key, trigger_kind, status, failed_step, failure_reason)
     values ('1.1', $1, $2, 'manual', 'failed', 'generating', 'graphics_render dead') returning id`,
    [configId, `test:1.17-routes:${n}`],
  );
  const [j] = await rows<{ id: string }>(
    pgc,
    `insert into smb.jobs (lane, kind, status, opportunity_id, idempotency_key, attempts, max_attempts, last_error, error_code, payload, job_scope)
     values ('server', 'graphics_render', 'dead', $1, $2, 3, 3, 'storage is unavailable', 'unexpected', '{"x":1}'::jsonb, 'cand-1') returning id`,
    [o!.id, `render:cand-1:rev-1:${n}`],
  );
  return { opportunity: o!.id, job: j!.id };
}

beforeAll(async () => {
  pgc = await freshDb();
  prisma = new PrismaClient({ datasourceUrl: `${inject('dbUrl')}?schema=smb` });
  const set = loadConfigSet();
  await syncConfigs(prisma, set);
  const [active] = await rows<{ id: string }>(
    pgc,
    "select id from smb.post_configs where post_type_id = '1.1' and is_active",
  );
  configId = active!.id;
  const verifier = createTokenVerifier({
    alg: 'HS256',
    key: secret,
    issuer: 'xlchess',
    audience: 'smb',
    userIdClaim: 'sub',
  });
  app = createApp({
    env: loadEnv({ NODE_ENV: 'test' }),
    logger: pino({ level: 'silent' }),
    workflow: { verifier, db: prisma },
  });
});
afterAll(async () => {
  await prisma.$disconnect();
  await pgc.end();
});

describe('workflow administration routes', () => {
  it('needs an admin: 401 without a token, 403 for a reviewer', async () => {
    expect((await request(app).get('/v1/admin/jobs')).status).toBe(401);
    const res = await request(app)
      .get('/v1/admin/jobs')
      .set('Authorization', `Bearer ${await token('reviewer')}`);
    expect(res.status).toBe(403);
  });

  it('lists jobs without their payloads, filtered by status', async () => {
    const { job } = await failedOpportunity();
    const res = await request(app)
      .get('/v1/admin/jobs?status=dead&kind=graphics_render')
      .set('Authorization', `Bearer ${await token('admin')}`);
    expect(res.status).toBe(200);
    const found = res.body.jobs.find((j: { id: string }) => j.id === job);
    expect(found).toMatchObject({
      kind: 'graphics_render',
      status: 'dead',
      attempts: 3,
      lastError: 'storage is unavailable',
      scope: 'cand-1',
    });
    expect(found.payload).toBeUndefined();
  });

  it('retries a failed opportunity from its failed step and refuses a second retry', async () => {
    const { opportunity } = await failedOpportunity();
    const auth = `Bearer ${await token('admin')}`;
    const res = await request(app)
      .post(`/v1/admin/opportunities/${opportunity}/retry`)
      .set('Authorization', auth);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ step: 'generating' });
    expect(res.body.requeued).toHaveLength(1);

    const view = await request(app)
      .get(`/v1/opportunities/${opportunity}/workflow`)
      .set('Authorization', auth);
    expect(view.body).toMatchObject({ status: 'generating', failedStep: null });
    expect(view.body.history.at(-1)).toMatchObject({ to: 'generating', actor: 'user:user-1' });
    expect(view.body.jobs.map((j: { status: string }) => j.status).sort()).toEqual([
      'dead',
      'queued',
    ]);

    const again = await request(app)
      .post(`/v1/admin/opportunities/${opportunity}/retry`)
      .set('Authorization', auth);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('not_failed');
    const audit = await rows<{ n: string }>(
      pgc,
      "select count(*) n from smb.audit_log where action = 'workflow.resume' and target_id = $1",
      [opportunity],
    );
    expect(Number(audit[0]!.n)).toBe(1);
  });

  it('cancels and reprioritises a waiting job but not a finished one', async () => {
    const { opportunity } = await failedOpportunity();
    const auth = `Bearer ${await token('admin')}`;
    const retried = await request(app)
      .post(`/v1/admin/opportunities/${opportunity}/retry`)
      .set('Authorization', auth);
    const queued = (
      await rows<{ id: string }>(
        pgc,
        "select id from smb.jobs where opportunity_id = $1 and status = 'queued'",
        [opportunity],
      )
    )[0]!.id;
    expect(retried.status).toBe(200);

    const re = await request(app)
      .post(`/v1/admin/jobs/${queued}/reprioritise`)
      .set('Authorization', auth)
      .send({ priority: 5 });
    expect(re.status).toBe(200);
    const cancel = await request(app)
      .post(`/v1/admin/jobs/${queued}/cancel`)
      .set('Authorization', auth);
    expect(cancel.body).toMatchObject({ status: 'cancelled' });
    const second = await request(app)
      .post(`/v1/admin/jobs/${queued}/cancel`)
      .set('Authorization', auth);
    expect(second.status).toBe(409);
    expect(
      (
        await request(app)
          .post(`/v1/admin/jobs/${queued}/reprioritise`)
          .set('Authorization', auth)
          .send({ priority: 1 })
      ).status,
    ).toBe(409);
  });
});
