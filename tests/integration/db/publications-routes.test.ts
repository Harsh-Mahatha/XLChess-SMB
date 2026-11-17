/* eslint-disable @typescript-eslint/no-explicit-any -- JSON column contents and DB stubs */
import { PrismaClient } from '@prisma/client';
import type { Express } from 'express';
import { SignJWT } from 'jose';
import request from 'supertest';
import type pg from 'pg';
import pino from 'pino';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import type { ChannelsRegistry } from '@smb/shared';
import { createApp } from '../../../apps/api/src/app.js';
import { createTokenVerifier, type TokenVerifier } from '../../../apps/api/src/auth/index.js';
import { verifyOriginal } from '../../../apps/api/src/assets/index.js';
import { loadConfigSet } from '../../../apps/api/src/config/loader.js';
import { loadEnv } from '../../../apps/api/src/env.js';
import { revisionHash } from '../../../apps/api/src/generation/index.js';
import {
  SAMPLE_DATA,
  loadTemplates,
  renderGraphic,
  type RenderDeps,
} from '../../../apps/api/src/graphics/index.js';
import {
  approveRevision,
  type ActionContext,
  type ReviewContext,
} from '../../../apps/api/src/review/index.js';
import {
  BUCKETS,
  InMemoryObjectStore,
  contentPath,
  sha256Hex,
} from '../../../apps/api/src/storage/index.js';
import {
  XClient,
  XPublisher,
  publishDue,
  type PublishDeps,
} from '../../../apps/api/src/publishing/index.js';
import { syntheticPhoto } from '../../unit/images/pictures.js';
import { FakeXServer } from './fake-x.js';
import { ID, freshDb } from './harness.js';

let pgc: pg.Client;
let prisma: PrismaClient;
let store: InMemoryObjectStore;
let renderDeps: RenderDeps;
let channels: ChannelsRegistry;
let ctx: ActionContext;
let counter = 0;
let app: Express;
let verifier: TokenVerifier;

const secret = new TextEncoder().encode('test-secret-test-secret-test-secret');
const adminUser = { userId: 'user-admin' };

const FAKE_CREDS = {
  apiKey: 'test-api-key-xyz123',
  apiSecret: 'test-api-secret-abc456',
  accessToken: 'test-access-token-789def',
  accessTokenSecret: 'test-access-secret-ghi789',
};
const FAKE_USER_ID = '12345678';
const FAKE_USERNAME = 'smb_bot';

const fakeX = new FakeXServer();
let xClient: XClient;
let xPublisher: XPublisher;
let publishDeps: PublishDeps;

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

interface Fixture {
  opportunityId: string;
  candidates: { id: string; revisionId: string; hash: string; slot: string }[];
  photoIds: [string, string];
  renderAssetId: string;
}

async function fixture(): Promise<Fixture> {
  const n = ++counter;
  const opp = await prisma.post_opportunities.create({
    data: {
      post_type_id: '1.1',
      post_config_id: ID.config,
      dedupe_key: `test:routes:${n}`,
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
      description: 'Round 3 result',
      value: { result: '1-0' },
      verification: 'verified',
    },
  });
  const record = await prisma.source_records.create({
    data: {
      source_id: 'D1',
      url: `https://example.org/round-3/${n}`,
      retrieved_at: new Date(),
      payload_hash: sha256Hex(new TextEncoder().encode(`r${n}`)),
      normalised: {},
    },
  });
  await prisma.research_claim_sources.create({
    data: { claim_id: claim.id, source_record_id: record.id },
  });

  const photoIds: [string, string] = [await photo(1600, 1000), await photo(900, 1200)];
  const candidates: Fixture['candidates'] = [];
  const caption = `Caption for test ${n}`;

  for (const slot of ['A']) {
    const c = await prisma.post_candidates.create({
      data: {
        opportunity_id: opp.id,
        research_package_id: pkg.id,
        slot,
        provider: 'stub',
        prompt_version: 'v1',
        validation: { passed: true },
        visual_plan: { template: 'player-vs-player' },
      },
    });
    const hash = revisionHash({
      headline: `Headline ${n} ${slot}`,
      caption,
      channelTexts: { x: caption },
      template: 'player-vs-player',
    });
    const r = await prisma.post_revisions.create({
      data: {
        candidate_id: c.id,
        revision_no: 1,
        caption,
        channel_texts: { x: caption },
        headline: `Headline ${n} ${slot}`,
        alt_text: 'Gukesh',
        author_kind: 'ai',
        content_hash: hash,
        revision_claims: { create: [{ claim_id: claim.id }] },
      },
    });
    candidates.push({ id: c.id, revisionId: r.id, hash, slot });
  }

  const r = await renderGraphic(renderDeps, {
    template: 'game-result',
    aspect: '16:9',
    candidateId: candidates[0]!.id,
    revisionId: candidates[0]!.revisionId,
    data: {
      ...SAMPLE_DATA['player-vs-player']!,
      photos: { photo_a: { assetId: photoIds[0] }, photo_b: { assetId: photoIds[1] } },
    },
  });

  return { opportunityId: opp.id, candidates, photoIds, renderAssetId: r.assetId };
}

const approveInput = (f: Fixture) => ({
  revisionId: f.candidates[0]!.revisionId,
  contentHash: f.candidates[0]!.hash,
  channels: ['x'],
});

beforeAll(async () => {
  pgc = await freshDb();
  prisma = new PrismaClient({ datasourceUrl: `${inject('dbUrl')}?schema=smb` });
  store = new InMemoryObjectStore();
  renderDeps = { db: prisma, store, registry: loadTemplates() };
  channels = loadConfigSet().channels;
  ctx = { db: prisma, store, channels, publishMode: 'sandbox' };

  await fakeX.start();

  xClient = new XClient({
    baseUrl: fakeX.baseUrl,
    creds: FAKE_CREDS,
    timeoutMs: 300,
  });
  xPublisher = new XPublisher({
    client: xClient,
    userId: FAKE_USER_ID,
    username: FAKE_USERNAME,
  });

  publishDeps = {
    db: prisma,
    store,
    channels,
    env: {
      SMB_PUBLISH_MODE: 'sandbox',
      SMB_ALLOW_LIVE_PUBLISH: true,
      X_RECONCILE_DELAY_SECONDS: 60,
      X_RECONCILE_MAX_LOOKUPS: 5,
    },
    publishers: { x: xPublisher },
    logger: pino({ level: 'silent' }),
  };

  verifier = createTokenVerifier({
    alg: 'HS256',
    key: secret,
    issuer: 'xlchess',
    audience: 'smb',
    userIdClaim: 'sub',
  });

  const env = loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    SMB_PUBLISH_MODE: 'sandbox',
    SMB_ALLOW_LIVE_PUBLISH: 'true',
    X_API_KEY: 'k',
    X_API_SECRET: 's',
    X_ACCESS_TOKEN: 't',
    X_ACCESS_TOKEN_SECRET: 'ts',
    X_USER_ID: '123',
  });

  const reviewRead: ReviewContext = {
    db: prisma,
    store,
    channels,
    signedUrlSeconds: 120,
  };

  app = createApp({
    env,
    logger: pino({ level: 'silent' }),
    review: {
      verifier,
      read: reviewRead,
      act: ctx,
    },
    publishing: publishDeps,
  });
}, 180_000);

afterAll(async () => {
  await fakeX.stop();
  await prisma.$disconnect();
  await pgc.end();
});

describe('Publications admin routes', () => {
  describe('Authorization and guards', () => {
    it('refuses unauthenticated requests with 401', async () => {
      await request(app).get('/v1/publications').expect(401);
    });

    it('refuses non-admin roles (reviewer) with 403', async () => {
      const reviewerToken = await token({ smb_role: 'reviewer' }, 'user-reviewer');
      await request(app)
        .get('/v1/publications')
        .set('Authorization', `Bearer ${reviewerToken}`)
        .expect(403);
    });
  });

  describe('GET /v1/publications', () => {
    it('lists publications newest first with needsAttention flag', async () => {
      const adminToken = await token({ smb_role: 'admin' });
      const f = await fixture();
      const approveRes = await approveRevision(ctx, adminUser, approveInput(f));
      const pubId = approveRes.publications![0]!.id;

      const res = await request(app)
        .get('/v1/publications')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(res.body.publications).toBeInstanceOf(Array);
      const item = res.body.publications.find((p: any) => p.id === pubId);
      expect(item).toBeDefined();
      expect(item.channel).toBe('x');
      expect(item.mode).toBe('sandbox');
      expect(item.status).toBe('pending');
      expect(item.needsAttention).toBe(false);
      expect(item.opportunityId).toBe(f.opportunityId);
    });

    it('filters by status and channel', async () => {
      const adminToken = await token({ smb_role: 'admin' });
      const res = await request(app)
        .get('/v1/publications?status=failed&channel=x')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(res.body.publications).toBeInstanceOf(Array);
      for (const p of res.body.publications) {
        expect(p.status).toBe('failed');
        expect(p.channel).toBe('x');
      }
    });
  });

  describe('GET /v1/publications/:id', () => {
    it('returns publication detail and attempt history', async () => {
      const adminToken = await token({ smb_role: 'admin' });
      const f = await fixture();
      const approveRes = await approveRevision(ctx, adminUser, approveInput(f));
      const pubId = approveRes.publications![0]!.id;

      const res = await request(app)
        .get(`/v1/publications/${pubId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(res.body.publication).toBeDefined();
      expect(res.body.publication.id).toBe(pubId);
      expect(res.body.publication.attempts).toBeInstanceOf(Array);
    });

    it('returns 404 for unknown publication id', async () => {
      const adminToken = await token({ smb_role: 'admin' });
      await request(app)
        .get('/v1/publications/00000000-0000-0000-0000-000000000000')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(404);
    });
  });

  describe('POST /v1/publications/:id/retry', () => {
    it('refuses to retry a publication that is not failed with 409', async () => {
      const adminToken = await token({ smb_role: 'admin' });
      const f = await fixture();
      const approveRes = await approveRevision(ctx, adminUser, approveInput(f));
      const pubId = approveRes.publications![0]!.id;

      // Status is pending
      const res = await request(app)
        .post(`/v1/publications/${pubId}/retry`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason: 'Try again' })
        .expect(409);

      expect(res.body.error.code).toBe('wrong_status');
    });

    it('resets failed publication to pending and resets attempt count to 0', async () => {
      const adminToken = await token({ smb_role: 'admin' });
      const f = await fixture();
      const approveRes = await approveRevision(ctx, adminUser, approveInput(f));
      const pubId = approveRes.publications![0]!.id;

      // Transition to failed
      await prisma.publications.update({
        where: { id: pubId },
        data: {
          status: 'failed',
          attempt_count: 3,
          last_error: 'Connection error',
        },
      });

      const res = await request(app)
        .post(`/v1/publications/${pubId}/retry`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('Idempotency-Key', `retry-test-${Date.now()}`)
        .send({ reason: 'Admin reset' })
        .expect(200);

      expect(res.body.publication.status).toBe('pending');
      expect(res.body.publication.attemptCount).toBe(0);

      const pubRow = await prisma.publications.findUniqueOrThrow({ where: { id: pubId } });
      expect(pubRow.status).toBe('pending');
      expect(pubRow.attempt_count).toBe(0);
      expect(pubRow.last_error).toBeNull();

      // Check audit log
      const audit = await prisma.audit_log.findFirst({
        where: { action: 'publication.retry', target_id: pubId },
      });
      expect(audit).toBeDefined();
      expect((audit!.details as any).reason).toBe('Admin reset');
    });
  });

  describe('POST /v1/publications/:id/reconcile', () => {
    it('refuses reconcile on non-uncertain publication with 409', async () => {
      const adminToken = await token({ smb_role: 'admin' });
      const f = await fixture();
      const approveRes = await approveRevision(ctx, adminUser, approveInput(f));
      const pubId = approveRes.publications![0]!.id;

      await request(app)
        .post(`/v1/publications/${pubId}/reconcile`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(409);
    });

    it('triggers immediate reconciliation for an uncertain publication', async () => {
      fakeX.reset();
      const adminToken = await token({ smb_role: 'admin' });
      const f = await fixture();
      const approveRes = await approveRevision(ctx, adminUser, approveInput(f));
      const pubId = approveRes.publications![0]!.id;

      // Transition pending -> publishing -> uncertain
      await prisma.publications.update({
        where: { id: pubId },
        data: { status: 'publishing' },
      });
      await prisma.publications.update({
        where: { id: pubId },
        data: {
          status: 'uncertain',
          retry_after: new Date(Date.now() + 3600_000), // in future
        },
      });

      const res = await request(app)
        .post(`/v1/publications/${pubId}/reconcile`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(res.body.outcome).toBeDefined();
      // Since fakeX has no tweets, outcome was lookup_absent and moved to pending
      expect(res.body.outcome.outcome).toBe('lookup_absent');

      const pubRow = await prisma.publications.findUniqueOrThrow({ where: { id: pubId } });
      expect(pubRow.status).toBe('pending');
    });
  });

  describe('POST /v1/publications/:id/resolve', () => {
    it('refuses resolve on non-uncertain publication with 409', async () => {
      const adminToken = await token({ smb_role: 'admin' });
      const f = await fixture();
      const approveRes = await approveRevision(ctx, adminUser, approveInput(f));
      const pubId = approveRes.publications![0]!.id;

      await request(app)
        .post(`/v1/publications/${pubId}/resolve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ outcome: 'abandon', reason: 'Cancel' })
        .expect(409);
    });

    it('resolves as published: verifies post, sets published status, externalId, url, and settles opportunity', async () => {
      fakeX.reset();
      const adminToken = await token({ smb_role: 'admin' });
      const f = await fixture();
      const approveRes = await approveRevision(ctx, adminUser, approveInput(f));
      const pubId = approveRes.publications![0]!.id;

      // Add a tweet to fakeX so getStatus succeeds
      fakeX.tweets.push({
        id: 'tweet-manual-999',
        text: 'Some tweet',
        created_at: new Date().toISOString(),
      });

      // Transition pending -> publishing -> uncertain
      await prisma.publications.update({
        where: { id: pubId },
        data: { status: 'publishing' },
      });
      await prisma.publications.update({
        where: { id: pubId },
        data: { status: 'uncertain' },
      });

      const res = await request(app)
        .post(`/v1/publications/${pubId}/resolve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ outcome: 'published', externalId: 'tweet-manual-999' })
        .expect(200);

      expect(res.body.publication.status).toBe('published');
      expect(res.body.publication.externalId).toBe('tweet-manual-999');
      expect(res.body.publication.url).toContain('tweet-manual-999');

      const pubRow = await prisma.publications.findUniqueOrThrow({
        where: { id: pubId },
        include: { publication_attempts: true },
      });
      expect(pubRow.status).toBe('published');
      expect(pubRow.external_id).toBe('tweet-manual-999');
      expect(pubRow.publication_attempts.some((a) => a.kind === 'manual')).toBe(true);

      const opp = await prisma.post_opportunities.findUniqueOrThrow({
        where: { id: f.opportunityId },
      });
      expect(opp.status).toBe('published');
    });

    it('refuses resolve as published if getStatus confirms post was deleted (422)', async () => {
      fakeX.reset(); // fakeX has no tweets, so GET /2/tweets/:id returns 404
      const adminToken = await token({ smb_role: 'admin' });
      const f = await fixture();
      const approveRes = await approveRevision(ctx, adminUser, approveInput(f));
      const pubId = approveRes.publications![0]!.id;

      // Transition pending -> publishing -> uncertain
      await prisma.publications.update({
        where: { id: pubId },
        data: { status: 'publishing' },
      });
      await prisma.publications.update({
        where: { id: pubId },
        data: { status: 'uncertain' },
      });

      const res = await request(app)
        .post(`/v1/publications/${pubId}/resolve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ outcome: 'published', externalId: 'deleted-tweet-123' })
        .expect(422);

      expect(res.body.error.code).toBe('post_deleted');
    });

    it('resolves as not_published: sets status to pending, leading to exactly one more create on next sweep', async () => {
      fakeX.reset();
      const adminToken = await token({ smb_role: 'admin' });
      const f = await fixture();
      const approveRes = await approveRevision(ctx, adminUser, approveInput(f));
      const pubId = approveRes.publications![0]!.id;

      // Transition pending -> publishing -> uncertain
      await prisma.publications.update({
        where: { id: pubId },
        data: { status: 'publishing' },
      });
      await prisma.publications.update({
        where: { id: pubId },
        data: { status: 'uncertain' },
      });

      const res = await request(app)
        .post(`/v1/publications/${pubId}/resolve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ outcome: 'not_published', reason: 'Checked timeline, not posted' })
        .expect(200);

      expect(res.body.publication.status).toBe('pending');

      // Next publishDue sweep picks it up and publishes
      await publishDue(publishDeps);

      const pubRow = await prisma.publications.findUniqueOrThrow({ where: { id: pubId } });
      expect(pubRow.status).toBe('published');
      expect(fakeX.recorded.filter((r) => r.path === '/2/tweets')).toHaveLength(1);
    });

    it('resolves as abandon: marks status failed and settles opportunity to failed', async () => {
      const adminToken = await token({ smb_role: 'admin' });
      const f = await fixture();
      const approveRes = await approveRevision(ctx, adminUser, approveInput(f));
      const pubId = approveRes.publications![0]!.id;

      // Transition pending -> publishing -> uncertain
      await prisma.publications.update({
        where: { id: pubId },
        data: { status: 'publishing' },
      });
      await prisma.publications.update({
        where: { id: pubId },
        data: { status: 'uncertain' },
      });

      const res = await request(app)
        .post(`/v1/publications/${pubId}/resolve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ outcome: 'abandon', reason: 'Do not publish this story' })
        .expect(200);

      expect(res.body.publication.status).toBe('failed');

      const pubRow = await prisma.publications.findUniqueOrThrow({ where: { id: pubId } });
      expect(pubRow.status).toBe('failed');
      expect(pubRow.last_error).toBe('Do not publish this story');

      const opp = await prisma.post_opportunities.findUniqueOrThrow({
        where: { id: f.opportunityId },
      });
      expect(opp.status).toBe('failed');
    });
  });

  describe('Security: response redaction', () => {
    it('never leaks credentials in publications route responses', async () => {
      const adminToken = await token({ smb_role: 'admin' });
      const forbidden = [
        FAKE_CREDS.apiKey,
        FAKE_CREDS.apiSecret,
        FAKE_CREDS.accessToken,
        FAKE_CREDS.accessTokenSecret,
      ];

      const resList = await request(app)
        .get('/v1/publications')
        .set('Authorization', `Bearer ${adminToken}`);

      const dump = JSON.stringify(resList.body);
      for (const secretToken of forbidden) {
        expect(dump).not.toContain(secretToken);
      }
    });
  });
});
