/* eslint-disable @typescript-eslint/no-explicit-any -- JSON column contents are checked loosely */
import { PrismaClient } from '@prisma/client';
import express from 'express';
import { SignJWT } from 'jose';
import sharp from 'sharp';
import request from 'supertest';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import type { ChannelsRegistry } from '@smb/shared';
import { createTokenVerifier } from '../../../apps/api/src/auth/index.js';
import { verifyOriginal } from '../../../apps/api/src/assets/index.js';
import { loadConfigSet } from '../../../apps/api/src/config/loader.js';
import { revisionHash } from '../../../apps/api/src/generation/index.js';
import {
  SAMPLE_DATA,
  loadTemplates,
  renderGraphic,
  type RenderDeps,
} from '../../../apps/api/src/graphics/index.js';
import { errorHandler } from '../../../apps/api/src/http/errors.js';
import { reviewRouter } from '../../../apps/api/src/http/routes/review.js';
import {
  ReviewError,
  approveRevision,
  editCandidate,
  opportunityDetail,
  reviewQueue,
  transitionOpportunity,
  type ActionContext,
} from '../../../apps/api/src/review/index.js';
import {
  BUCKETS,
  InMemoryObjectStore,
  contentPath,
  sha256Hex,
} from '../../../apps/api/src/storage/index.js';
import { syntheticPhoto } from '../../unit/images/pictures.js';
import { ID, freshDb, rows } from './harness.js';

let pgc: pg.Client;
let prisma: PrismaClient;
let store: InMemoryObjectStore;
let renderDeps: RenderDeps;
let channels: ChannelsRegistry;
let ctx: ActionContext;
let counter = 0;

const alice = { userId: 'user-alice' };
const bob = { userId: 'user-bob' };

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

/** An opportunity waiting for review: three candidates, a claim with its source, and a graphic for A. */
async function fixture(
  options: { status?: string; withRender?: boolean; failingSlot?: string } = {},
): Promise<Fixture> {
  const n = ++counter;
  const opp = await prisma.post_opportunities.create({
    data: {
      post_type_id: '1.1',
      post_config_id: ID.config,
      dedupe_key: `test:1.11:${n}`,
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
  for (const slot of ['A', 'B', 'C']) {
    const c = await prisma.post_candidates.create({
      data: {
        opportunity_id: opp.id,
        research_package_id: pkg.id,
        slot,
        provider: 'stub',
        prompt_version: 'v1',
        validation: { passed: slot !== options.failingSlot },
        visual_plan: { template: 'player-vs-player' },
      },
    });
    const hash = revisionHash({
      headline: `${HEADLINE} ${slot}`,
      caption: CAPTION,
      channelTexts: { x: `${CAPTION} #${slot}` },
      template: 'player-vs-player',
    });
    const r = await prisma.post_revisions.create({
      data: {
        candidate_id: c.id,
        revision_no: 1,
        caption: CAPTION,
        channel_texts: { x: `${CAPTION} #${slot}` },
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

async function expectReviewError(p: Promise<unknown>, code: string, status?: number) {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err, `expected ReviewError ${code}`).toBeInstanceOf(ReviewError);
  expect((err as ReviewError).code).toBe(code);
  if (status) expect((err as ReviewError).status).toBe(status);
}

beforeAll(async () => {
  pgc = await freshDb();
  prisma = new PrismaClient({ datasourceUrl: `${inject('dbUrl')}?schema=smb` });
  store = new InMemoryObjectStore();
  renderDeps = { db: prisma, store, registry: loadTemplates() };
  channels = loadConfigSet().channels;
  ctx = { db: prisma, store, channels };
}, 180_000);
afterAll(async () => {
  await prisma.$disconnect();
  await pgc.end();
});

describe('what the reviewer sees', () => {
  it('lists the opportunity in the queue with its headline and counts', async () => {
    const f = await fixture();
    const queue = await reviewQueue(prisma);
    const item = queue.find((q) => q.id === f.opportunityId)!;
    expect(item).toMatchObject({
      status: 'awaiting_review',
      candidateCount: 3,
      passedCount: 3,
      headline: `${HEADLINE} A`,
      postType: { id: '1.1' },
    });
    const other = await fixture({ status: 'deferred' });
    expect((await reviewQueue(prisma)).some((q) => q.id === other.opportunityId)).toBe(false);
    expect(
      (await reviewQueue(prisma, { status: 'deferred' })).some((q) => q.id === other.opportunityId),
    ).toBe(true);
  });

  it('shows three candidates with claims, sources, the graphic, photo credits and channel previews', async () => {
    const f = await fixture();
    const d = await opportunityDetail({ ...ctx, signedUrlSeconds: 120 }, f.opportunityId);
    expect(d.candidates.map((c) => c.slot)).toEqual(['A', 'B', 'C']);
    const a = d.candidates[0]!;
    expect(a.claims).toEqual([
      expect.objectContaining({
        key: 'game.result',
        verification: 'verified',
        sources: [
          expect.objectContaining({ sourceId: 'D1', url: expect.stringContaining('round-3') }),
        ],
      }),
    ]);
    expect(a.graphics).toHaveLength(1);
    expect(a.graphics[0]).toMatchObject({
      aspect: '16:9',
      templateId: 'player-vs-player',
      sha256: f.renderSha,
      stale: false,
    });
    expect(a.graphics[0]!.imageUrl).toContain('expires=120');
    expect(a.graphics[0]!.templateVersion).toMatch(/^player-vs-player@/);
    expect(a.graphics[0]!.photos).toHaveLength(2);
    expect(a.graphics[0]!.photos[0]).toMatchObject({
      photographer: 'A. Photographer',
      licenceType: 'CC BY-SA',
      attributionRequired: true,
      shareAlike: true,
      decision: 'accepted',
    });
    expect(a.willAttachGraphic).toBe(true);
    // Previews: X is on and fits; the others are off in config.
    const x = a.previews.find((p) => p.channel === 'x')!;
    expect(x).toMatchObject({ enabled: true, limit: 280, problems: [] });
    expect(a.previews.find((p) => p.channel === 'instagram')!.enabled).toBe(false);
    // B has no graphic.
    expect(d.candidates[1]!.graphics).toHaveLength(0);
    expect(d.candidates[1]!.willAttachGraphic).toBe(false);
    expect(d.approval).toBeNull();
  });

  it('flags the graphic as stale when the headline has moved on', async () => {
    const f = await fixture();
    await editCandidate(ctx, alice, f.candidates[0]!.id, {
      baseRevisionId: f.candidates[0]!.revisionId,
      headline: 'A different headline',
    });
    const d = await opportunityDetail({ ...ctx, signedUrlSeconds: 60 }, f.opportunityId);
    expect(d.candidates[0]!.graphics[0]!.stale).toBe(true);
    expect(d.candidates[0]!.willAttachGraphic).toBe(false);
  });
});

describe('approval binds to the exact revision, including the graphic', () => {
  it('adds the graphic to a new revision and approves that one', async () => {
    const f = await fixture();
    const result = await approveRevision(ctx, alice, approveInput(f));
    expect(result).toMatchObject({
      opportunityId: f.opportunityId,
      candidateId: f.candidates[0]!.id,
      boundRevisionCreated: true,
      graphicAssetId: f.renderAssetId,
      replayed: false,
      channels: ['x'],
    });
    expect(result.revisionId).not.toBe(f.candidates[0]!.revisionId);

    // The new revision has the render attached and its hash covers the file and the template version.
    const revs = await rows<any>(
      pgc,
      'select * from smb.post_revisions where candidate_id = $1 order by revision_no',
      [f.candidates[0]!.id],
    );
    expect(revs).toHaveLength(2);
    const bound = revs[1];
    expect(bound.parent_revision_id).toBe(revs[0].id);
    expect(bound.author_kind).toBe('human');
    expect(bound.author_id).toBe('user-alice');
    // Marked as the binding revision, so it is never counted as an edit (module 1.12).
    expect(bound.change_kind).toBe('binding');
    expect(bound.changed_fields).toEqual([]);
    expect(bound.content_hash).toBe(result.contentHash);
    const render = (
      await rows<any>(pgc, 'select * from smb.candidate_renders where candidate_id = $1', [
        f.candidates[0]!.id,
      ])
    )[0];
    expect(bound.template_version).toBe(render.template_version);
    expect(bound.content_hash).toBe(
      revisionHash({
        headline: bound.headline,
        caption: bound.caption,
        channelTexts: bound.channel_texts,
        template: render.template_version,
        assetHashes: [f.renderSha],
      }),
    );
    expect(bound.content_hash).not.toBe(revs[0].content_hash);
    const attached = await rows<any>(
      pgc,
      'select * from smb.revision_assets where revision_id = $1',
      [bound.id],
    );
    expect(attached).toEqual([
      expect.objectContaining({ asset_id: f.renderAssetId, role: 'graphic' }),
    ]);
    expect(
      (await rows(pgc, 'select 1 from smb.revision_claims where revision_id = $1', [bound.id]))
        .length,
    ).toBe(1);

    // The recorded approval, the status change, the history and the audit entry.
    const action = (
      await rows<any>(pgc, 'select * from smb.review_actions where id = $1', [result.approvalId])
    )[0];
    expect(action).toMatchObject({
      action: 'approve',
      revision_id: bound.id,
      content_hash: bound.content_hash,
      reviewer_id: 'user-alice',
      channels: '{x}', // pg hands back an enum array as text
    });
    const opp = (
      await rows<any>(pgc, 'select status from smb.post_opportunities where id = $1', [
        f.opportunityId,
      ])
    )[0];
    expect(opp.status).toBe('approved');
    const events = await rows<any>(
      pgc,
      'select to_status, actor from smb.opportunity_events where opportunity_id = $1 order by seq desc limit 1',
      [f.opportunityId],
    );
    expect(events[0]).toMatchObject({ to_status: 'approved', actor: 'user:user-alice' });
    const audit = await rows<any>(
      pgc,
      "select * from smb.audit_log where action = 'review.approve' and target_id = $1",
      [bound.id],
    );
    expect(audit).toHaveLength(1);
    expect(audit[0].details).toMatchObject({
      reviewedHash: f.candidates[0]!.hash,
      approvedHash: bound.content_hash,
      graphicAssetId: f.renderAssetId,
    });

    // The reviewer's view now shows the approval and no further graphic to attach.
    const d = await opportunityDetail({ ...ctx, signedUrlSeconds: 60 }, f.opportunityId);
    expect(d.approval).toMatchObject({ revisionId: bound.id, reviewerId: 'user-alice' });
    expect(d.candidates[0]!.revision.id).toBe(bound.id);
    expect(d.candidates[0]!.revision.attachedAssetIds).toEqual([f.renderAssetId]);
  });

  it('approves a candidate that has no graphic as it is (X does not require an image)', async () => {
    const f = await fixture();
    const result = await approveRevision(ctx, alice, approveInput(f, 1));
    expect(result).toMatchObject({
      revisionId: f.candidates[1]!.revisionId,
      boundRevisionCreated: false,
      graphicAssetId: null,
    });
  });

  it('refuses a hash the reviewer did not see, and a revision that is not the newest', async () => {
    const f = await fixture();
    await expectReviewError(
      approveRevision(ctx, alice, approveInput(f, 0, { contentHash: 'f'.repeat(64) })),
      'stale_hash',
      409,
    );
    const edited = await editCandidate(ctx, bob, f.candidates[0]!.id, {
      baseRevisionId: f.candidates[0]!.revisionId,
      caption: 'Gukesh leads 2-1 after beating Sindarov.',
    });
    // Alice is still holding the first revision.
    await expectReviewError(
      approveRevision(ctx, alice, approveInput(f)),
      'revision_superseded',
      409,
    );
    // The edit's own hash approves.
    const ok = await approveRevision(ctx, alice, {
      revisionId: edited.revisionId,
      contentHash: edited.contentHash,
      channels: ['x'],
    });
    expect(ok.contentHash).not.toBe(edited.contentHash); // the graphic was added, so the bound revision has a new hash
  });

  it('allows only one approval per opportunity', async () => {
    const f = await fixture();
    await approveRevision(ctx, alice, approveInput(f, 1));
    await expectReviewError(approveRevision(ctx, bob, approveInput(f, 2)), 'wrong_status', 409);
  });

  it('refuses channels that are off or unknown, no channel, and times that cannot work', async () => {
    const f = await fixture();
    await expectReviewError(
      approveRevision(ctx, alice, approveInput(f, 1, { channels: ['instagram'] })),
      'channel_disabled',
      422,
    );
    await expectReviewError(
      approveRevision(ctx, alice, approveInput(f, 1, { channels: [] })),
      'no_channels',
      422,
    );
    await expectReviewError(
      approveRevision(ctx, alice, approveInput(f, 1, { channels: ['mastodon'] })),
      'unknown_channel',
      422,
    );
    await expectReviewError(
      approveRevision(
        ctx,
        alice,
        approveInput(f, 1, { scheduledFor: new Date(Date.now() - 60_000) }),
      ),
      'schedule_in_past',
      422,
    );
    await prisma.post_opportunities.update({
      where: { id: f.opportunityId },
      data: { not_after: new Date(Date.now() + 3_600_000) },
    });
    await expectReviewError(
      approveRevision(
        ctx,
        alice,
        approveInput(f, 1, { scheduledFor: new Date(Date.now() + 7_200_000) }),
      ),
      'schedule_after_expiry',
      422,
    );
    const when = new Date(Date.now() + 1_800_000);
    const ok = await approveRevision(ctx, alice, approveInput(f, 1, { scheduledFor: when }));
    expect(ok.scheduledFor).toBe(when.toISOString());
    const opp = await prisma.post_opportunities.findUniqueOrThrow({
      where: { id: f.opportunityId },
    });
    expect(opp.scheduled_for?.toISOString()).toBe(when.toISOString());
  });

  it('refuses an opportunity that has expired', async () => {
    const f = await fixture();
    await prisma.post_opportunities.update({
      where: { id: f.opportunityId },
      data: { not_after: new Date(Date.now() - 1000) },
    });
    await expectReviewError(
      approveRevision(ctx, alice, approveInput(f, 1)),
      'opportunity_expired',
      409,
    );
  });

  it('makes a reviewer acknowledge failed automatic checks on an AI candidate', async () => {
    const f = await fixture({ failingSlot: 'B' });
    await expectReviewError(approveRevision(ctx, alice, approveInput(f, 1)), 'failed_checks', 422);
    const ok = await approveRevision(
      ctx,
      alice,
      approveInput(f, 1, { acknowledgeFailedChecks: true }),
    );
    expect(ok.replayed).toBe(false);
    const audit = await rows<any>(
      pgc,
      "select details from smb.audit_log where action = 'review.approve' and target_id = $1",
      [f.candidates[1]!.revisionId],
    );
    expect(audit[0].details.acknowledgedFailedChecks).toBe(true);
  });

  it('a retry with the same Idempotency-Key returns the first approval and records nothing new', async () => {
    const f = await fixture();
    const first = await approveRevision(
      ctx,
      alice,
      approveInput(f, 0, { idempotencyKey: 'retry-key-0001' }),
    );
    const again = await approveRevision(
      ctx,
      alice,
      approveInput(f, 0, { idempotencyKey: 'retry-key-0001' }),
    );
    expect(again).toMatchObject({
      approvalId: first.approvalId,
      revisionId: first.revisionId,
      replayed: true,
    });
    expect(
      (
        await rows(
          pgc,
          "select 1 from smb.review_actions where opportunity_id = $1 and action = 'approve'",
          [f.opportunityId],
        )
      ).length,
    ).toBe(1);
    expect(
      (
        await rows(pgc, 'select 1 from smb.post_revisions where candidate_id = $1', [
          f.candidates[0]!.id,
        ])
      ).length,
    ).toBe(2);
    // The same key from another person is a different key.
    const g = await fixture();
    const other = await approveRevision(
      ctx,
      bob,
      approveInput(g, 1, { idempotencyKey: 'retry-key-0001' }),
    );
    expect(other.replayed).toBe(false);
  });

  it('two approvals at the same time: one wins, one is refused, and only one approval exists', async () => {
    const f = await fixture();
    const results = await Promise.allSettled([
      approveRevision(ctx, alice, approveInput(f, 0)),
      approveRevision(ctx, bob, approveInput(f, 1)),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(ReviewError);
    expect((lost.reason as ReviewError).code).toBe('wrong_status');
    expect(
      (
        await rows(
          pgc,
          "select 1 from smb.review_actions where opportunity_id = $1 and action = 'approve'",
          [f.opportunityId],
        )
      ).length,
    ).toBe(1);
  });

  it('refuses when a photograph in the graphic was replaced in Storage after it was rendered', async () => {
    const f = await fixture();
    const asset = await prisma.media_assets.findUniqueOrThrow({ where: { id: f.photoIds[0] } });
    const original = (await store.get(asset.bucket, asset.path))!;
    const tampered = await sharp(Buffer.from(original))
      .linear(0.6, 0)
      .jpeg({ quality: 90 })
      .toBuffer();
    store.objects.set(`${asset.bucket}/${asset.path}`, {
      bytes: new Uint8Array(tampered),
      contentType: 'image/jpeg',
    });
    await expectReviewError(approveRevision(ctx, alice, approveInput(f)), 'asset_not_cleared', 409);
    expect(
      (await prisma.post_opportunities.findUniqueOrThrow({ where: { id: f.opportunityId } }))
        .status,
    ).toBe('awaiting_review');
    store.objects.set(`${asset.bucket}/${asset.path}`, {
      bytes: original,
      contentType: 'image/jpeg',
    });
  });

  it('refuses when a photograph licence has been withdrawn', async () => {
    const f = await fixture();
    await prisma.$executeRaw`insert into smb.media_licenses (asset_id, original_url, licence_type, commercial_use_allowed, modifications_allowed, attribution_required, decision, decision_reason, verified_at, verified_by)
      values (${f.photoIds[1]}::uuid, 'https://upload.wikimedia.org/x.jpg', 'CC BY-SA', true, true, true, 'rejected', 'withdrawn', clock_timestamp() + interval '1 second', 'test')`;
    await expectReviewError(approveRevision(ctx, alice, approveInput(f)), 'asset_not_cleared', 409);
  });

  it('refuses a graphic that was drawn for a different headline', async () => {
    const f = await fixture();
    await editCandidate(ctx, alice, f.candidates[0]!.id, {
      baseRevisionId: f.candidates[0]!.revisionId,
      headline: 'Brand new headline',
    });
    const newest = await prisma.post_revisions.findFirstOrThrow({
      where: { candidate_id: f.candidates[0]!.id },
      orderBy: { revision_no: 'desc' },
    });
    await expectReviewError(
      approveRevision(ctx, alice, {
        revisionId: newest.id,
        contentHash: newest.content_hash,
        channels: ['x'],
      }),
      'graphic_stale',
      409,
    );
  });

  it('rejects an approval whose hash was altered even if it bypasses the service (database trigger)', async () => {
    const f = await fixture();
    await expect(
      pgc.query(
        `insert into smb.review_actions (opportunity_id, candidate_id, revision_id, action, content_hash, reviewer_id, channels)
         values ($1, $2, $3, 'approve', $4, 'user-x', '{x}')`,
        [f.opportunityId, f.candidates[0]!.id, f.candidates[0]!.revisionId, 'a'.repeat(64)],
      ),
    ).rejects.toThrow(/does not match/);
  });
});

describe('editing', () => {
  it('saves a person’s change as a new immutable revision and leaves the old one alone', async () => {
    const f = await fixture();
    const r = await editCandidate(ctx, alice, f.candidates[1]!.id, {
      baseRevisionId: f.candidates[1]!.revisionId,
      caption: 'A shorter caption.',
      changeNote: 'tightened',
    });
    expect(r).toMatchObject({ revisionNo: 2, graphicStale: false, approvalWithdrawn: false });
    const revs = await rows<any>(
      pgc,
      'select * from smb.post_revisions where candidate_id = $1 order by revision_no',
      [f.candidates[1]!.id],
    );
    expect(revs[0].caption).toBe(CAPTION);
    expect(revs[1]).toMatchObject({
      caption: 'A shorter caption.',
      author_kind: 'human',
      author_id: 'user-alice',
      change_note: 'tightened',
      parent_revision_id: revs[0].id,
    });
    expect(revs[1].content_hash).not.toBe(revs[0].content_hash);
    expect(
      (await rows(pgc, 'select 1 from smb.revision_claims where revision_id = $1', [revs[1].id]))
        .length,
    ).toBe(1);
  });

  it('computes the same hash the generator did when text is unchanged but refuses an edit that changes nothing', async () => {
    const f = await fixture();
    await expectReviewError(
      editCandidate(ctx, alice, f.candidates[1]!.id, {
        baseRevisionId: f.candidates[1]!.revisionId,
        caption: CAPTION,
      }),
      'no_change',
      422,
    );
  });

  it('refuses text that no longer fits a channel, an unknown channel and an empty caption', async () => {
    const f = await fixture();
    const base = f.candidates[1]!.revisionId;
    await expectReviewError(
      editCandidate(ctx, alice, f.candidates[1]!.id, {
        baseRevisionId: base,
        channelTexts: { x: 'x'.repeat(300) },
      }),
      'channel_rules',
      422,
    );
    await expectReviewError(
      editCandidate(ctx, alice, f.candidates[1]!.id, {
        baseRevisionId: base,
        channelTexts: { mastodon: 'hi' },
      }),
      'unknown_channel',
      422,
    );
    await expectReviewError(
      editCandidate(ctx, alice, f.candidates[1]!.id, { baseRevisionId: base, caption: '   ' }),
      'empty_caption',
      422,
    );
  });

  it('refuses an edit from someone who is looking at an older revision', async () => {
    const f = await fixture();
    await editCandidate(ctx, alice, f.candidates[1]!.id, {
      baseRevisionId: f.candidates[1]!.revisionId,
      caption: 'First change.',
    });
    await expectReviewError(
      editCandidate(ctx, bob, f.candidates[1]!.id, {
        baseRevisionId: f.candidates[1]!.revisionId,
        caption: 'Second change.',
      }),
      'revision_superseded',
      409,
    );
  });

  it('keeps an already attached graphic for a caption change, and drops it when the headline changes', async () => {
    const f = await fixture();
    const approved = await approveRevision(ctx, alice, approveInput(f));
    // Approval is withdrawn by any edit; a caption edit keeps the graphic on the new revision.
    const e1 = await editCandidate(ctx, alice, f.candidates[0]!.id, {
      baseRevisionId: approved.revisionId,
      caption: 'Edited after approval.',
    });
    expect(e1.approvalWithdrawn).toBe(true);
    expect(e1.graphicStale).toBe(false);
    const kept = await rows<any>(pgc, 'select * from smb.revision_assets where revision_id = $1', [
      e1.revisionId,
    ]);
    expect(kept).toHaveLength(1);
    const e2 = await editCandidate(ctx, alice, f.candidates[0]!.id, {
      baseRevisionId: e1.revisionId,
      headline: 'A totally new headline',
    });
    expect(e2.graphicStale).toBe(true);
    expect(
      (await rows(pgc, 'select 1 from smb.revision_assets where revision_id = $1', [e2.revisionId]))
        .length,
    ).toBe(0);
  });

  it('withdraws an approval in force, cancels its pending publications and records why', async () => {
    const f = await fixture();
    const approved = await approveRevision(ctx, alice, approveInput(f, 1));
    await pgc.query(
      `insert into smb.publications (approval_id, revision_id, channel, mode, content_hash, idempotency_key)
       values ($1, $2, 'x', 'dry_run', $3, 'pub-key-1')`,
      [approved.approvalId, approved.revisionId, approved.contentHash],
    );
    const r = await editCandidate(ctx, bob, f.candidates[1]!.id, {
      baseRevisionId: approved.revisionId,
      caption: 'Changed my mind.',
    });
    expect(r.approvalWithdrawn).toBe(true);
    expect(
      (await prisma.post_opportunities.findUniqueOrThrow({ where: { id: f.opportunityId } }))
        .status,
    ).toBe('awaiting_review');
    const pub = (
      await rows<any>(
        pgc,
        "select status, last_error from smb.publications where idempotency_key = 'pub-key-1'",
      )
    )[0];
    expect(pub.status).toBe('cancelled');
    expect(pub.last_error).toMatch(/edited/);
    const note = (
      await rows<any>(
        pgc,
        "select * from smb.review_actions where opportunity_id = $1 and action = 'comment'",
        [f.opportunityId],
      )
    )[0];
    expect(note.feedback_tags).toContain('approval_withdrawn');
    // The old approval does not unlock the new revision: approving the new one needs a new approval.
    const d = await opportunityDetail({ ...ctx, signedUrlSeconds: 60 }, f.opportunityId);
    expect(d.approval).toBeNull();
    const again = await approveRevision(ctx, alice, {
      revisionId: r.revisionId,
      contentHash: r.contentHash,
      channels: ['x'],
    });
    expect(again.replayed).toBe(false);
  });

  it('uses the re-render hook, when there is one, so a headline change does not leave a stale graphic', async () => {
    const f = await fixture();
    const hooked: ActionContext = {
      ...ctx,
      rerender: async (candidateId, revisionId) => {
        await renderGraphic(renderDeps, {
          template: 'game-result',
          aspect: '16:9',
          candidateId,
          revisionId,
          data: {
            ...SAMPLE_DATA['player-vs-player']!,
            texts: { ...SAMPLE_DATA['player-vs-player']!.texts, subtitle: 'Round 4' },
            photos: { photo_a: { assetId: f.photoIds[0] }, photo_b: { assetId: f.photoIds[1] } },
          },
        });
      },
    };
    const r = await editCandidate(hooked, alice, f.candidates[0]!.id, {
      baseRevisionId: f.candidates[0]!.revisionId,
      headline: 'Round 4 preview',
    });
    expect(r).toMatchObject({ graphicStale: false, graphicRegenerated: true });
    const ok = await approveRevision(hooked, alice, {
      revisionId: r.revisionId,
      contentHash: r.contentHash,
      channels: ['x'],
    });
    expect(ok.boundRevisionCreated).toBe(true);
    const render = await prisma.candidate_renders.findFirstOrThrow({
      where: { candidate_id: f.candidates[0]!.id, revision_id: r.revisionId },
    });
    expect(ok.graphicAssetId).toBe(render.render_asset_id);
  });
});

describe('reject, defer, regenerate, request research, reopen', () => {
  it('needs a reason for reject, defer, regenerate and request research', async () => {
    const f = await fixture();
    for (const kind of ['reject', 'defer', 'regenerate', 'request_research'] as const) {
      await expectReviewError(
        transitionOpportunity(ctx, alice, f.opportunityId, kind),
        'feedback_required',
        422,
      );
    }
    await expectReviewError(
      transitionOpportunity(ctx, alice, f.opportunityId, 'reject', {
        feedbackTags: Array.from({ length: 11 }, (_, i) => `t${i}`),
      }),
      'bad_tags',
      422,
    );
  });

  it('rejects, records the action, the status history and an audit entry', async () => {
    const f = await fixture();
    const r = await transitionOpportunity(ctx, alice, f.opportunityId, 'reject', {
      feedback: 'Wrong story',
      feedbackTags: ['off_topic'],
    });
    expect(r).toMatchObject({ status: 'rejected', replayed: false });
    const a = (
      await rows<any>(pgc, 'select * from smb.review_actions where id = $1', [r.actionId])
    )[0];
    expect(a).toMatchObject({
      action: 'reject',
      feedback: 'Wrong story',
      reviewer_id: 'user-alice',
    });
    expect(a.feedback_tags).toEqual(['off_topic']);
    expect(
      (
        await rows<any>(
          pgc,
          "select 1 from smb.audit_log where action = 'review.reject' and target_id = $1",
          [f.opportunityId],
        )
      ).length,
    ).toBe(1);
    const ev = (
      await rows<any>(
        pgc,
        'select reason, actor from smb.opportunity_events where opportunity_id = $1 order by seq desc limit 1',
        [f.opportunityId],
      )
    )[0];
    expect(ev).toMatchObject({ actor: 'user:user-alice', reason: 'Wrong story' });
    // Terminal: nothing more can be done.
    await expectReviewError(
      transitionOpportunity(ctx, bob, f.opportunityId, 'defer', { feedback: 'x' }),
      'wrong_status',
      409,
    );
    await expectReviewError(approveRevision(ctx, bob, approveInput(f, 1)), 'wrong_status', 409);
  });

  it('defers, reopens and then approves', async () => {
    const f = await fixture();
    const until = new Date(Date.now() + 86_400_000);
    const d = await transitionOpportunity(ctx, alice, f.opportunityId, 'defer', {
      feedback: 'Wait for round 4',
      deferUntil: until,
    });
    expect(d.status).toBe('deferred');
    const action = await prisma.review_actions.findUniqueOrThrow({ where: { id: d.actionId } });
    expect(action.scheduled_for?.toISOString()).toBe(until.toISOString());
    await expectReviewError(approveRevision(ctx, alice, approveInput(f, 1)), 'wrong_status', 409);
    const o = await transitionOpportunity(ctx, alice, f.opportunityId, 'reopen');
    expect(o.status).toBe('awaiting_review');
    const ok = await approveRevision(ctx, alice, approveInput(f, 1));
    expect(ok.replayed).toBe(false);
  });

  it('regenerate moves to generating and queues one GPU job carrying the reviewer’s words', async () => {
    const f = await fixture();
    const r = await transitionOpportunity(ctx, alice, f.opportunityId, 'regenerate', {
      feedback: 'More about the endgame',
      feedbackTags: ['tone'],
      idempotencyKey: 'regen-key-0001',
    });
    expect(r.status).toBe('generating');
    expect(r.jobId).toBeTruthy();
    const job = (await rows<any>(pgc, 'select * from smb.jobs where id = $1', [r.jobId]))[0];
    expect(job).toMatchObject({
      lane: 'gpu',
      kind: 'candidates_generate',
      status: 'queued',
      opportunity_id: f.opportunityId,
    });
    expect(job.payload).toMatchObject({
      opportunityId: f.opportunityId,
      newCycle: true,
      feedback: { text: 'More about the endgame', tags: ['tone'] },
    });
    const again = await transitionOpportunity(ctx, alice, f.opportunityId, 'regenerate', {
      feedback: 'More about the endgame',
      idempotencyKey: 'regen-key-0001',
    });
    expect(again).toMatchObject({ actionId: r.actionId, replayed: true });
    expect(
      (
        await rows(
          pgc,
          "select 1 from smb.jobs where kind = 'candidates_generate' and opportunity_id = $1",
          [f.opportunityId],
        )
      ).length,
    ).toBe(1);
    // Reusing a key for another kind of action is refused.
    await prisma.post_opportunities.update({
      where: { id: f.opportunityId },
      data: { status: 'awaiting_review' },
    });
    await expectReviewError(
      transitionOpportunity(ctx, alice, f.opportunityId, 'reject', {
        feedback: 'x',
        idempotencyKey: 'regen-key-0001',
      }),
      'idempotency_conflict',
      409,
    );
  });

  it('request research returns the opportunity to researching', async () => {
    const f = await fixture();
    const r = await transitionOpportunity(ctx, alice, f.opportunityId, 'request_research', {
      feedback: 'Check the clock times',
    });
    expect(r.status).toBe('researching');
    expect(
      (await prisma.post_opportunities.findUniqueOrThrow({ where: { id: f.opportunityId } }))
        .status,
    ).toBe('researching');
  });

  it('checks that a named candidate or revision belongs to the opportunity', async () => {
    const f = await fixture();
    const g = await fixture();
    await expectReviewError(
      transitionOpportunity(ctx, alice, f.opportunityId, 'reject', {
        feedback: 'x',
        candidateId: g.candidates[0]!.id,
      }),
      'not_found',
      404,
    );
    await expectReviewError(
      transitionOpportunity(ctx, alice, f.opportunityId, 'reject', {
        feedback: 'x',
        revisionId: g.candidates[0]!.revisionId,
      }),
      'not_found',
      404,
    );
  });

  it('after a regeneration the old candidates can no longer be approved or edited', async () => {
    const f = await fixture();
    const pkg = await prisma.post_candidates.findFirstOrThrow({
      where: { opportunity_id: f.opportunityId },
    });
    const c2 = await prisma.post_candidates.create({
      data: {
        opportunity_id: f.opportunityId,
        research_package_id: pkg.research_package_id,
        generation_cycle: 2,
        slot: 'A',
        provider: 'stub',
        prompt_version: 'v1',
      },
    });
    await prisma.post_revisions.create({
      data: {
        candidate_id: c2.id,
        revision_no: 1,
        caption: 'New',
        headline: 'New',
        author_kind: 'ai',
        content_hash: 'b'.repeat(64),
      },
    });
    await expectReviewError(
      approveRevision(ctx, alice, approveInput(f, 1)),
      'candidate_superseded',
      409,
    );
    await expectReviewError(
      editCandidate(ctx, alice, f.candidates[1]!.id, {
        baseRevisionId: f.candidates[1]!.revisionId,
        caption: 'x',
      }),
      'candidate_superseded',
      409,
    );
  });
});

describe('the HTTP surface', () => {
  const secret = new TextEncoder().encode('http-test-secret-http-test-secret-1234');
  const verifier = createTokenVerifier({
    alg: 'HS256',
    key: secret,
    issuer: 'xlchess',
    audience: 'smb',
    userIdClaim: 'sub',
  });
  const app = () => {
    const a = express();
    a.use(express.json());
    a.use(reviewRouter({ verifier, read: { ...ctx, signedUrlSeconds: 60 }, act: ctx }));
    a.use(errorHandler);
    return a;
  };
  const token = (role: string | null, sub = 'user-http') =>
    new SignJWT(role ? { smb_role: role } : {})
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('xlchess')
      .setAudience('smb')
      .setSubject(sub)
      .setIssuedAt()
      .setExpirationTime('60s')
      .sign(secret);

  it('needs a valid token and a role on every route', async () => {
    const f = await fixture({ withRender: false });
    const paths: [string, string][] = [
      ['get', '/v1/review/queue'],
      ['get', `/v1/opportunities/${f.opportunityId}`],
      ['post', `/v1/revisions/${f.candidates[0]!.revisionId}/approve`],
      ['post', `/v1/candidates/${f.candidates[0]!.id}/revisions`],
      ['post', `/v1/opportunities/${f.opportunityId}/reject`],
    ];
    for (const [method, path] of paths) {
      await (request(app()) as any)[method](path).expect(401);
      await (request(app()) as any)
        [method](path)
        .set('Authorization', `Bearer ${await token(null)}`)
        .expect(403);
    }
  });

  it('serves the queue and detail, and approves, with the API’s error shape', async () => {
    const f = await fixture();
    const auth = `Bearer ${await token('reviewer', 'user-http')}`;
    const q = await request(app()).get('/v1/review/queue').set('Authorization', auth).expect(200);
    expect(q.body.items.some((i: any) => i.id === f.opportunityId)).toBe(true);
    const detail = await request(app())
      .get(`/v1/opportunities/${f.opportunityId}`)
      .set('Authorization', auth)
      .expect(200);
    expect(detail.body.candidates).toHaveLength(3);
    await request(app()).get('/v1/opportunities/not-a-uuid').set('Authorization', auth).expect(400);
    const missing = await request(app())
      .get('/v1/opportunities/00000000-0000-4000-8000-0000000000ff')
      .set('Authorization', auth)
      .expect(404);
    expect(missing.body.error.code).toBe('not_found');

    const path = `/v1/revisions/${f.candidates[0]!.revisionId}/approve`;
    const stale = await request(app())
      .post(path)
      .set('Authorization', auth)
      .send({ contentHash: 'c'.repeat(64), channels: ['x'] })
      .expect(409);
    expect(stale.body.error.code).toBe('stale_hash');
    await request(app())
      .post(path)
      .set('Authorization', auth)
      .send({ contentHash: f.candidates[0]!.hash, channels: ['x'], extra: 1 })
      .expect(400);
    await request(app())
      .post(path)
      .set('Authorization', auth)
      .set('Idempotency-Key', 'short')
      .send({ contentHash: f.candidates[0]!.hash, channels: ['x'] })
      .expect(400);
    const ok = await request(app())
      .post(path)
      .set('Authorization', auth)
      .set('Idempotency-Key', 'http-key-12345')
      .send({ contentHash: f.candidates[0]!.hash, channels: ['x'] })
      .expect(201);
    expect(ok.body).toMatchObject({ boundRevisionCreated: true, graphicAssetId: f.renderAssetId });
    const replay = await request(app())
      .post(path)
      .set('Authorization', auth)
      .set('Idempotency-Key', 'http-key-12345')
      .send({ contentHash: f.candidates[0]!.hash, channels: ['x'] })
      .expect(200);
    expect(replay.body).toMatchObject({ approvalId: ok.body.approvalId, replayed: true });
    const d2 = await request(app())
      .get(`/v1/opportunities/${f.opportunityId}`)
      .set('Authorization', auth)
      .expect(200);
    expect(d2.body.approval).toMatchObject({ reviewerId: 'user-http' });
  });

  it('edits and runs the other actions over HTTP', async () => {
    const f = await fixture({ withRender: false });
    const auth = `Bearer ${await token('admin', 'user-admin')}`;
    const e = await request(app())
      .post(`/v1/candidates/${f.candidates[0]!.id}/revisions`)
      .set('Authorization', auth)
      .send({ baseRevisionId: f.candidates[0]!.revisionId, caption: 'Edited over HTTP.' })
      .expect(201);
    expect(e.body.revisionNo).toBe(2);
    await request(app())
      .post(`/v1/opportunities/${f.opportunityId}/reject`)
      .set('Authorization', auth)
      .send({})
      .expect(422);
    const d = await request(app())
      .post(`/v1/opportunities/${f.opportunityId}/defer`)
      .set('Authorization', auth)
      .send({ feedback: 'later' })
      .expect(201);
    expect(d.body.status).toBe('deferred');
    const r = await request(app())
      .post(`/v1/opportunities/${f.opportunityId}/reopen`)
      .set('Authorization', auth)
      .send({})
      .expect(201);
    expect(r.body.status).toBe('awaiting_review');
    await request(app())
      .post(`/v1/opportunities/${f.opportunityId}/request-research`)
      .set('Authorization', auth)
      .send({ feedback: 'recheck' })
      .expect(201);
  });

  it('never returns credentials or storage keys', async () => {
    const f = await fixture();
    const auth = `Bearer ${await token('reviewer')}`;
    const detail = await request(app())
      .get(`/v1/opportunities/${f.opportunityId}`)
      .set('Authorization', auth)
      .expect(200);
    const text = JSON.stringify(detail.body);
    expect(text).not.toMatch(/service_role|serviceRole|secret|password|apikey/i);
  });
});
