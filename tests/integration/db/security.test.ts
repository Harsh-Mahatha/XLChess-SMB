import { Writable } from 'node:stream';
import { PrismaClient } from '@prisma/client';
import type { Express } from 'express';
import { SignJWT } from 'jose';
import pino from 'pino';
import request from 'supertest';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { createApp } from '../../../apps/api/src/app.js';
import { createTokenVerifier, type TokenVerifier } from '../../../apps/api/src/auth/index.js';
import { loadConfigSet } from '../../../apps/api/src/config/loader.js';
import { syncConfigs } from '../../../apps/api/src/config/sync.js';
import { loadEnv } from '../../../apps/api/src/env.js';
import { DetectorRegistry } from '../../../apps/api/src/events/index.js';
import { ROUTE_POLICY, mountedRoutes } from '../../../apps/api/src/http/route-policy.js';
import { effectivePublishMode, publishDue } from '../../../apps/api/src/publishing/index.js';
import { ContextResolvers } from '../../../apps/api/src/scheduling/index.js';
import { InMemoryObjectStore } from '../../../apps/api/src/storage/index.js';
import { createPairingCode, pairWorker } from '../../../apps/api/src/workers/index.js';
import { createWorkflowDeps } from '../../../apps/api/src/workflow/index.js';
import { ID, freshDb } from './harness.js';

let pgc: pg.Client;
let prisma: PrismaClient;
let app: Express;
let unconfiguredApp: Express;
let verifier: TokenVerifier;
let deviceToken: string;

const MARKERS = {
  XLCHESS_JWT_SECRET: 'MARKER_JWT_SECRET_9f8e7d6c5b4a3210_9f8e7d6c5b4a3210',
  X_API_KEY: 'MARKER_X_API_KEY_11223344',
  X_API_SECRET: 'MARKER_X_API_SECRET_55667788',
  X_ACCESS_TOKEN: 'MARKER_X_ACCESS_TOKEN_9900aabb',
  X_ACCESS_TOKEN_SECRET: 'MARKER_X_ACCESS_SECRET_ccddeeff',
  SUPABASE_SERVICE_ROLE_KEY: 'MARKER_SUPABASE_SERVICE_ROLE_KEY_778899',
};

const jwtSecret = new TextEncoder().encode(MARKERS.XLCHESS_JWT_SECRET);
const logLines: string[] = [];

async function mint(role: 'reviewer' | 'admin', sub = 'user-1'): Promise<string> {
  return new SignJWT({ smb_role: role })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('xlchess')
    .setAudience('smb')
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(jwtSecret);
}

function concretePath(templatePath: string): string {
  return templatePath
    .replace(':id', ID.opportunity)
    .replace(':kind', 'classical')
    .replace(':number', '1')
    .replace(':flagId', ID.opportunity);
}

beforeAll(async () => {
  pgc = await freshDb();
  prisma = new PrismaClient({ datasourceUrl: `${inject('dbUrl')}?schema=smb` });
  const configSet = loadConfigSet();
  await syncConfigs(prisma, configSet);

  const env = loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'debug',
    SMB_PUBLISH_MODE: 'sandbox',
    XLCHESS_JWT_SECRET: MARKERS.XLCHESS_JWT_SECRET,
    XLCHESS_JWT_ISSUER: 'xlchess',
    XLCHESS_JWT_AUDIENCE: 'smb',
    X_API_KEY: MARKERS.X_API_KEY,
    X_API_SECRET: MARKERS.X_API_SECRET,
    X_ACCESS_TOKEN: MARKERS.X_ACCESS_TOKEN,
    X_ACCESS_TOKEN_SECRET: MARKERS.X_ACCESS_TOKEN_SECRET,
    X_USER_ID: '12345678',
    SUPABASE_SERVICE_ROLE_KEY: MARKERS.SUPABASE_SERVICE_ROLE_KEY,
  });

  const stream = new Writable({
    write(chunk, _enc, cb) {
      logLines.push(chunk.toString());
      cb();
    },
  });
  const { createLogger } = await import('../../../apps/api/src/logger.js');
  const logger = createLogger(env, stream);

  verifier = createTokenVerifier({
    alg: 'HS256',
    key: jwtSecret,
    issuer: 'xlchess',
    audience: 'smb',
    userIdClaim: 'sub',
  });

  const store = new InMemoryObjectStore();
  const modeOf = () => effectivePublishMode(prisma, env);
  const workflowDeps = createWorkflowDeps({ db: prisma, store, configSet, env, logger });
  const resolvers = new ContextResolvers();
  const detectors = new DetectorRegistry();

  const buildFull = (v: TokenVerifier | undefined) =>
    createApp({
      env,
      logger,
      review: {
        verifier: v,
        read: { db: prisma, store, channels: configSet.channels, signedUrlSeconds: 300 },
        act: { db: prisma, store, channels: configSet.channels, publishModeOf: modeOf },
      },
      publishing: {
        db: prisma,
        store,
        channels: configSet.channels,
        env,
        modeOf,
        publishers: {},
        logger,
      },
      scheduling: { verifier: v, db: prisma, resolvers, logger },
      championships: { verifier: v, db: prisma, resolvers, detectors, logger },
      events: { verifier: v, db: prisma, detectors, logger },
      workflow: { verifier: v, db: prisma },
      worker: { db: prisma, workflow: workflowDeps, env, logger },
      admin: { verifier: v, db: prisma, configSet, env },
    });

  app = buildFull(verifier);
  unconfiguredApp = buildFull(undefined);

  const code = await createPairingCode(prisma, { createdBy: 'admin-1' });
  const paired = await pairWorker(prisma, {
    pairingCode: code.code,
    workerVersion: '0.1.0',
    hostname: 'sec-pc',
    os: 'Windows 11',
    gpu: null,
  });
  deviceToken = paired.deviceToken;
});

afterAll(async () => {
  await prisma.$disconnect();
  await pgc.end();
});

describe('security matrix, approval enforcement, and secret scan', () => {
  it('matches every mounted Express route against ROUTE_POLICY', () => {
    const mounted = mountedRoutes(app);
    const key = (r: { method: string; path: string }) => `${r.method} ${r.path}`;
    const mountedSet = new Set(mounted.map(key));
    const policySet = new Set(ROUTE_POLICY.map(key));

    expect([...mountedSet].filter((k) => !policySet.has(k))).toEqual([]);
    expect([...policySet].filter((k) => !mountedSet.has(k))).toEqual([]);
  });

  it('enforces auth, roles, and token audience on every route in ROUTE_POLICY', async () => {
    const reviewerToken = await mint('reviewer', 'rev-1');

    for (const entry of ROUTE_POLICY) {
      const p = concretePath(entry.path);
      const send = (targetApp: Express, token?: string) => {
        const req =
          request(targetApp)[
            entry.method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete'
          ](p);
        if (token) req.set('Authorization', `Bearer ${token}`);
        return entry.method === 'GET' || entry.method === 'DELETE' ? req : req.send({});
      };

      if (entry.access === 'public' || entry.access === 'pairing') {
        continue;
      }

      // No token -> 401
      const noTok = await send(app);
      expect(noTok.status, `${entry.method} ${entry.path} without token`).toBe(401);

      if (entry.access === 'reviewer' || entry.access === 'admin') {
        // Unconfigured verifier -> 503
        const unconf = await send(unconfiguredApp, reviewerToken);
        expect(unconf.status, `${entry.method} ${entry.path} unconfigured`).toBe(503);

        // Device token on /v1 -> 401
        const devOnV1 = await send(app, deviceToken);
        expect(devOnV1.status, `${entry.method} ${entry.path} device token`).toBe(401);
      }

      if (entry.access === 'admin') {
        // Reviewer token on admin route -> 403
        const revOnAdmin = await send(app, reviewerToken);
        expect(revOnAdmin.status, `${entry.method} ${entry.path} reviewer token`).toBe(403);
      }

      if (entry.access === 'worker') {
        // XLChess JWT on worker route -> 401
        const jwtOnWorker = await send(app, reviewerToken);
        expect(jwtOnWorker.status, `${entry.method} ${entry.path} JWT on worker`).toBe(401);
      }
    }
  });

  it('prevents unapproved posts from being inserted or published', async () => {
    const opp = await prisma.post_opportunities.create({
      data: {
        post_type_id: ID.postType,
        post_config_id: ID.config,
        dedupe_key: 'sec:unapproved:1',
        trigger_kind: 'manual',
        status: 'awaiting_review',
      },
    });
    const fakeAction = await prisma.review_actions.create({
      data: {
        opportunity_id: opp.id,
        action: 'comment',
        reviewer_id: 'rev-1',
        feedback: 'not an approval',
      },
    });
    await expect(
      prisma.publications.create({
        data: {
          approval_id: fakeAction.id,
          revision_id: ID.revision1,
          channel: 'x',
          mode: 'dry_run',
          status: 'pending',
          content_hash: 'a'.repeat(64),
          idempotency_key: `unapproved:${opp.id}`,
        },
      }),
    ).rejects.toThrow();

    const env = loadEnv({ NODE_ENV: 'test' });
    await publishDue({
      db: prisma,
      store: new InMemoryObjectStore(),
      channels: loadConfigSet().channels,
      env,
      modeOf: async () => 'dry_run',
      publishers: {},
      logger: pino({ level: 'silent' }),
    });
    const count = await prisma.publications.count({
      where: { review_actions: { opportunity_id: opp.id } },
    });
    expect(count).toBe(0);
  });

  it('never leaks secret markers in responses, headers, or pino logs across all GET routes', async () => {
    const adminToken = await mint('admin', 'sec-admin');
    const getRoutes = ROUTE_POLICY.filter((r) => r.method === 'GET' && r.access !== 'worker');
    const allMarkers = [...Object.values(MARKERS), deviceToken];

    for (const r of getRoutes) {
      const p = concretePath(r.path);
      const res = await request(app).get(p).set('Authorization', `Bearer ${adminToken}`);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['cross-origin-resource-policy']).toBe('same-site');
      if (r.path.startsWith('/v1')) {
        expect(res.headers['cache-control']).toBe('no-store');
      }

      const serialized = JSON.stringify({ headers: res.headers, body: res.body, text: res.text });
      for (const m of allMarkers) {
        expect(serialized, `marker leaked in ${r.path}`).not.toContain(m);
      }
      if (r.path === '/v1/admin/workers') {
        expect(serialized).not.toContain('token_hash');
      }
    }

    const logsText = logLines.join('\n');
    for (const m of allMarkers) {
      expect(logsText, 'marker leaked in logs').not.toContain(m);
    }
  });
});
