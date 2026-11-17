import type { Prisma, PrismaClient } from '@prisma/client';
import type { ChannelsRegistry } from '@smb/shared';
import type { ObjectStore } from '../storage/index.js';
import { channelPreviews, type ChannelPreview } from './previews.js';

export class ReviewNotFoundError extends Error {
  constructor(what: string) {
    super(`${what} not found`);
    this.name = 'ReviewNotFoundError';
  }
}

export interface ReviewContext {
  db: PrismaClient;
  store: ObjectStore;
  channels: ChannelsRegistry;
  /** How long an image link works, in seconds. */
  signedUrlSeconds: number;
}

export const QUEUE_STATUSES = ['awaiting_review', 'deferred'] as const;
export type QueueStatus = (typeof QUEUE_STATUSES)[number];

export interface QueueItem {
  id: string;
  postType: { id: string; name: string };
  status: string;
  priority: number;
  scheduledFor: string | null;
  notAfter: string | null;
  createdAt: string;
  generationCycle: number | null;
  candidateCount: number;
  /** Candidates that passed every automatic check. */
  passedCount: number;
  /** The first candidate's headline, enough to recognise the story in a list. */
  headline: string | null;
}

/** Opportunities waiting for a person, most urgent first. */
export async function reviewQueue(
  db: PrismaClient,
  options: { status?: QueueStatus; limit?: number } = {},
): Promise<QueueItem[]> {
  const opportunities = await db.post_opportunities.findMany({
    where: { status: options.status ?? 'awaiting_review' },
    orderBy: [
      { priority: 'asc' },
      { scheduled_for: { sort: 'asc', nulls: 'last' } },
      { created_at: 'asc' },
    ],
    take: Math.min(options.limit ?? 50, 200),
    include: { post_types: { select: { id: true, name: true } } },
  });
  const items: QueueItem[] = [];
  for (const o of opportunities) {
    const latest = await db.post_candidates.aggregate({
      where: { opportunity_id: o.id },
      _max: { generation_cycle: true },
    });
    const cycle = latest._max.generation_cycle;
    const candidates = cycle
      ? await db.post_candidates.findMany({
          where: { opportunity_id: o.id, generation_cycle: cycle },
          orderBy: { slot: 'asc' },
          include: { post_revisions: { orderBy: { revision_no: 'desc' }, take: 1 } },
        })
      : [];
    items.push({
      id: o.id,
      postType: o.post_types,
      status: o.status,
      priority: o.priority,
      scheduledFor: o.scheduled_for?.toISOString() ?? null,
      notAfter: o.not_after?.toISOString() ?? null,
      createdAt: o.created_at.toISOString(),
      generationCycle: cycle,
      candidateCount: candidates.length,
      passedCount: candidates.filter((c) => (c.validation as { passed?: boolean } | null)?.passed)
        .length,
      headline: candidates[0]?.post_revisions[0]?.headline ?? null,
    });
  }
  return items;
}

export interface PhotoCredit {
  slot: string;
  assetId: string;
  /** The stored original this photograph was cut from. */
  originalAssetId: string | null;
  sourcePageUrl: string | null;
  photographer: string | null;
  licenceType: string | null;
  licenceUrl: string | null;
  attributionRequired: boolean | null;
  attributionText: string | null;
  shareAlike: boolean | null;
  decision: string | null;
}

export interface GraphicView {
  renderId: string;
  assetId: string;
  imageUrl: string;
  aspect: string;
  width: number | null;
  height: number | null;
  templateId: string;
  templateVersion: string;
  sha256: string;
  /** The revision this graphic was made for. */
  madeForRevisionId: string | null;
  /** True when the graphic was drawn for a different headline than the latest revision's. */
  stale: boolean;
  photos: PhotoCredit[];
}

export interface RevisionSummary {
  id: string;
  revisionNo: number;
  authorKind: string;
  authorId: string | null;
  changeNote: string | null;
  /** `factual`, `creative`, `mixed`, `binding` (approval added the graphic) or `ai_revision`; null when unlabelled. */
  changeKind: string | null;
  changedFields: string[];
  changeTags: string[];
  /** For a rewrite by the model: the request it answered. */
  feedbackActionId: string | null;
  /** For a rewrite by the model: whether it passed the automatic checks. */
  passedChecks: boolean | null;
  contentHash: string;
  createdAt: string;
}

export interface ClaimView {
  key: string;
  description: string;
  value: unknown;
  verification: string;
  confidence: number | null;
  sources: { sourceId: string; url: string; retrievedAt: string }[];
}

export interface CandidateView {
  id: string;
  slot: string;
  angle: string | null;
  approach: string | null;
  provider: string;
  model: string | null;
  validation: unknown;
  /** The revision a reviewer is looking at: the newest one. */
  revision: {
    id: string;
    revisionNo: number;
    headline: string | null;
    caption: string;
    channelTexts: unknown;
    altText: string | null;
    contentHash: string;
    authorKind: string;
    authorId: string | null;
    changeNote: string | null;
    changeKind: string | null;
    /** The automatic checks of a rewrite by the model. Null for other revisions: see the candidate's `validation`. */
    validation: unknown;
    createdAt: string;
    attachedAssetIds: string[];
  };
  revisions: RevisionSummary[];
  claims: ClaimView[];
  graphics: GraphicView[];
  /** True when approving will attach a graphic. */
  willAttachGraphic: boolean;
  /** True while a rewrite by the model has been asked for and has not arrived yet. */
  revisionPending: boolean;
  previews: ChannelPreview[];
}

export interface ReviewActionView {
  id: string;
  action: string;
  candidateId: string | null;
  revisionId: string | null;
  contentHash: string | null;
  reviewerId: string;
  channels: string[];
  scheduledFor: string | null;
  feedback: string | null;
  feedbackTags: string[];
  createdAt: string;
}

export interface OpportunityDetail {
  id: string;
  postType: { id: string; name: string };
  status: string;
  priority: number;
  phase: string | null;
  scheduledFor: string | null;
  notAfter: string | null;
  generationCycle: number | null;
  candidates: CandidateView[];
  /** Earlier generation cycles (regenerated away), newest first. */
  earlierCycles: { cycle: number; candidateIds: string[] }[];
  /** The approval in force, if there is one. */
  approval: ReviewActionView | null;
  history: ReviewActionView[];
  statusHistory: {
    from: string | null;
    to: string;
    actor: string;
    reason: string | null;
    at: string;
  }[];
  publications: {
    id: string;
    channel: string;
    mode: string;
    status: string;
    scheduledFor: string | null;
    url: string | null;
    publishedAt: string | null;
    lastError: string | null;
  }[];
}

/** The newest graphic of each shape that the revision can use. */
export function pickGraphic<T extends { aspect: string; created_at: Date }>(
  renders: T[],
): T | undefined {
  const sorted = [...renders].sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
  return sorted.find((r) => r.aspect === '16:9') ?? sorted[0];
}

function actionView(a: {
  id: string;
  action: string;
  candidate_id: string | null;
  revision_id: string | null;
  content_hash: string | null;
  reviewer_id: string;
  channels: string[];
  scheduled_for: Date | null;
  feedback: string | null;
  feedback_tags: string[];
  created_at: Date;
}): ReviewActionView {
  return {
    id: a.id,
    action: a.action,
    candidateId: a.candidate_id,
    revisionId: a.revision_id,
    contentHash: a.content_hash,
    reviewerId: a.reviewer_id,
    channels: a.channels,
    scheduledFor: a.scheduled_for?.toISOString() ?? null,
    feedback: a.feedback,
    feedbackTags: a.feedback_tags,
    createdAt: a.created_at.toISOString(),
  };
}

/** Who a photograph's credit belongs to: the licence record of the original it was cut from. */
async function photoCredits(db: PrismaClient, renderAssetId: string): Promise<PhotoCredit[]> {
  const sources = await db.render_sources.findMany({
    where: { render_id: renderAssetId },
    orderBy: { slot: 'asc' },
  });
  const credits: PhotoCredit[] = [];
  for (const s of sources) {
    const root = await db.$queryRaw<{ id: string | null }[]>`
      select smb.asset_root(${s.source_id}::uuid)::text as id`;
    const originalId = root[0]?.id ?? null;
    const licence = originalId
      ? await db.media_licenses.findFirst({
          where: { asset_id: originalId },
          orderBy: { created_at: 'desc' },
        })
      : null;
    credits.push({
      slot: s.slot,
      assetId: s.source_id,
      originalAssetId: originalId,
      sourcePageUrl: licence?.source_page_url ?? null,
      photographer: licence?.photographer ?? null,
      licenceType: licence?.licence_type ?? null,
      licenceUrl: licence?.licence_url ?? null,
      attributionRequired: licence?.attribution_required ?? null,
      attributionText: licence?.attribution_text ?? null,
      shareAlike: licence?.share_alike ?? null,
      decision: licence?.decision ?? null,
    });
  }
  return credits;
}

/** Rewrites that were asked for and have not been stored yet. */
export async function pendingRewrites(
  db: PrismaClient | Prisma.TransactionClient,
  opportunityId: string,
): Promise<{ jobId: string; candidateId: string; actionId: string }[]> {
  const jobs = await db.jobs.findMany({
    where: {
      kind: 'revision_from_feedback',
      opportunity_id: opportunityId,
      status: { in: ['queued', 'leased'] },
    },
    select: { id: true, payload: true },
  });
  const asked = jobs.flatMap((j) => {
    const p = j.payload as { candidateId?: string; actionId?: string } | null;
    return p?.candidateId && p.actionId
      ? [{ jobId: j.id, candidateId: p.candidateId, actionId: p.actionId }]
      : [];
  });
  if (asked.length === 0) return [];
  // A rewrite made outside the queue (the command line) leaves its job behind; it is not pending.
  const answered = await db.post_revisions.findMany({
    where: { review_action_id: { in: asked.map((a) => a.actionId) } },
    select: { review_action_id: true },
  });
  const done = new Set(answered.map((r) => r.review_action_id));
  return asked.filter((a) => !done.has(a.actionId));
}

/** Everything a reviewer needs to decide on one opportunity, in one answer. */
export async function opportunityDetail(
  ctx: ReviewContext,
  opportunityId: string,
): Promise<OpportunityDetail> {
  const { db } = ctx;
  const opp = await db.post_opportunities.findUnique({
    where: { id: opportunityId },
    include: { post_types: { select: { id: true, name: true } } },
  });
  if (!opp) throw new ReviewNotFoundError('opportunity');

  const all = await db.post_candidates.findMany({
    where: { opportunity_id: opportunityId },
    orderBy: [{ generation_cycle: 'desc' }, { slot: 'asc' }],
    include: {
      post_revisions: {
        orderBy: { revision_no: 'desc' },
        include: {
          revision_assets: true,
          revision_claims: {
            include: {
              research_claims: {
                include: {
                  research_claim_sources: { include: { source_records: true } },
                },
              },
            },
          },
        },
      },
      candidate_renders: { include: { media_assets: true } },
    },
  });
  const cycle = all[0]?.generation_cycle ?? null;
  const current = all.filter((c) => c.generation_cycle === cycle);

  const beingRewritten = new Set(
    (await pendingRewrites(db, opportunityId)).map((p) => p.candidateId),
  );

  const candidates: CandidateView[] = [];
  for (const c of current) {
    const latest = c.post_revisions[0]!;
    const byId = new Map(c.post_revisions.map((r) => [r.id, r]));
    const first = c.post_revisions[c.post_revisions.length - 1]!;
    const attached = latest.revision_assets.map((a) => a.asset_id);

    // The newest graphic of each shape.
    const newestPerAspect = new Map<string, (typeof c.candidate_renders)[number]>();
    for (const r of [...c.candidate_renders].sort(
      (a, b) => b.created_at.getTime() - a.created_at.getTime(),
    )) {
      if (!newestPerAspect.has(r.aspect)) newestPerAspect.set(r.aspect, r);
    }
    const graphics: GraphicView[] = [];
    for (const r of newestPerAspect.values()) {
      const madeFor = r.revision_id ? byId.get(r.revision_id) : first;
      graphics.push({
        renderId: r.id,
        assetId: r.render_asset_id,
        imageUrl: await ctx.store.signedUrl(
          r.media_assets.bucket,
          r.media_assets.path,
          ctx.signedUrlSeconds,
        ),
        aspect: r.aspect,
        width: r.media_assets.width,
        height: r.media_assets.height,
        templateId: r.template_id,
        templateVersion: r.template_version,
        sha256: r.media_assets.sha256,
        madeForRevisionId: r.revision_id,
        stale: (madeFor?.headline ?? null) !== (latest.headline ?? null),
        photos: await photoCredits(db, r.render_asset_id),
      });
    }
    const usable = graphics.filter((g) => !g.stale);
    const willAttach = attached.length === 0 && usable.length > 0;

    candidates.push({
      id: c.id,
      slot: c.slot,
      angle: c.angle,
      approach: c.approach,
      provider: c.provider,
      model: c.model,
      validation: c.validation,
      revision: {
        id: latest.id,
        revisionNo: latest.revision_no,
        headline: latest.headline,
        caption: latest.caption,
        channelTexts: latest.channel_texts,
        altText: latest.alt_text,
        contentHash: latest.content_hash,
        authorKind: latest.author_kind,
        authorId: latest.author_id,
        changeNote: latest.change_note,
        changeKind: latest.change_kind,
        validation: latest.validation,
        createdAt: latest.created_at.toISOString(),
        attachedAssetIds: attached,
      },
      revisions: [...c.post_revisions].reverse().map((r) => ({
        id: r.id,
        revisionNo: r.revision_no,
        authorKind: r.author_kind,
        authorId: r.author_id,
        changeNote: r.change_note,
        changeKind: r.change_kind,
        changedFields: r.changed_fields,
        changeTags: r.change_tags,
        feedbackActionId: r.review_action_id,
        passedChecks:
          r.validation === null
            ? null
            : Boolean((r.validation as { passed?: boolean } | null)?.passed),
        contentHash: r.content_hash,
        createdAt: r.created_at.toISOString(),
      })),
      claims: latest.revision_claims.map(({ research_claims: k }) => ({
        key: k.claim_key,
        description: k.description,
        value: k.value,
        verification: k.verification,
        confidence: k.confidence === null ? null : Number(k.confidence),
        sources: k.research_claim_sources.map((s) => ({
          sourceId: s.source_records.source_id,
          url: s.source_records.url,
          retrievedAt: s.source_records.retrieved_at.toISOString(),
        })),
      })),
      graphics,
      willAttachGraphic: willAttach,
      revisionPending: beingRewritten.has(c.id),
      previews: channelPreviews(ctx.channels, {
        caption: latest.caption,
        channelTexts: (latest.channel_texts ?? {}) as Record<string, unknown>,
        altText: latest.alt_text,
        hasGraphic: attached.length > 0 || usable.length > 0,
      }),
    });
  }

  const cycles = new Map<number, string[]>();
  for (const c of all) {
    if (c.generation_cycle === cycle) continue;
    cycles.set(c.generation_cycle, [...(cycles.get(c.generation_cycle) ?? []), c.id]);
  }

  const actions = await db.review_actions.findMany({
    where: { opportunity_id: opportunityId },
    orderBy: { created_at: 'asc' },
  });
  const events = await db.opportunity_events.findMany({
    where: { opportunity_id: opportunityId },
    orderBy: { seq: 'asc' },
  });
  const pubs = await db.publications.findMany({
    where: { review_actions: { opportunity_id: opportunityId } },
    orderBy: { created_at: 'asc' },
  });

  const inForce = ['approved', 'scheduled', 'publishing', 'published', 'partially_published'];
  const lastApprove = [...actions].reverse().find((a) => a.action === 'approve');

  return {
    id: opp.id,
    postType: opp.post_types,
    status: opp.status,
    priority: opp.priority,
    phase: opp.phase,
    scheduledFor: opp.scheduled_for?.toISOString() ?? null,
    notAfter: opp.not_after?.toISOString() ?? null,
    generationCycle: cycle,
    candidates,
    earlierCycles: [...cycles.entries()].map(([n, ids]) => ({ cycle: n, candidateIds: ids })),
    approval: lastApprove && inForce.includes(opp.status) ? actionView(lastApprove) : null,
    history: actions.map(actionView),
    statusHistory: events.map((e) => ({
      from: e.from_status,
      to: e.to_status,
      actor: e.actor,
      reason: e.reason,
      at: e.created_at.toISOString(),
    })),
    publications: pubs.map((p) => ({
      id: p.id,
      channel: p.channel,
      mode: p.mode,
      status: p.status,
      scheduledFor: p.scheduled_for?.toISOString() ?? null,
      url: p.url,
      publishedAt: p.published_at?.toISOString() ?? null,
      lastError: p.last_error,
    })),
  };
}
