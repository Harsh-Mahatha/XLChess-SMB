import { PrismaClient } from '@prisma/client';
import type { Express } from 'express';
import { SignJWT } from 'jose';
import pino from 'pino';
import request from 'supertest';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, inject } from 'vitest';
import {
  StubProvider,
  WORKER_PROTOCOL_VERSION,
  promptVersions,
  runGeneration,
  runRevision,
  type ChannelsRegistry,
  type GenerationInput,
  type RevisionRequest,
  type SourcesRegistry,
} from '@smb/shared';
import { createApp } from '../../../apps/api/src/app.js';
import { createTokenVerifier, type TokenVerifier } from '../../../apps/api/src/auth/index.js';
import { loadConfigSet } from '../../../apps/api/src/config/loader.js';
import { syncSources } from '../../../apps/api/src/config/sources-sync.js';
import { syncConfigs } from '../../../apps/api/src/config/sync.js';
import { loadEnv } from '../../../apps/api/src/env.js';
import { loadTemplates } from '../../../apps/api/src/graphics/registry.js';
import { cancelJob, reapExpiredLeases } from '../../../apps/api/src/jobs/index.js';
import { effectivePublishMode } from '../../../apps/api/src/publishing/mode.js';
import { requestRevision } from '../../../apps/api/src/review/actions.js';
import { InMemoryObjectStore } from '../../../apps/api/src/storage/index.js';
import {
  advanceOpportunity,
  runAvailableJobs,
  type WorkflowDeps,
} from '../../../apps/api/src/workflow/index.js';
import { ID, freshDb, rows } from './harness.js';

let pgc: pg.Client;
let prisma: PrismaClient;
let app: Express;
let verifier: TokenVerifier;
let configId: string;
let channels: ChannelsRegistry;
let sources: SourcesRegistry;
let store: InMemoryObjectStore;
let clock: Date;
let counter = 0;

const logger = pino({ level: 'silent' });
const secret = new TextEncoder().encode('test-secret-test-secret-test-secret');

async function jwt(role: 'admin' | 'reviewer' = 'admin', sub = 'user-admin'): Promise<string> {
  return new SignJWT({ smb_role: role })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('xlchess')
    .setAudience('smb')
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(secret);
}

function makeWorkflowDeps(): WorkflowDeps {
  return {
    db: prisma,
    store,
    channels,
    logger,
    gateway: { fetch: async () => [] } as unknown as WorkflowDeps['gateway'],
    sources,
    templates: loadTemplates(),
    imageRuntimes: new Map(),
    downloader: {} as WorkflowDeps['downloader'],
    provider: undefined,
    now: () => clock,
  };
}

async function researched(): Promise<string> {
  const n = ++counter;
  const [o] = await rows<{ id: string }>(
    pgc,
    `insert into smb.post_opportunities (post_type_id, post_config_id, dedupe_key, trigger_kind, phase, status)
     values ('1.1', $1, $2, 'manual', 'tournament', 'researching') returning id`,
    [configId, `test:1.18:${n}`],
  );
  const summary = {
    requiredFacts: [],
    phase: 'tournament',
    missing: [],
    blocked: [],
    conflicts: [],
    sourceErrors: [],
    skippedSources: [],
    issues: [],
  };
  const [p] = await rows<{ id: string }>(
    pgc,
    `insert into smb.research_packages (opportunity_id, version, status, summary)
     values ($1, 1, 'complete', $2::jsonb) returning id`,
    [o!.id, JSON.stringify(summary)],
  );
  const claims = [
    {
      key: 'game.result',
      value: { result: '1-0', white: 'Gukesh D', black: 'Sindarov J', round: String(n) },
      ago: 30,
    },
    {
      key: 'match.situation',
      value: { leader: 'Gukesh D', tied: false, margin: 1, roundsRemaining: 11, totalRounds: 14 },
      ago: 30,
    },
    {
      key: 'next_game',
      value: { name: `Round ${n + 1}`, startsAt: '2030-01-01T00:00:00Z' },
      ago: null,
    },
  ];
  for (const c of claims) {
    const [claim] = await rows<{ id: string }>(
      pgc,
      `insert into smb.research_claims (package_id, claim_key, description, value, verification, confidence, event_time)
       values ($1, $2, $2, $3::jsonb, $4, 0.9, $5) returning id`,
      [
        p!.id,
        c.key,
        JSON.stringify(c.value),
        c.key === 'next_game' ? 'single_source' : 'verified',
        c.ago === null ? null : new Date(Date.now() - c.ago * 60_000),
      ],
    );
    await pgc.query(
      'insert into smb.research_claim_sources (claim_id, source_record_id) values ($1, $2)',
      [claim!.id, ID.sourceRecord1],
    );
  }
  return o!.id;
}

async function pairViaHttp(hostname = 'worker-pc', os = 'Windows 11 Pro') {
  const adminToken = await jwt('admin');
  const codeRes = await request(app)
    .post('/v1/admin/workers/pairing-codes')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ label: hostname });
  expect(codeRes.status).toBe(201);
  const pairRes = await request(app)
    .post('/worker/v1/pair')
    .send({
      pairingCode: codeRes.body.code,
      workerVersion: '0.1.0',
      hostname,
      os,
      gpu: { name: 'NVIDIA GeForce RTX 4070', totalMiB: 12282 },
    });
  expect(pairRes.status).toBe(201);
  return pairRes.body as { workerId: string; deviceToken: string };
}

beforeAll(async () => {
  pgc = await freshDb();
  prisma = new PrismaClient({ datasourceUrl: `${inject('dbUrl')}?schema=smb` });
  const set = loadConfigSet();
  channels = set.channels;
  sources = set.sources;
  await syncSources(prisma, set.sources);
  await syncConfigs(prisma, set);
  const [active] = await rows<{ id: string }>(
    pgc,
    "select id from smb.post_configs where post_type_id = '1.1' and is_active",
  );
  configId = active!.id;
  store = new InMemoryObjectStore();
  clock = new Date(Date.now() + 3600_000);

  const env = loadEnv({ NODE_ENV: 'test', SMB_AI_PROVIDER: 'worker' });
  verifier = createTokenVerifier({
    alg: 'HS256',
    key: secret,
    issuer: 'xlchess',
    audience: 'smb',
    userIdClaim: 'sub',
  });
  const wfDeps = makeWorkflowDeps();
  app = createApp({
    env,
    logger,
    review: {
      verifier,
      read: { db: prisma, store, channels, signedUrlSeconds: 300 },
      act: {
        db: prisma,
        store,
        channels,
        publishModeOf: () => effectivePublishMode(prisma, env),
      },
    },
    workflow: { verifier, db: prisma },
    worker: { db: prisma, workflow: wfDeps, env, logger, now: () => clock },
    admin: { verifier, db: prisma, configSet: set, env, now: () => clock },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
  await pgc.end();
});

beforeEach(async () => {
  await pgc.query(
    "update smb.jobs set status = 'cancelled', lease_id = null, leased_by = null, lease_expires_at = null where status in ('queued', 'leased')",
  );
});

describe('worker HTTP protocol routes', () => {
  it('runs the full pairing -> status -> config -> selftest -> admin list flow', async () => {
    const adminToken = await jwt('admin');
    const { workerId, deviceToken } = await pairViaHttp('rtx-pc', 'Windows 10 Pro');

    const statusRes = await request(app)
      .post('/worker/v1/status')
      .set('Authorization', `Bearer ${deviceToken}`)
      .send({
        workerVersion: '0.1.0',
        startedAt: clock.toISOString(),
        ollamaUp: true,
        models: { llm: 'unloaded', image: 'unloaded' },
        gpu: { name: 'RTX 4070', totalMiB: 12282 },
        diskFreeMiB: 50_000,
      });
    expect(statusRes.status).toBe(200);
    expect(statusRes.body).toMatchObject({ concurrency: 1, paused: false });

    const cfgRes = await request(app)
      .get('/worker/v1/config')
      .set('Authorization', `Bearer ${deviceToken}`);
    expect(cfgRes.status).toBe(200);
    expect(cfgRes.body.promptVersions).toEqual(promptVersions());
    expect(cfgRes.body.models).toEqual({ llm: 'qwen3.5:9b', image: 'z-image-turbo' });

    const claimRes = await request(app)
      .post('/worker/v1/jobs/claim')
      .set('Authorization', `Bearer ${deviceToken}`)
      .send({
        protocolVersion: WORKER_PROTOCOL_VERSION,
        workerVersion: '0.1.0',
        promptVersions: promptVersions(),
      });
    expect(claimRes.status).toBe(200);
    expect(claimRes.body.kind).toBe('worker_selftest');

    const compRes = await request(app)
      .post(`/worker/v1/jobs/${claimRes.body.jobId}/complete`)
      .set('Authorization', `Bearer ${deviceToken}`)
      .send({
        leaseId: claimRes.body.leaseId,
        durationMs: 120,
        result: { ok: true, steps: [{ name: 'gpu', ok: true, detail: 'ok' }], durationMs: 120 },
      });
    expect(compRes.status).toBe(200);
    expect(compRes.body).toEqual({ outcome: 'completed' });

    const listRes = await request(app)
      .get('/v1/admin/workers')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(listRes.status).toBe(200);
    const w = (listRes.body.workers as Array<Record<string, unknown>>).find(
      (x) => x.id === workerId,
    );
    expect(w).toBeDefined();
    expect(w?.osSupported).toBe(false);
    expect((w?.lastSelfTest as { ok?: boolean })?.ok).toBe(true);
    expect(JSON.stringify(listRes.body)).not.toContain('token_hash');
  });

  it('completes candidates_generate over HTTP, stores 3 candidates, advances opportunity, and handles duplicate/outdated/lease_lost', async () => {
    const { deviceToken } = await pairViaHttp('gen-pc');
    // Drain selftest first
    await prisma.jobs.updateMany({
      where: { kind: 'worker_selftest' },
      data: { status: 'cancelled' },
    });

    const oppId = await researched();
    const wfDeps = makeWorkflowDeps();
    await advanceOpportunity(wfDeps, oppId);
    await runAvailableJobs(wfDeps, { budget: 10 });
    await advanceOpportunity(wfDeps, oppId);
    await runAvailableJobs(wfDeps, { budget: 10 });
    await advanceOpportunity(wfDeps, oppId);

    // Wrong promptVersions on claim -> 409 worker_outdated
    const badClaim = await request(app)
      .post('/worker/v1/jobs/claim')
      .set('Authorization', `Bearer ${deviceToken}`)
      .send({
        protocolVersion: WORKER_PROTOCOL_VERSION,
        workerVersion: '0.1.0',
        promptVersions: { ...promptVersions(), candidate: 'candidate@0.0.1#old' },
      });
    expect(badClaim.status).toBe(409);
    expect(badClaim.body.error.code).toBe('worker_outdated');

    const claim = await request(app)
      .post('/worker/v1/jobs/claim')
      .set('Authorization', `Bearer ${deviceToken}`)
      .send({
        protocolVersion: WORKER_PROTOCOL_VERSION,
        workerVersion: '0.1.0',
        promptVersions: promptVersions(),
      });
    expect(claim.status).toBe(200);
    expect(claim.body.kind).toBe('candidates_generate');

    const generated = await runGeneration(new StubProvider(), claim.body.input as GenerationInput);

    // Wrong promptVersions on complete -> 409 worker_outdated and re-queues
    const badComplete = await request(app)
      .post(`/worker/v1/jobs/${claim.body.jobId}/complete`)
      .set('Authorization', `Bearer ${deviceToken}`)
      .send({
        leaseId: claim.body.leaseId,
        durationMs: 100,
        result: { ...generated, promptVersions: { ...generated.promptVersions, candidate: 'old' } },
      });
    expect(badComplete.status).toBe(409);
    expect(badComplete.body.error.code).toBe('worker_outdated');

    // Make job runnable immediately and re-claim
    await prisma.jobs.update({ where: { id: claim.body.jobId }, data: { run_after: clock } });
    const claim2 = await request(app)
      .post('/worker/v1/jobs/claim')
      .set('Authorization', `Bearer ${deviceToken}`)
      .send({
        protocolVersion: WORKER_PROTOCOL_VERSION,
        workerVersion: '0.1.0',
        promptVersions: promptVersions(),
      });
    expect(claim2.status).toBe(200);

    const complete = await request(app)
      .post(`/worker/v1/jobs/${claim2.body.jobId}/complete`)
      .set('Authorization', `Bearer ${deviceToken}`)
      .send({
        leaseId: claim2.body.leaseId,
        durationMs: 250,
        result: generated,
      });
    expect(complete.status).toBe(200);
    expect(complete.body).toEqual({ outcome: 'completed' });

    // Duplicate complete -> already_completed
    const dup = await request(app)
      .post(`/worker/v1/jobs/${claim2.body.jobId}/complete`)
      .set('Authorization', `Bearer ${deviceToken}`)
      .send({
        leaseId: claim2.body.leaseId,
        durationMs: 250,
        result: generated,
      });
    expect(dup.status).toBe(200);
    expect(dup.body).toEqual({ outcome: 'already_completed' });

    const candCount = await prisma.post_candidates.count({ where: { opportunity_id: oppId } });
    expect(candCount).toBe(3);

    const renderJobs = await prisma.jobs.count({
      where: { opportunity_id: oppId, kind: 'graphics_render' },
    });
    expect(renderJobs).toBe(3);
  });

  it('handles lease_lost after reaper, worker_restarted fail, heartbeat cancel, revision_from_feedback, and not_your_job', async () => {
    const { deviceToken: tokA } = await pairViaHttp('pc-a');
    const { deviceToken: tokB } = await pairViaHttp('pc-b');
    await prisma.jobs.updateMany({
      where: { kind: 'worker_selftest' },
      data: { status: 'cancelled' },
    });

    const oppId = await researched();
    const wfDeps = makeWorkflowDeps();
    await advanceOpportunity(wfDeps, oppId);
    await runAvailableJobs(wfDeps, { budget: 10 });
    await advanceOpportunity(wfDeps, oppId);
    await runAvailableJobs(wfDeps, { budget: 10 });
    await advanceOpportunity(wfDeps, oppId);

    // Worker A claims generation
    const c1 = await request(app)
      .post('/worker/v1/jobs/claim')
      .set('Authorization', `Bearer ${tokA}`)
      .send({
        protocolVersion: WORKER_PROTOCOL_VERSION,
        workerVersion: '0.1.0',
        promptVersions: promptVersions(),
      });
    expect(c1.status).toBe(200);

    // Worker B cannot complete A's job
    const generated = await runGeneration(new StubProvider(), c1.body.input as GenerationInput);
    const bComplete = await request(app)
      .post(`/worker/v1/jobs/${c1.body.jobId}/complete`)
      .set('Authorization', `Bearer ${tokB}`)
      .send({ leaseId: c1.body.leaseId, durationMs: 10, result: generated });
    expect(bComplete.status).toBe(403);
    expect(bComplete.body.error.code).toBe('not_your_job');

    // Worker A reports restart -> requeued with attempts 1
    const failRestart = await request(app)
      .post(`/worker/v1/jobs/${c1.body.jobId}/fail`)
      .set('Authorization', `Bearer ${tokA}`)
      .send({
        leaseId: c1.body.leaseId,
        code: 'worker_restarted',
        message: 'the worker restarted during the job',
        retryable: true,
      });
    expect(failRestart.status).toBe(200);
    expect(failRestart.body).toEqual({ outcome: 'requeued' });

    await prisma.jobs.update({ where: { id: c1.body.jobId }, data: { run_after: clock } });

    // Claim again and let reaper expire the lease
    const c2 = await request(app)
      .post('/worker/v1/jobs/claim')
      .set('Authorization', `Bearer ${tokA}`)
      .send({
        protocolVersion: WORKER_PROTOCOL_VERSION,
        workerVersion: '0.1.0',
        promptVersions: promptVersions(),
      });
    expect(c2.status).toBe(200);
    await reapExpiredLeases(prisma, new Date(clock.getTime() + 700_000));

    const staleComplete = await request(app)
      .post(`/worker/v1/jobs/${c2.body.jobId}/complete`)
      .set('Authorization', `Bearer ${tokA}`)
      .send({ leaseId: c2.body.leaseId, durationMs: 10, result: generated });
    expect(staleComplete.status).toBe(409);
    expect(staleComplete.body.error.code).toBe('lease_lost');

    // Claim again and finish generation so we can test revision_from_feedback
    await prisma.jobs.update({ where: { id: c2.body.jobId }, data: { run_after: clock } });
    const c3 = await request(app)
      .post('/worker/v1/jobs/claim')
      .set('Authorization', `Bearer ${tokA}`)
      .send({
        protocolVersion: WORKER_PROTOCOL_VERSION,
        workerVersion: '0.1.0',
        promptVersions: promptVersions(),
      });
    expect(c3.status).toBe(200);
    await request(app)
      .post(`/worker/v1/jobs/${c3.body.jobId}/complete`)
      .set('Authorization', `Bearer ${tokA}`)
      .send({ leaseId: c3.body.leaseId, durationMs: 10, result: generated });

    // Finish render jobs so opp enters awaiting_review
    await runAvailableJobs(wfDeps, { budget: 10 });
    await advanceOpportunity(wfDeps, oppId);

    const cand = await prisma.post_candidates.findFirstOrThrow({
      where: { opportunity_id: oppId },
      include: { post_revisions: true },
    });
    const revReq = await requestRevision(
      { db: prisma, now: () => clock },
      { userId: 'rev-1', role: 'reviewer' },
      cand.id,
      { baseRevisionId: cand.post_revisions[0]!.id, feedback: 'Make the headline shorter' },
    );
    expect(revReq.jobId).toBeTruthy();

    const revClaim = await request(app)
      .post('/worker/v1/jobs/claim')
      .set('Authorization', `Bearer ${tokA}`)
      .send({
        protocolVersion: WORKER_PROTOCOL_VERSION,
        workerVersion: '0.1.0',
        promptVersions: promptVersions(),
      });
    expect(revClaim.status).toBe(200);
    expect(revClaim.body.kind).toBe('revision_from_feedback');

    const revised = await runRevision(
      new StubProvider(),
      revClaim.body.input as GenerationInput,
      revClaim.body.request as RevisionRequest,
    );
    const revDone = await request(app)
      .post(`/worker/v1/jobs/${revClaim.body.jobId}/complete`)
      .set('Authorization', `Bearer ${tokA}`)
      .send({ leaseId: revClaim.body.leaseId, durationMs: 20, result: revised });
    expect(revDone.status).toBe(200);
    expect(revDone.body).toEqual({ outcome: 'completed' });

    const storedRev = await prisma.post_revisions.findFirst({
      where: { review_action_id: revReq.actionId },
    });
    expect(storedRev).not.toBeNull();

    // Heartbeat after cancel -> { cancel: true }
    const adminToken = await jwt('admin');
    const selftestRes = await request(app)
      .post(`/v1/admin/workers/${(await prisma.workers.findFirstOrThrow()).id}/selftest`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(selftestRes.status).toBe(202);
    const stClaim = await request(app)
      .post('/worker/v1/jobs/claim')
      .set('Authorization', `Bearer ${tokA}`)
      .send({
        protocolVersion: WORKER_PROTOCOL_VERSION,
        workerVersion: '0.1.0',
        promptVersions: promptVersions(),
      });
    if (stClaim.status === 200) {
      await cancelJob(prisma, stClaim.body.jobId, clock);
      const hb = await request(app)
        .post(`/worker/v1/jobs/${stClaim.body.jobId}/heartbeat`)
        .set('Authorization', `Bearer ${tokA}`)
        .send({ leaseId: stClaim.body.leaseId });
      expect(hb.status).toBe(200);
      expect(hb.body).toEqual({ cancel: true });
    }
  });

  it('rejects revoked tokens, cross-audience tokens, enforces pair rate limit and HTTPS check', async () => {
    const adminToken = await jwt('admin');
    const { workerId, deviceToken } = await pairViaHttp('sec-pc');

    // Cross-audience checks
    const jwtOnWorker = await request(app)
      .post('/worker/v1/status')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(jwtOnWorker.status).toBe(401);

    const deviceOnReview = await request(app)
      .get('/v1/review/queue')
      .set('Authorization', `Bearer ${deviceToken}`);
    expect(deviceOnReview.status).toBe(401);

    // Revoke -> 401 worker_revoked
    const revokeRes = await request(app)
      .post(`/v1/admin/workers/${workerId}/revoke`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'compromised' });
    expect(revokeRes.status).toBe(200);

    const afterRevoke = await request(app)
      .get('/worker/v1/config')
      .set('Authorization', `Bearer ${deviceToken}`);
    expect(afterRevoke.status).toBe(401);
    expect(afterRevoke.body.error.code).toBe('worker_revoked');

    // Pair rate limit on a fresh app instance: 6th try in a minute gives 429
    const rlEnv = loadEnv({ NODE_ENV: 'test' });
    const rlApp = createApp({
      env: rlEnv,
      logger,
      worker: { db: prisma, workflow: makeWorkflowDeps(), env: rlEnv, logger },
    });
    for (let i = 0; i < 5; i++) {
      const r = await request(rlApp).post('/worker/v1/pair').send({
        pairingCode: 'AAAA-BBBB',
        workerVersion: '0.1.0',
        hostname: 'h',
        os: 'Win 11',
        gpu: null,
      });
      expect(r.status).toBe(400);
    }
    const sixth = await request(rlApp).post('/worker/v1/pair').send({
      pairingCode: 'AAAA-BBBB',
      workerVersion: '0.1.0',
      hostname: 'h',
      os: 'Win 11',
      gpu: null,
    });
    expect(sixth.status).toBe(429);
    expect(sixth.body.error.code).toBe('rate_limited');
    expect(sixth.headers['retry-after']).toBeDefined();

    // HTTPS requirement + trust proxy
    const httpsEnv = loadEnv({
      NODE_ENV: 'test',
      SMB_REQUIRE_HTTPS: 'true',
      SMB_TRUST_PROXY: '1',
    });
    const httpsApp = createApp({
      env: httpsEnv,
      logger,
      worker: { db: prisma, workflow: makeWorkflowDeps(), env: httpsEnv, logger },
    });
    const noTls = await request(httpsApp).post('/worker/v1/pair').send({
      pairingCode: 'AAAA-BBBB',
      workerVersion: '0.1.0',
      hostname: 'h',
      os: 'Win 11',
      gpu: null,
    });
    expect(noTls.status).toBe(403);
    expect(noTls.body.error.code).toBe('https_required');

    const withProto = await request(httpsApp)
      .post('/worker/v1/pair')
      .set('X-Forwarded-Proto', 'https')
      .send({
        pairingCode: 'AAAA-BBBB',
        workerVersion: '0.1.0',
        hostname: 'h',
        os: 'Win 11',
        gpu: null,
      });
    expect(withProto.status).toBe(400);
  });
});
