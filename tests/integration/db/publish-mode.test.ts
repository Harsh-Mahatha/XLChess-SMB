import { PrismaClient } from '@prisma/client';
import type { Express } from 'express';
import { SignJWT } from 'jose';
import pino from 'pino';
import sharp from 'sharp';
import request from 'supertest';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import type { ChannelsRegistry } from '@smb/shared';
import { createApp } from '../../../apps/api/src/app.js';
import { verifyOriginal } from '../../../apps/api/src/assets/index.js';
import { createTokenVerifier, type TokenVerifier } from '../../../apps/api/src/auth/index.js';
import { loadConfigSet } from '../../../apps/api/src/config/loader.js';
import { loadEnv, type Env } from '../../../apps/api/src/env.js';
import { revisionHash } from '../../../apps/api/src/generation/index.js';
import {
  SAMPLE_DATA,
  loadTemplates,
  renderGraphic,
  type RenderDeps,
} from '../../../apps/api/src/graphics/index.js';
import {
  XClient,
  XPublisher,
  effectivePublishMode,
  publishDue,
} from '../../../apps/api/src/publishing/index.js';
import { approveRevision, type ActionContext } from '../../../apps/api/src/review/index.js';
import {
  BUCKETS,
  InMemoryObjectStore,
  contentPath,
  sha256Hex,
} from '../../../apps/api/src/storage/index.js';
import { syntheticPhoto } from '../../unit/images/pictures.js';
import { FakeXServer } from './fake-x.js';
import { ID, freshDb } from './harness.js';

let pgc: pg.Client;
let prisma: PrismaClient;
let store: InMemoryObjectStore;
let renderDeps: RenderDeps;
let channels: ChannelsRegistry;
let verifier: TokenVerifier;
let counter = 0;

const fakeX = new FakeXServer();
let xPublisher: XPublisher;
const logger = pino({ level: 'silent' });
const secret = new TextEncoder().encode('test-secret-test-secret-test-secret');

async function adminJwt(): Promise<string> {
  return new SignJWT({ smb_role: 'admin' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('xlchess')
    .setAudience('smb')
    .setSubject('user-admin')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(secret);
}

function appForEnv(env: Env): Express {
  const set = loadConfigSet();
  return createApp({
    env,
    logger,
    admin: { verifier, db: prisma, configSet: set, env },
  });
}

async function photo(width: number, height: number): Promise<string> {
  const base = await syntheticPhoto(width, height, 'jpeg');
  const bytes = new Uint8Array(
    await sharp(base).linear(1, ++counter).jpeg({ quality: 95 }).toBuffer(),
  );
  const sha256 = sha256Hex(bytes);
  const path = contentPath(sha256, 'jpg');
  await store.put(BUCKETS.originals, path, bytes, 'image/jpeg');
  const row = await prisma.media_assets.create({
    data: {
      kind: 'original',
      bucket: BUCKETS.originals,
      path,
      sha256,
      mime: 'image/jpeg',
      size_bytes: bytes.byteLength,
      width,
      height,
      source_url: 'https://upload.wikimedia.org/x.jpg',
      image_source_id: 'I1',
      opportunity_id: ID.opportunity,
    },
  });
  await prisma.media_licenses.create({
    data: {
      asset_id: row.id,
      original_url: 'https://upload.wikimedia.org/x.jpg',
      source_page_url: 'https://commons.wikimedia.org/wiki/File:X.jpg',
      photographer: 'A. Photographer',
      licence_type: 'CC BY-SA',
      licence_version: '4.0',
      licence_url: 'https://creativecommons.org/licenses/by-sa/4.0/',
      commercial_use_allowed: true,
      modifications_allowed: true,
      attribution_required: true,
      attribution_text: 'Photo: A. Photographer / Wikimedia Commons, CC BY-SA 4.0',
      share_alike: true,
      decision: 'accepted',
      verified_at: new Date(),
      verified_by: 'system',
    },
  });
  await verifyOriginal(renderDeps, row.id);
  return row.id;
}

async function makeApprovableFixture() {
  const n = ++counter;
  const opp = await prisma.post_opportunities.create({
    data: {
      post_type_id: ID.postType,
      post_config_id: ID.config,
      dedupe_key: `pubmode:test:${n}`,
      trigger_kind: 'manual',
      status: 'awaiting_review',
    },
  });
  const pkg = await prisma.research_packages.create({
    data: { opportunity_id: opp.id, version: 1, status: 'complete' },
  });
  const claim = await prisma.research_claims.create({
    data: {
      package_id: pkg.id,
      claim_key: 'game.result',
      description: 'Result',
      value: { result: '1-0' },
      verification: 'verified',
    },
  });
  const record = await prisma.source_records.create({
    data: {
      source_id: 'D3',
      url: `https://example.org/${n}`,
      retrieved_at: new Date(),
      payload_hash: 'a'.repeat(64),
      normalised: {},
    },
  });
  await prisma.research_claim_sources.create({
    data: { claim_id: claim.id, source_record_id: record.id },
  });
  const photos: [string, string] = [await photo(1600, 1000), await photo(900, 1200)];
  const c = await prisma.post_candidates.create({
    data: {
      opportunity_id: opp.id,
      research_package_id: pkg.id,
      slot: 'A',
      provider: 'stub',
      prompt_version: 'v1',
      validation: { passed: true },
      visual_plan: { template: 'player-vs-player' },
    },
  });
  const caption = `Publish mode caption ${n}`;
  const hash = revisionHash({
    headline: `Headline ${n}`,
    caption,
    channelTexts: { x: caption },
    template: 'player-vs-player',
  });
  const rev = await prisma.post_revisions.create({
    data: {
      candidate_id: c.id,
      revision_no: 1,
      caption,
      channel_texts: { x: caption },
      headline: `Headline ${n}`,
      alt_text: 'Gukesh',
      author_kind: 'ai',
      content_hash: hash,
      revision_claims: { create: [{ claim_id: claim.id }] },
    },
  });
  await renderGraphic(renderDeps, {
    template: 'game-result',
    aspect: '16:9',
    candidateId: c.id,
    revisionId: rev.id,
    data: {
      ...SAMPLE_DATA['player-vs-player']!,
      photos: { photo_a: { assetId: photos[0] }, photo_b: { assetId: photos[1] } },
    },
  });
  return { opportunityId: opp.id, revisionId: rev.id, hash };
}

beforeAll(async () => {
  pgc = await freshDb();
  prisma = new PrismaClient({ datasourceUrl: `${inject('dbUrl')}?schema=smb` });
  store = new InMemoryObjectStore();
  renderDeps = { db: prisma, store, registry: loadTemplates() };
  channels = loadConfigSet().channels;
  verifier = createTokenVerifier({
    alg: 'HS256',
    key: secret,
    issuer: 'xlchess',
    audience: 'smb',
    userIdClaim: 'sub',
  });
  await fakeX.start();
  xPublisher = new XPublisher({
    client: new XClient({
      baseUrl: fakeX.baseUrl,
      creds: {
        apiKey: 'k',
        apiSecret: 's',
        accessToken: 'at',
        accessTokenSecret: 'ats',
      },
      timeoutMs: 1000,
    }),
    userId: '12345678',
    username: 'smb_bot',
  });
});

afterAll(async () => {
  await fakeX.stop();
  await prisma.$disconnect();
  await pgc.end();
});

describe('publish mode control', () => {
  it('defaults to dry_run, supports audited PUT sandbox, and blocks unconfirmed or above-ceiling live', async () => {
    const token = await adminJwt();
    const sandboxEnv = loadEnv({
      NODE_ENV: 'test',
      SMB_PUBLISH_MODE: 'sandbox',
      X_API_KEY: 'k',
      X_API_SECRET: 's',
      X_ACCESS_TOKEN: 'at',
      X_ACCESS_TOKEN_SECRET: 'ats',
      X_USER_ID: '12345678',
    });
    const app = appForEnv(sandboxEnv);

    const initial = await request(app)
      .get('/v1/admin/publish-mode')
      .set('Authorization', `Bearer ${token}`);
    expect(initial.status).toBe(200);
    expect(initial.body).toMatchObject({
      setting: 'dry_run',
      ceiling: 'sandbox',
      effective: 'dry_run',
    });

    const toSandbox = await request(app)
      .put('/v1/admin/publish-mode')
      .set('Authorization', `Bearer ${token}`)
      .send({ mode: 'sandbox', reason: 'Enabling sandbox testing for verification' });
    expect(toSandbox.status).toBe(200);
    expect(toSandbox.body).toMatchObject({
      setting: 'sandbox',
      ceiling: 'sandbox',
      effective: 'sandbox',
    });

    const audit = await prisma.audit_log.findFirst({
      where: { action: 'publish_mode.change' },
      orderBy: { id: 'desc' },
    });
    expect(audit).not.toBeNull();

    const noConfirm = await request(app)
      .put('/v1/admin/publish-mode')
      .set('Authorization', `Bearer ${token}`)
      .send({ mode: 'live', reason: 'Trying live without confirm phrase' });
    expect(noConfirm.status).toBe(400);
    expect(noConfirm.body.error.code).toBe('confirmation_required');

    const aboveCeiling = await request(app)
      .put('/v1/admin/publish-mode')
      .set('Authorization', `Bearer ${token}`)
      .send({
        mode: 'live',
        reason: 'Trying live above sandbox ceiling',
        confirm: 'PUBLISH LIVE',
      });
    expect(aboveCeiling.status).toBe(409);
    expect(aboveCeiling.body.error.code).toBe('mode_above_ceiling');
  });

  it('allows live only when all production gates pass', async () => {
    const token = await adminJwt();
    const prodEnv = loadEnv({
      SMB_DEPLOYMENT: 'production',
      X_CREDENTIALS_DEPLOYMENT: 'production',
      NODE_ENV: 'production',
      SMB_AI_PROVIDER: 'worker',
      DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:5432/postgres?schema=smb',
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
      XLCHESS_JWT_ALG: 'HS256',
      XLCHESS_JWT_SECRET: 's'.repeat(32),
      XLCHESS_JWT_ISSUER: 'xlchess',
      XLCHESS_JWT_AUDIENCE: 'smb',
      SMB_PUBLISH_MODE: 'live',
      SMB_ALLOW_LIVE_PUBLISH: 'true',
      X_API_KEY: 'k',
      X_API_SECRET: 's',
      X_ACCESS_TOKEN: 'at',
      X_ACCESS_TOKEN_SECRET: 'ats',
      X_USER_ID: '12345678',
    });
    const app = appForEnv(prodEnv);

    const res = await request(app)
      .put('/v1/admin/publish-mode')
      .set('Authorization', `Bearer ${token}`)
      .send({
        mode: 'live',
        reason: 'Going live in production after verification',
        confirm: 'PUBLISH LIVE',
      });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      setting: 'live',
      ceiling: 'live',
      effective: 'live',
      liveGates: { ceilingLive: true, allowLive: true, production: true },
    });
  });

  it('stamps effective mode at approval, holds sandbox rows when lowered to dry_run, and publishes when raised back', async () => {
    fakeX.reset();
    const token = await adminJwt();
    const sandboxEnv = loadEnv({
      NODE_ENV: 'test',
      SMB_PUBLISH_MODE: 'sandbox',
      X_API_KEY: 'k',
      X_API_SECRET: 's',
      X_ACCESS_TOKEN: 'at',
      X_ACCESS_TOKEN_SECRET: 'ats',
      X_USER_ID: '12345678',
    });
    const app = appForEnv(sandboxEnv);

    await request(app)
      .put('/v1/admin/publish-mode')
      .set('Authorization', `Bearer ${token}`)
      .send({ mode: 'sandbox', reason: 'Approve in sandbox mode first' });

    const f = await makeApprovableFixture();
    const ctx: ActionContext = {
      db: prisma,
      store,
      channels,
      publishModeOf: () => effectivePublishMode(prisma, sandboxEnv),
    };
    const approved = await approveRevision(
      ctx,
      { userId: 'rev-1', role: 'reviewer' },
      { revisionId: f.revisionId, contentHash: f.hash, channels: ['x'] },
    );
    const pubId = approved.publications![0]!.id;
    expect(approved.publications![0]!.mode).toBe('sandbox');

    // Lower mode to dry_run -> publication stays pending with mode_not_allowed
    await request(app)
      .put('/v1/admin/publish-mode')
      .set('Authorization', `Bearer ${token}`)
      .send({ mode: 'dry_run', reason: 'Temporarily lower mode to dry_run' });

    const pubDeps = {
      db: prisma,
      store,
      channels,
      env: sandboxEnv,
      modeOf: () => effectivePublishMode(prisma, sandboxEnv),
      publishers: { x: xPublisher },
      logger,
    };
    const holdOutcomes = await publishDue(pubDeps);
    expect(holdOutcomes.find((o) => o.publicationId === pubId)?.skipped).toBe('mode_not_allowed');
    expect((await prisma.publications.findUniqueOrThrow({ where: { id: pubId } })).status).toBe(
      'pending',
    );
    expect(fakeX.recorded).toHaveLength(0);

    // Raise back to sandbox -> publishes through FakeX
    await request(app)
      .put('/v1/admin/publish-mode')
      .set('Authorization', `Bearer ${token}`)
      .send({ mode: 'sandbox', reason: 'Restore sandbox mode to publish' });

    const sentOutcomes = await publishDue(pubDeps);
    expect(sentOutcomes.find((o) => o.publicationId === pubId)?.status).toBe('published');
    expect(fakeX.recorded.some((r) => r.path === '/2/tweets')).toBe(true);
  });
});
