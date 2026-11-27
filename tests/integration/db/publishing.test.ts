/* eslint-disable @typescript-eslint/no-explicit-any -- JSON column contents and DB stubs */
import { PrismaClient } from '@prisma/client';
import sharp from 'sharp';
import type pg from 'pg';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import type { ChannelsRegistry } from '@smb/shared';
import { verifyOriginal } from '../../../apps/api/src/assets/index.js';
import { loadConfigSet } from '../../../apps/api/src/config/loader.js';
import { revisionHash } from '../../../apps/api/src/generation/index.js';
import {
  SAMPLE_DATA,
  loadTemplates,
  renderGraphic,
  type RenderDeps,
} from '../../../apps/api/src/graphics/index.js';
import {
  approveRevision,
  editCandidate,
  type ActionContext,
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
  reconcilePublication,
  settleOpportunity,
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

const alice = { userId: 'user-alice' };

const FAKE_CREDS = {
  apiKey: 'test-api-key-xyz123',
  apiSecret: 'test-api-secret-abc456',
  accessToken: 'test-access-token-789def',
  accessTokenSecret: 'test-access-secret-ghi789',
};
const FAKE_USER_ID = '12345678';
const FAKE_USERNAME = 'smb_bot';

const logLines: string[] = [];
const logStream = {
  write(msg: string) {
    logLines.push(msg);
  },
};
const testLogger = pino({ level: 'debug' }, logStream as any);

const fakeX = new FakeXServer();
let xClient: XClient;
let xPublisher: XPublisher;
let deps: PublishDeps;

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
  renderSha: string;
}

const HEADLINE = 'Gukesh takes the lead';
const CAPTION = 'Gukesh beat Sindarov in round 3 and leads the match 2-1.';

async function fixture(
  options: { status?: string; withRender?: boolean; customCaption?: string } = {},
): Promise<Fixture> {
  const n = ++counter;
  const opp = await prisma.post_opportunities.create({
    data: {
      post_type_id: '1.1',
      post_config_id: ID.config,
      dedupe_key: `test:1.13:${n}`,
      trigger_kind: 'manual',
      status: (options.status ?? 'awaiting_review') as never,
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
  const captionText = options.customCaption ?? `${CAPTION} #${n}`;

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
      headline: `${HEADLINE} ${slot}`,
      caption: captionText,
      channelTexts: { x: `${captionText}` },
      template: 'player-vs-player',
    });
    const r = await prisma.post_revisions.create({
      data: {
        candidate_id: c.id,
        revision_no: 1,
        caption: captionText,
        channel_texts: { x: captionText },
        headline: `${HEADLINE} ${slot}`,
        alt_text: 'Gukesh and Sindarov',
        author_kind: 'ai',
        content_hash: hash,
        revision_claims: { create: [{ claim_id: claim.id }] },
      },
    });
    candidates.push({ id: c.id, revisionId: r.id, hash, slot });
  }

  let renderAssetId = '';
  let renderSha = '';
  if (options.withRender !== false) {
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
    renderAssetId = r.assetId;
    renderSha = r.sha256;
  }
  return { opportunityId: opp.id, candidates, photoIds, renderAssetId, renderSha };
}

const approveInput = (f: Fixture, i = 0, extra: Record<string, unknown> = {}) => ({
  revisionId: f.candidates[i]!.revisionId,
  contentHash: f.candidates[i]!.hash,
  channels: ['x'],
  ...extra,
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
    timeoutMs: 300, // fast timeout for timeout testing
  });
  xPublisher = new XPublisher({
    client: xClient,
    userId: FAKE_USER_ID,
    username: FAKE_USERNAME,
  });

  deps = {
    db: prisma,
    store,
    channels,
    env: {
      SMB_PUBLISH_MODE: 'sandbox',
      SMB_ALLOW_LIVE_PUBLISH: true,
      X_RECONCILE_DELAY_SECONDS: 60,
      X_RECONCILE_MAX_LOOKUPS: 5,
    },
    modeOf: async () => 'sandbox',
    publishers: { x: xPublisher },
    logger: testLogger,
  };
}, 180_000);

afterAll(async () => {
  await fakeX.stop();
  await prisma.$disconnect();
  await pgc.end();
});

describe('Publishing integration tests with FakeX', () => {
  // Scenario 1: Dry run end to end
  it('1. Dry run end-to-end: approves in dry_run, publishDue writes dry_run_recorded without contacting fake X', async () => {
    fakeX.reset();
    const f = await fixture();
    const approveRes = await approveRevision(
      { ...ctx, publishMode: 'dry_run' },
      alice,
      approveInput(f),
    );
    const pubId = approveRes.publications![0]!.id;

    const outcomes = await publishDue(deps);
    expect(outcomes.some((o) => o.publicationId === pubId)).toBe(true);

    const pubRow = await prisma.publications.findUniqueOrThrow({
      where: { id: pubId },
      include: { publication_attempts: true },
    });
    expect(pubRow.status).toBe('dry_run_recorded');
    expect(pubRow.attempt_count).toBe(1);
    expect(pubRow.publication_attempts).toHaveLength(1);
    expect(pubRow.publication_attempts[0]!.outcome).toBe('dry_run');
    expect(pubRow.publication_attempts[0]!.kind).toBe('send');

    const oppRow = await prisma.post_opportunities.findUniqueOrThrow({
      where: { id: f.opportunityId },
    });
    expect(oppRow.status).toBe('published');

    // Fake X received 0 requests
    expect(fakeX.recorded).toHaveLength(0);

    // A second sweep does nothing
    const sweep2 = await publishDue(deps);
    expect(sweep2.some((o) => o.publicationId === pubId)).toBe(false);
    expect(fakeX.recorded).toHaveLength(0);
  });

  // Scenario 2: Sandbox happy path
  it('2. Sandbox happy path: posts graphic + text to fake X, stores externalId and url, writes audit log', async () => {
    fakeX.reset();
    const f = await fixture();
    const approveRes = await approveRevision(ctx, alice, approveInput(f));
    const pubId = approveRes.publications![0]!.id;

    const outcomes = await publishDue(deps);
    const outcome = outcomes.find((o) => o.publicationId === pubId);
    expect(outcome?.status).toBe('published');
    expect(outcome?.externalId).toBeDefined();
    expect(outcome?.url).toContain('https://x.com/smb_bot/status/');

    const pubRow = await prisma.publications.findUniqueOrThrow({
      where: { id: pubId },
      include: { publication_attempts: true },
    });
    expect(pubRow.status).toBe('published');
    expect(pubRow.external_id).toBe(outcome!.externalId);
    expect(pubRow.url).toBe(outcome!.url);
    expect(pubRow.published_at).not.toBeNull();
    expect(pubRow.publication_attempts).toHaveLength(1);
    expect(pubRow.publication_attempts[0]!.outcome).toBe('success');

    // Check fake X received upload, metadata, and create
    expect(fakeX.recorded.some((r) => r.path === '/2/media/upload')).toBe(true);
    expect(fakeX.recorded.some((r) => r.path === '/2/media/metadata')).toBe(true);
    const createReq = fakeX.recorded.find((r) => r.path === '/2/tweets');
    expect(createReq).toBeDefined();
    expect((createReq!.body as any)?.media?.media_ids).toHaveLength(1);

    // Audit log written
    const audit = await prisma.audit_log.findFirst({
      where: { action: 'publication.published', target_id: pubId },
    });
    expect(audit).toBeDefined();
    expect((audit!.details as any).url).toBe(pubRow.url);
  });

  // Scenario 3: Accepted then timeout
  it('3. Accepted then timeout: X stores post then hangs -> uncertain -> reconcile finds post -> published with 1 create', async () => {
    fakeX.reset();
    fakeX.acceptThenHangNextCreate = true;
    const f = await fixture();
    const approveRes = await approveRevision(ctx, alice, approveInput(f));
    const pubId = approveRes.publications![0]!.id;

    // publishDue runs, create times out
    await publishDue(deps);

    let pubRow = await prisma.publications.findUniqueOrThrow({ where: { id: pubId } });
    expect(pubRow.status).toBe('uncertain');
    expect(pubRow.retry_after).not.toBeNull();

    // Before retry_after: sweep skips it
    const preCount = fakeX.recorded.filter((r) => r.path === '/2/tweets').length;
    await publishDue(deps);
    expect(fakeX.recorded.filter((r) => r.path === '/2/tweets').length).toBe(preCount);

    // Advance retry_after to now
    await prisma.publications.update({
      where: { id: pubId },
      data: { retry_after: new Date() },
    });

    // publishDue reconciles via timeline lookup
    await publishDue(deps);

    pubRow = await prisma.publications.findUniqueOrThrow({ where: { id: pubId } });
    expect(pubRow.status).toBe('published');
    expect(pubRow.external_id).toBeDefined();
    // Exactly one create request sent to Fake X in total!
    expect(fakeX.recorded.filter((r) => r.path === '/2/tweets')).toHaveLength(1);
  });

  // Scenario 4: Timeout and really absent
  it('4. Timeout and absent: X drops create without storing -> reconcile finds absent -> pending -> second sweep publishes', async () => {
    fakeX.reset();
    fakeX.hangNextCreate = true;
    const f = await fixture();
    const approveRes = await approveRevision(ctx, alice, approveInput(f));
    const pubId = approveRes.publications![0]!.id;

    // Sweep 1: create hangs, times out -> uncertain
    await publishDue(deps);
    let pubRow = await prisma.publications.findUniqueOrThrow({ where: { id: pubId } });
    expect(pubRow.status).toBe('uncertain');

    // Reconcile: lookup returns absent -> back to pending
    await prisma.publications.update({
      where: { id: pubId },
      data: { retry_after: new Date() },
    });
    await reconcilePublication(deps, pubId);

    pubRow = await prisma.publications.findUniqueOrThrow({ where: { id: pubId } });
    expect(pubRow.status).toBe('pending');

    // Sweep 2: sends again and publishes
    await publishDue(deps);

    pubRow = await prisma.publications.findUniqueOrThrow({ where: { id: pubId } });
    expect(pubRow.status).toBe('published');
    expect(fakeX.recorded.filter((r) => r.path === '/2/tweets')).toHaveLength(2);
    expect(fakeX.tweets).toHaveLength(1);
  });

  // Scenario 5: Lookup failing
  it('5. Lookup failing: timeline 500 keeps status uncertain; after max lookups requires manual resolution', async () => {
    fakeX.reset();
    const f = await fixture();
    const approveRes = await approveRevision(ctx, alice, approveInput(f));
    const pubId = approveRes.publications![0]!.id;

    // Transition pending -> publishing -> uncertain with 4 lookups already done
    await prisma.publications.update({
      where: { id: pubId },
      data: { status: 'publishing' },
    });
    await prisma.publications.update({
      where: { id: pubId },
      data: {
        status: 'uncertain',
        lookup_count: 4,
        retry_after: new Date(),
      },
    });

    fakeX.failNextLookup = { status: 500, body: { error: 'Internal Server Error' } };

    const outcome = await reconcilePublication(deps, pubId);
    expect(outcome.status).toBe('uncertain');

    const pubRow = await prisma.publications.findUniqueOrThrow({ where: { id: pubId } });
    expect(pubRow.lookup_count).toBe(5);
    expect(pubRow.retry_after).toBeNull();
    expect(pubRow.last_error).toBe('needs_manual_resolution');
    // No create request was ever sent
    expect(fakeX.recorded.filter((r) => r.path === '/2/tweets')).toHaveLength(0);
  });

  // Scenario 6: Crash mid-flight
  it('6. Crash mid-flight: stale publishing row recovered to uncertain and reconciled before sending blindly', async () => {
    fakeX.reset();
    const f = await fixture();
    const approveRes = await approveRevision(ctx, alice, approveInput(f));
    const pubId = approveRes.publications![0]!.id;

    // Simulate crash: row left in publishing with old claimed_at
    const staleTime = new Date(Date.now() - 150_000);
    await prisma.publications.update({
      where: { id: pubId },
      data: {
        status: 'publishing',
        claimed_at: staleTime,
      },
    });
    await prisma.post_opportunities.update({
      where: { id: f.opportunityId },
      data: { status: 'publishing' },
    });

    // publishDue should reconcile, detect tweet is absent, set to pending, then next sweep publishes
    await publishDue(deps);

    const pubRow = await prisma.publications.findUniqueOrThrow({ where: { id: pubId } });
    // After reconciliation of absent post, it was set to pending, or published in the same sweep
    expect(['pending', 'published']).toContain(pubRow.status);
    if (pubRow.status === 'pending') {
      await publishDue(deps);
      const after = await prisma.publications.findUniqueOrThrow({ where: { id: pubId } });
      expect(after.status).toBe('published');
    }
  });

  // Scenario 7: Concurrency
  it('7. Concurrency: concurrent publishDue calls on one row result in exactly one create', async () => {
    fakeX.reset();
    const f = await fixture();
    const approveRes = await approveRevision(ctx, alice, approveInput(f));
    const pubId = approveRes.publications![0]!.id;

    // Run two sweeps in parallel
    await Promise.all([publishDue(deps), publishDue(deps)]);

    const pubRow = await prisma.publications.findUniqueOrThrow({ where: { id: pubId } });
    expect(pubRow.status).toBe('published');
    expect(fakeX.recorded.filter((r) => r.path === '/2/tweets')).toHaveLength(1);
  });

  // Scenario 8: Edited after approval
  it('8. Edited after approval: editing the candidate cancels pending publication row', async () => {
    fakeX.reset();
    const f = await fixture();
    const approveRes = await approveRevision(ctx, alice, approveInput(f));
    const pubId = approveRes.publications![0]!.id;

    // Edit candidate
    await editCandidate(ctx, alice, f.candidates[0]!.id, {
      baseRevisionId: approveRes.revisionId,
      caption: 'Updated caption after withdrawal',
    });

    const pubRow = await prisma.publications.findUniqueOrThrow({ where: { id: pubId } });
    expect(pubRow.status).toBe('cancelled');

    // Sweep does not send cancelled publication
    await publishDue(deps);
    expect(fakeX.recorded.filter((r) => r.path === '/2/tweets')).toHaveLength(0);
  });

  // Scenario 9: Hash tampering
  it('9. Hash tampering: modified revision caption fails preflight hash check, row cancelled, nothing sent', async () => {
    fakeX.reset();
    const f = await fixture();
    const approveRes = await approveRevision(ctx, alice, approveInput(f));
    const pubId = approveRes.publications![0]!.id;

    // Temporarily disable immutable trigger to simulate tampering with approved revision
    await pgc.query('ALTER TABLE smb.post_revisions DISABLE TRIGGER post_revisions_immutable');
    await prisma.post_revisions.update({
      where: { id: approveRes.revisionId },
      data: { caption: 'Tampered caption' },
    });
    await pgc.query('ALTER TABLE smb.post_revisions ENABLE TRIGGER post_revisions_immutable');

    await publishDue(deps);

    const pubRow = await prisma.publications.findUniqueOrThrow({ where: { id: pubId } });
    expect(pubRow.status).toBe('failed');
    expect(pubRow.last_error).toContain('hash_mismatch');
    expect(fakeX.recorded.filter((r) => r.path === '/2/tweets')).toHaveLength(0);
  });

  // Scenario 10: Licence withdrawn after approval
  it('10. Licence withdrawn after approval: licence_problem marks publication failed, nothing sent', async () => {
    fakeX.reset();
    const f = await fixture();
    const approveRes = await approveRevision(ctx, alice, approveInput(f));
    const pubId = approveRes.publications![0]!.id;

    // Add a rejected licence decision for photo 1
    await prisma.media_licenses.create({
      data: {
        asset_id: f.photoIds[0],
        original_url: 'https://upload.wikimedia.org/x.jpg',
        source_page_url: 'https://commons.wikimedia.org/wiki/File:X.jpg',
        photographer: 'A. Photographer',
        licence_type: 'CC BY-SA',
        licence_version: '4.0',
        licence_url: 'https://creativecommons.org/licenses/by-sa/4.0/',
        commercial_use_allowed: false,
        modifications_allowed: false,
        attribution_required: true,
        attribution_text: 'Photo: A. Photographer',
        share_alike: true,
        decision: 'rejected',
        decision_reason: 'no_commercial_use',
        rejection_codes: ['no_commercial_use'],
        verified_at: new Date(),
        verified_by: 'reviewer',
      },
    });

    await publishDue(deps);

    const pubRow = await prisma.publications.findUniqueOrThrow({ where: { id: pubId } });
    expect(pubRow.status).toBe('failed');
    expect(pubRow.last_error).toContain('licence_problem');
    expect(fakeX.recorded.filter((r) => r.path === '/2/tweets')).toHaveLength(0);
  });

  // Scenario 11: File changed in Storage
  it('11. File changed in Storage: integrity/sha mismatch marks publication failed, nothing sent', async () => {
    fakeX.reset();
    const f = await fixture();
    const approveRes = await approveRevision(ctx, alice, approveInput(f));
    const pubId = approveRes.publications![0]!.id;

    const asset = await prisma.media_assets.findUniqueOrThrow({ where: { id: f.renderAssetId } });
    // Overwrite with different bytes in store
    await store.remove(asset.bucket, asset.path);
    await store.put(asset.bucket, asset.path, new Uint8Array([1, 2, 3, 4, 5]), 'image/png');

    await publishDue(deps);

    const pubRow = await prisma.publications.findUniqueOrThrow({ where: { id: pubId } });
    expect(pubRow.status).toBe('failed');
    expect(pubRow.last_error).toMatch(/media_changed|integrity_problem/);
    expect(fakeX.recorded.filter((r) => r.path === '/2/tweets')).toHaveLength(0);
  });

  // Scenario 12: Duplicate caption
  it('12. Duplicate caption: refuses identical caption within window, permits outside window', async () => {
    fakeX.reset();
    const sharedCaption = `Identical caption text ${Date.now()}`;

    // Post 1
    const f1 = await fixture({ customCaption: sharedCaption });
    const approve1 = await approveRevision(ctx, alice, approveInput(f1));
    await publishDue(deps);
    const pub1 = await prisma.publications.findUniqueOrThrow({
      where: { id: approve1.publications![0]!.id },
    });
    expect(pub1.status).toBe('published');

    // Post 2 with identical caption
    const f2 = await fixture({ customCaption: sharedCaption });
    const approve2 = await approveRevision(ctx, alice, approveInput(f2));
    const pubId2 = approve2.publications![0]!.id;

    await publishDue(deps);

    const pub2 = await prisma.publications.findUniqueOrThrow({ where: { id: pubId2 } });
    expect(pub2.status).toBe('failed');
    expect(pub2.last_error).toContain('duplicate_caption');

    // Now age pub1 outside window (e.g. 60 days ago) and reset pub2 to pending and opp to approved
    await pgc.query('ALTER TABLE smb.publications DISABLE TRIGGER publications_updated_at');
    await prisma.publications.update({
      where: { id: pub1.id },
      data: {
        published_at: new Date(Date.now() - 60 * 86400 * 1000),
        updated_at: new Date(Date.now() - 60 * 86400 * 1000),
      },
    });
    await pgc.query('ALTER TABLE smb.publications ENABLE TRIGGER publications_updated_at');
    await prisma.post_opportunities.update({
      where: { id: f2.opportunityId },
      data: { status: 'approved' },
    });
    await prisma.publications.update({
      where: { id: pubId2 },
      data: { status: 'pending', last_error: null },
    });

    await publishDue(deps);
    const pub2Allowed = await prisma.publications.findUniqueOrThrow({ where: { id: pubId2 } });
    expect(pub2Allowed.status).toBe('published');
  });

  // Scenario 13: Scheduled in the future / expired
  it('13. Scheduled in the future: not sent until due; past not_after expires and fails', async () => {
    fakeX.reset();
    const f = await fixture();
    const baseTime = Date.now();
    const futureDate = new Date(baseTime + 3600_000);
    const approveRes = await approveRevision(ctx, alice, {
      ...approveInput(f),
      scheduledFor: futureDate,
    });
    const pubId = approveRes.publications![0]!.id;

    // Not due yet at current time
    await publishDue(deps);
    let pubRow = await prisma.publications.findUniqueOrThrow({ where: { id: pubId } });
    expect(pubRow.status).toBe('pending');
    expect(fakeX.recorded.filter((r) => r.path === '/2/tweets')).toHaveLength(0);

    // Set opportunity not_after to 90 minutes future
    await prisma.post_opportunities.update({
      where: { id: f.opportunityId },
      data: { not_after: new Date(baseTime + 5400_000) },
    });

    // Run publishDue at baseTime + 2 hours (now > scheduled_for, but now > not_after)
    await publishDue({
      ...deps,
      now: () => new Date(baseTime + 7200_000),
    });

    pubRow = await prisma.publications.findUniqueOrThrow({ where: { id: pubId } });
    expect(pubRow.status).toBe('failed');
    expect(pubRow.last_error).toContain('expired');
  });

  // Scenario 14: Rate limited
  it('14. Rate limited: 429 keeps row pending, sets retry_after, and leaves attempt_count unchanged', async () => {
    fakeX.reset();
    const f = await fixture();
    const approveRes = await approveRevision(ctx, alice, approveInput(f));
    const pubId = approveRes.publications![0]!.id;

    const resetEpoch = Math.floor(Date.now() / 1000) + 900;
    fakeX.rateLimitNextCreate = { resetEpoch };

    await publishDue(deps);

    const pubRow = await prisma.publications.findUniqueOrThrow({
      where: { id: pubId },
      include: { publication_attempts: true },
    });
    expect(pubRow.status).toBe('pending');
    expect(pubRow.attempt_count).toBe(0); // decremented back
    expect(pubRow.retry_after).toBeDefined();
    expect(pubRow.publication_attempts[0]!.outcome).toBe('rate_limited');
  });

  // Scenario 15: Mode guard
  it('15. Mode guard: live row under sandbox environment stays pending without sending', async () => {
    fakeX.reset();
    const f = await fixture();
    // Approve with mode 'live'
    const approveRes = await approveRevision(
      { ...ctx, publishMode: 'live' },
      alice,
      approveInput(f),
    );
    const pubId = approveRes.publications![0]!.id;

    // Run publishDue with sandbox env
    await publishDue({
      ...deps,
      env: { ...deps.env, SMB_PUBLISH_MODE: 'sandbox', SMB_ALLOW_LIVE_PUBLISH: false },
    });

    const pubRow = await prisma.publications.findUniqueOrThrow({ where: { id: pubId } });
    expect(pubRow.status).toBe('pending');
    expect(fakeX.recorded.filter((r) => r.path === '/2/tweets')).toHaveLength(0);
  });

  // Scenario 16: Partial failure
  it('16. Partial failure: settleOpportunity transitions to partially_published when some succeed and some fail', async () => {
    const f = await fixture();
    const approveRes = await approveRevision(ctx, alice, approveInput(f));
    const pubId1 = approveRes.publications![0]!.id;

    // Set pub1 to published: pending -> publishing -> published
    await prisma.publications.update({
      where: { id: pubId1 },
      data: { status: 'publishing' },
    });
    await prisma.publications.update({
      where: { id: pubId1 },
      data: {
        status: 'published',
        external_id: 'tweet-partial-1',
        url: 'https://x.com/smb_bot/status/tweet-partial-1',
        published_at: new Date(),
      },
    });

    // Create a second publication row manually for the same opportunity in failed state
    const action = await prisma.review_actions.findFirstOrThrow({
      where: { opportunity_id: f.opportunityId, action: 'approve' },
    });
    await pgc.query('ALTER TABLE smb.publications DISABLE TRIGGER publications_binding');
    await prisma.publications.create({
      data: {
        approval_id: action.id,
        revision_id: action.revision_id!,
        channel: 'facebook',
        mode: 'sandbox',
        status: 'failed',
        content_hash: action.content_hash!,
        idempotency_key: `pub:${action.id}:facebook`,
        last_error: 'Channel failed',
      },
    });
    await pgc.query('ALTER TABLE smb.publications ENABLE TRIGGER publications_binding');

    await prisma.$transaction(async (tx) => {
      await settleOpportunity(tx, f.opportunityId, new Date());
    });

    const opp = await prisma.post_opportunities.findUniqueOrThrow({
      where: { id: f.opportunityId },
    });
    expect(opp.status).toBe('partially_published');
  });

  // Scenario 17: No credentials anywhere
  it('17. Security scan: no credentials or OAuth signatures appear in DB summaries, errors, audit log, or captured logs', async () => {
    const forbidden = [
      FAKE_CREDS.apiKey,
      FAKE_CREDS.apiSecret,
      FAKE_CREDS.accessToken,
      FAKE_CREDS.accessTokenSecret,
      'oauth_signature',
    ];

    const attempts = await prisma.publication_attempts.findMany();
    for (const a of attempts) {
      const dump = JSON.stringify({
        req: a.request_summary,
        res: a.response_summary,
        err: a.error,
      });
      for (const token of forbidden) {
        expect(dump).not.toContain(token);
      }
    }

    const publications = await prisma.publications.findMany();
    for (const p of publications) {
      if (p.last_error) {
        for (const token of forbidden) {
          expect(p.last_error).not.toContain(token);
        }
      }
    }

    const audits = await prisma.audit_log.findMany();
    for (const a of audits) {
      const dump = JSON.stringify(a.details);
      for (const token of forbidden) {
        expect(dump).not.toContain(token);
      }
    }

    const allLogs = logLines.join('\n');
    for (const token of forbidden) {
      expect(allLogs).not.toContain(token);
    }
  });
});
