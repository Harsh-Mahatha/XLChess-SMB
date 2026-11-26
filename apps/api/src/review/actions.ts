import type { Prisma, PrismaClient } from '@prisma/client';
import {
  WRONG_ANGLE_TAG,
  changedFields,
  channelLength,
  classifyChange,
  normaliseTags,
  type ChangeKind,
  type ChannelsRegistry,
  type PublishMode,
} from '@smb/shared';
import { AssetIntegrityError, ensureAssetsIntact } from '../assets/index.js';
import { revisionHash } from '../generation/service.js';
import { AssetLicenceError, assertAssetsLicensed } from '../images/guard.js';
import type { ObjectStore } from '../storage/index.js';
import { StoryNotReadyError, reselectStory } from '../story/service.js';
import { channelPreviews } from './previews.js';
import { pendingRewrites, pickGraphic } from './read.js';

/** A refusal a reviewer can act on. The route turns it into the API's error shape. */
export class ReviewError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 422,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ReviewError';
  }
}

export interface ReviewActor {
  userId: string;
}

export interface ActionContext {
  db: PrismaClient;
  store: ObjectStore;
  channels: ChannelsRegistry;
  now?: () => Date;
  publishMode?: PublishMode;
  /**
   * Makes a new graphic for a revision whose headline changed (the workflow's `renderForRevision`, module 1.17).
   * Without it, an edit that changes the graphic's words leaves the graphic marked stale and approval
   * waits for a new one.
   */
  rerender?: (candidateId: string, revisionId: string) => Promise<void>;
}

const now = (ctx: ActionContext): Date => (ctx.now ? ctx.now() : new Date());

/** The states each action can start from, and where it leads. The only place review moves an opportunity. */
export const REVIEW_TRANSITIONS = {
  approve: { from: ['awaiting_review'], to: 'approved' },
  reject: { from: ['awaiting_review', 'deferred'], to: 'rejected' },
  defer: { from: ['awaiting_review'], to: 'deferred' },
  regenerate: { from: ['awaiting_review', 'deferred'], to: 'generating' },
  request_research: { from: ['awaiting_review', 'deferred'], to: 'researching' },
  reopen: { from: ['deferred'], to: 'awaiting_review' },
} as const;
export type ReviewTransition = keyof typeof REVIEW_TRANSITIONS;

/** States in which the text can still be edited. An approval in force is withdrawn by the edit. */
const EDITABLE = ['awaiting_review', 'deferred', 'approved', 'scheduled'];
const APPROVAL_IN_FORCE = ['approved', 'scheduled'];

const MAX_FEEDBACK = 4000;

type Tx = Prisma.TransactionClient;
type RenderWithAsset = Prisma.candidate_rendersGetPayload<{ include: { media_assets: true } }>;
type AssetRow = RenderWithAsset['media_assets'];

async function lockOpportunity(tx: Tx, opportunityId: string) {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    select id::text from smb.post_opportunities where id = ${opportunityId}::uuid for update`;
  if (locked.length === 0) throw new ReviewError(404, 'not_found', 'Opportunity not found');
  return tx.post_opportunities.findUniqueOrThrow({ where: { id: opportunityId } });
}

/** Tells the status-history trigger who moved the opportunity, and why. */
async function actingAs(tx: Tx, actor: ReviewActor, reason: string): Promise<void> {
  await tx.$executeRaw`select set_config('smb.actor', ${'user:' + actor.userId}, true), set_config('smb.reason', ${reason}, true), set_config('smb.job_id', '', true)`;
}

function scopedKey(actor: ReviewActor, key: string | undefined): string | undefined {
  return key ? `${actor.userId}:${key}` : undefined;
}

function assertStatus(status: string, allowed: readonly string[], what: string): void {
  if (!allowed.includes(status)) {
    throw new ReviewError(
      409,
      'wrong_status',
      `${what} is not possible while the opportunity is ${status}`,
      { status, allowed },
    );
  }
}

function templateOf(
  rev: { template_version: string | null },
  candidate: { visual_plan: unknown },
): string {
  return (
    rev.template_version ?? (candidate.visual_plan as { template?: string } | null)?.template ?? ''
  );
}

function stringMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) if (typeof v === 'string') out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Approve
// ---------------------------------------------------------------------------------------------------------

export interface ApproveInput {
  revisionId: string;
  /** The hash of the revision as the reviewer saw it. Approval is refused if the revision has moved on. */
  contentHash: string;
  channels: string[];
  scheduledFor?: Date;
  /** Needed when the candidate failed its automatic checks and no person has edited it since. */
  acknowledgeFailedChecks?: boolean;
  idempotencyKey?: string;
}

export interface ApproveResult {
  approvalId: string;
  opportunityId: string;
  candidateId: string;
  /** The revision the approval binds to: the one reviewed, or the one made to include the graphic. */
  revisionId: string;
  contentHash: string;
  channels: string[];
  scheduledFor: string | null;
  graphicAssetId: string | null;
  /** True when approving made a new revision to carry the graphic into the hash. */
  boundRevisionCreated: boolean;
  replayed: boolean;
  publications?: Array<{
    id: string;
    channel: string;
    mode: string;
    scheduledFor: string | null;
  }>;
}

async function approvedResult(
  tx: Tx | PrismaClient,
  action: {
    id: string;
    opportunity_id: string;
    candidate_id: string | null;
    revision_id: string | null;
    content_hash: string | null;
    channels: string[];
    scheduled_for: Date | null;
  },
  replayed: boolean,
  created = false,
  createdPubs?: Array<{ id: string; channel: string; mode: string; scheduledFor: string | null }>,
): Promise<ApproveResult> {
  const graphic = await tx.revision_assets.findFirst({
    where: { revision_id: action.revision_id!, role: 'graphic' },
  });
  let publications = createdPubs;
  if (!publications) {
    const pubRows = await tx.publications.findMany({
      where: { approval_id: action.id },
      orderBy: { created_at: 'asc' },
    });
    publications = pubRows.map((p) => ({
      id: p.id,
      channel: p.channel,
      mode: p.mode,
      scheduledFor: p.scheduled_for?.toISOString() ?? null,
    }));
  }
  return {
    approvalId: action.id,
    opportunityId: action.opportunity_id,
    candidateId: action.candidate_id!,
    revisionId: action.revision_id!,
    contentHash: action.content_hash!,
    channels: action.channels,
    scheduledFor: action.scheduled_for?.toISOString() ?? null,
    graphicAssetId: graphic?.asset_id ?? null,
    boundRevisionCreated: created,
    replayed,
    publications,
  };
}

/**
 * Approves the exact revision a reviewer read.
 *
 * The approval is recorded against one revision and its hash. When the revision has no graphic yet, a new
 * revision is made in the same transaction that carries the candidate's graphic (its file hash and template
 * version go into the hash) and the approval binds to that one. Nothing can be approved whose text, graphic or
 * photographs changed after the reviewer saw it: the hash they send must match, the revision must be the newest,
 * and the database refuses an approval whose hash differs from its revision's.
 */
export async function approveRevision(
  ctx: ActionContext,
  actor: ReviewActor,
  input: ApproveInput,
): Promise<ApproveResult> {
  const { db } = ctx;
  const key = scopedKey(actor, input.idempotencyKey);
  if (key) {
    const prior = await db.review_actions.findUnique({ where: { idempotency_key: key } });
    if (prior) {
      if (prior.action !== 'approve' || prior.opportunity_id === null) {
        throw new ReviewError(
          409,
          'idempotency_conflict',
          'That key was used for a different action',
        );
      }
      return approvedResult(db, prior, true);
    }
  }

  const rev = await db.post_revisions.findUnique({
    where: { id: input.revisionId },
    include: { post_candidates: true, revision_assets: { include: { media_assets: true } } },
  });
  if (!rev) throw new ReviewError(404, 'not_found', 'Revision not found');
  const candidate = rev.post_candidates;

  // 1. Is this still the thing the reviewer looked at?
  if (rev.content_hash !== input.contentHash) {
    throw new ReviewError(
      409,
      'stale_hash',
      'This revision is not the one you reviewed. Reload and review it again.',
    );
  }
  const newest = await db.post_revisions.findFirst({
    where: { candidate_id: candidate.id },
    orderBy: { revision_no: 'desc' },
  });
  if (newest?.id !== rev.id) {
    throw new ReviewError(409, 'revision_superseded', 'A newer revision of this candidate exists', {
      newestRevisionId: newest?.id,
    });
  }
  const cycle = await db.post_candidates.aggregate({
    where: { opportunity_id: candidate.opportunity_id },
    _max: { generation_cycle: true },
  });
  if (cycle._max.generation_cycle !== candidate.generation_cycle) {
    throw new ReviewError(
      409,
      'candidate_superseded',
      'This candidate was replaced by a regeneration',
    );
  }

  // 2. Channels, schedule and the candidate's own checks.
  const channels = [...new Set(input.channels)];
  if (channels.length === 0)
    throw new ReviewError(422, 'no_channels', 'Choose at least one channel');
  for (const c of channels) {
    const spec = ctx.channels.channels.find((s) => s.id === c);
    if (!spec) throw new ReviewError(422, 'unknown_channel', `Unknown channel ${c}`);
    if (!spec.enabled)
      throw new ReviewError(422, 'channel_disabled', `${spec.name} is switched off`);
  }
  // A rewrite by the model carries its own checks; a first revision carries the candidate's.
  const validation = (
    rev.author_kind === 'ai' && rev.validation ? rev.validation : candidate.validation
  ) as { passed?: boolean } | null;
  if (validation?.passed === false && rev.author_kind === 'ai' && !input.acknowledgeFailedChecks) {
    throw new ReviewError(
      422,
      'failed_checks',
      'This candidate failed automatic checks. Edit it, or confirm you have read the failures.',
      { validation },
    );
  }

  // 3. The graphic: use the one already attached, or find the candidate's own.
  let graphicAsset: AssetRow | undefined = rev.revision_assets.find(
    (a) => a.role === 'graphic',
  )?.media_assets;
  let render: RenderWithAsset | undefined;
  if (!graphicAsset) {
    const renders = await db.candidate_renders.findMany({
      where: { candidate_id: candidate.id },
      include: { media_assets: true },
    });
    if (renders.length > 0) {
      const revisions = await db.post_revisions.findMany({ where: { candidate_id: candidate.id } });
      const byId = new Map(revisions.map((r) => [r.id, r]));
      const first = revisions.reduce((a, b) => (a.revision_no < b.revision_no ? a : b));
      const fresh = renders.filter((r) => {
        const madeFor = r.revision_id ? byId.get(r.revision_id) : first;
        return (madeFor?.headline ?? null) === (rev.headline ?? null);
      });
      render = pickGraphic(fresh);
      if (!render) {
        throw new ReviewError(
          409,
          'graphic_stale',
          'The graphic was made for a different headline. Make a new graphic before approving.',
        );
      }
      graphicAsset = render.media_assets;
    }
  }
  const hasGraphic = Boolean(graphicAsset);
  const problems = channelPreviews(ctx.channels, {
    caption: rev.caption,
    channelTexts: stringMap(rev.channel_texts),
    altText: rev.alt_text,
    hasGraphic,
  }).filter((p) => channels.includes(p.channel) && p.problems.length > 0);
  if (problems.length > 0) {
    throw new ReviewError(
      422,
      'channel_rules',
      'The post does not meet a channel’s rules',
      problems,
    );
  }

  // 4. Licence and photograph integrity, re-checked against the files as they are right now.
  if (graphicAsset) {
    try {
      await assertAssetsLicensed(db, [graphicAsset.id]);
      await ensureAssetsIntact({ db, store: ctx.store }, [graphicAsset.id]);
    } catch (err) {
      if (err instanceof AssetLicenceError || err instanceof AssetIntegrityError) {
        throw new ReviewError(409, 'asset_not_cleared', err.message, {
          assetId: err.assetId,
          reason: err.reason,
        });
      }
      throw err;
    }
  }

  // 5. Write everything together or nothing.
  return db.$transaction(
    async (tx) => {
      const opp = await lockOpportunity(tx, candidate.opportunity_id);
      if (key) {
        const prior = await tx.review_actions.findUnique({ where: { idempotency_key: key } });
        if (prior) return approvedResult(tx, prior, true);
      }
      assertStatus(opp.status, REVIEW_TRANSITIONS.approve.from, 'Approval');
      const at = now(ctx);
      if (opp.not_after && opp.not_after < at) {
        throw new ReviewError(
          409,
          'opportunity_expired',
          'This opportunity is past its not-after time',
        );
      }
      if (input.scheduledFor && input.scheduledFor < at) {
        throw new ReviewError(422, 'schedule_in_past', 'The scheduled time has already passed');
      }
      if (input.scheduledFor && opp.not_after && input.scheduledFor > opp.not_after) {
        throw new ReviewError(
          422,
          'schedule_after_expiry',
          'The scheduled time is after this opportunity expires',
        );
      }
      // The revision must still be the newest now that nothing else can act on this opportunity.
      const check = await tx.post_revisions.findFirst({
        where: { candidate_id: candidate.id },
        orderBy: { revision_no: 'desc' },
      });
      if (check?.id !== rev.id || rev.content_hash !== input.contentHash) {
        throw new ReviewError(
          409,
          'revision_superseded',
          'A newer revision of this candidate exists',
        );
      }

      let bound = rev;
      let created = false;
      if (render && graphicAsset) {
        const channelTexts = stringMap(rev.channel_texts);
        const hash = revisionHash({
          headline: rev.headline ?? '',
          caption: rev.caption,
          channelTexts,
          template: render.template_version,
          assetHashes: [graphicAsset.sha256],
        });
        const claims = await tx.revision_claims.findMany({ where: { revision_id: rev.id } });
        bound = {
          ...(await tx.post_revisions.create({
            data: {
              candidate_id: candidate.id,
              revision_no: rev.revision_no + 1,
              parent_revision_id: rev.id,
              caption: rev.caption,
              channel_texts: rev.channel_texts as Prisma.InputJsonValue,
              headline: rev.headline,
              alt_text: rev.alt_text,
              template_version: render.template_version,
              content_hash: hash,
              author_kind: 'human',
              author_id: actor.userId,
              change_note:
                'Approval: the graphic was added to the revision so the approval covers it',
              change_kind: 'binding',
              revision_claims: { create: claims.map((c) => ({ claim_id: c.claim_id })) },
              revision_assets: { create: [{ asset_id: graphicAsset.id, role: 'graphic' }] },
            },
          })),
          post_candidates: candidate,
          revision_assets: [],
        };
        created = true;
      }

      await actingAs(tx, actor, 'approved');
      const action = await tx.review_actions.create({
        data: {
          opportunity_id: opp.id,
          candidate_id: candidate.id,
          revision_id: bound.id,
          action: 'approve',
          content_hash: bound.content_hash,
          reviewer_id: actor.userId,
          channels: channels as never,
          scheduled_for: input.scheduledFor ?? null,
          idempotency_key: key ?? null,
        },
      });
      await tx.post_opportunities.update({
        where: { id: opp.id },
        data: {
          status: REVIEW_TRANSITIONS.approve.to,
          ...(input.scheduledFor ? { scheduled_for: input.scheduledFor } : {}),
        },
      });
      const createdPubs: Array<{
        id: string;
        channel: string;
        mode: string;
        scheduledFor: string | null;
      }> = [];
      for (const c of channels) {
        const pub = await tx.publications.create({
          data: {
            approval_id: action.id,
            revision_id: bound.id,
            channel: c as never,
            mode: ctx.publishMode ?? 'dry_run',
            status: 'pending',
            content_hash: bound.content_hash,
            idempotency_key: `pub:${action.id}:${c}`,
            scheduled_for: input.scheduledFor ?? null,
          },
        });
        createdPubs.push({
          id: pub.id,
          channel: pub.channel,
          mode: pub.mode,
          scheduledFor: pub.scheduled_for?.toISOString() ?? null,
        });
      }
      await tx.audit_log.create({
        data: {
          actor: actor.userId,
          action: 'review.approve',
          target_type: 'revision',
          target_id: bound.id,
          details: {
            opportunityId: opp.id,
            candidateId: candidate.id,
            reviewedRevisionId: rev.id,
            reviewedHash: rev.content_hash,
            approvedHash: bound.content_hash,
            channels,
            graphicAssetId: graphicAsset?.id ?? null,
            template: render?.template_version ?? null,
            acknowledgedFailedChecks: Boolean(input.acknowledgeFailedChecks),
            publications: createdPubs.map((p) => p.id),
          },
        },
      });
      return approvedResult(tx, action, false, created, createdPubs);
    },
    { timeout: 20_000 },
  );
}

// ---------------------------------------------------------------------------------------------------------
// Edit
// ---------------------------------------------------------------------------------------------------------

export interface EditInput {
  /** The revision the reviewer started from. Refused if someone else has edited since. */
  baseRevisionId: string;
  headline?: string;
  caption?: string;
  channelTexts?: Record<string, string>;
  altText?: string;
  changeNote?: string;
  /** Whether this corrects something that was wrong or improves the writing. Worked out from the tags if left out. */
  changeKind?: ChangeKind;
  /** What was wrong, from the feedback vocabulary (free tags are accepted too). */
  changeTags?: string[];
}

export interface EditResult {
  revisionId: string;
  revisionNo: number;
  contentHash: string;
  /** True when the edit changed the words on the graphic, so a new graphic is needed before approval. */
  graphicStale: boolean;
  /** True when a graphic was made again for this edit. */
  graphicRegenerated: boolean;
  /** True when an approval was in force and this edit withdrew it. */
  approvalWithdrawn: boolean;
  /** Which parts changed: `headline`, `caption`, `altText`, `channel:<id>`. */
  changedFields: string[];
  /** `factual`, `creative` or `mixed`; null when the reviewer did not say and no tag told us. */
  changeKind: ChangeKind | null;
}

/** Saves a person's change as a new immutable revision. It never alters an earlier one. */
export async function editCandidate(
  ctx: ActionContext,
  actor: ReviewActor,
  candidateId: string,
  input: EditInput,
): Promise<EditResult> {
  const { db } = ctx;
  const candidate = await db.post_candidates.findUnique({ where: { id: candidateId } });
  if (!candidate) throw new ReviewError(404, 'not_found', 'Candidate not found');
  const changeTags = normaliseTags(input.changeTags);
  if (changeTags.length > 10 || changeTags.some((t) => t.length > 40)) {
    throw new ReviewError(422, 'bad_tags', 'Use at most 10 tags of up to 40 characters');
  }
  const changeKind = classifyChange(input.changeKind, changeTags);

  const result = await db.$transaction(
    async (tx) => {
      const opp = await lockOpportunity(tx, candidate.opportunity_id);
      assertStatus(opp.status, EDITABLE, 'Editing');
      const latestCycle = await tx.post_candidates.aggregate({
        where: { opportunity_id: opp.id },
        _max: { generation_cycle: true },
      });
      if (latestCycle._max.generation_cycle !== candidate.generation_cycle) {
        throw new ReviewError(
          409,
          'candidate_superseded',
          'This candidate was replaced by a regeneration',
        );
      }
      const base = await tx.post_revisions.findFirst({
        where: { candidate_id: candidateId },
        orderBy: { revision_no: 'desc' },
        include: { revision_assets: { include: { media_assets: true } }, revision_claims: true },
      });
      if (!base) throw new ReviewError(404, 'not_found', 'Candidate has no revision');
      if (base.id !== input.baseRevisionId) {
        throw new ReviewError(
          409,
          'revision_superseded',
          'Someone has edited this candidate since you opened it',
          {
            newestRevisionId: base.id,
          },
        );
      }

      const headline = input.headline ?? base.headline ?? '';
      const caption = input.caption ?? base.caption;
      const altText = input.altText ?? base.alt_text;
      const channelTexts = { ...stringMap(base.channel_texts), ...(input.channelTexts ?? {}) };
      for (const [id, text] of Object.entries(input.channelTexts ?? {})) {
        if (!ctx.channels.channels.some((c) => c.id === id)) {
          throw new ReviewError(422, 'unknown_channel', `Unknown channel ${id}`);
        }
        if (text.trim() === '') delete channelTexts[id]; // an empty text means "use the caption"
      }
      if (caption.trim() === '')
        throw new ReviewError(422, 'empty_caption', 'The caption cannot be empty');

      const unchanged =
        headline === (base.headline ?? '') &&
        caption === base.caption &&
        (altText ?? null) === (base.alt_text ?? null) &&
        JSON.stringify(sortKeys(channelTexts)) ===
          JSON.stringify(sortKeys(stringMap(base.channel_texts)));
      if (unchanged) throw new ReviewError(422, 'no_change', 'Nothing was changed');
      const changed = changedFields(
        {
          headline: base.headline,
          caption: base.caption,
          channelTexts: stringMap(base.channel_texts),
          altText: base.alt_text,
        },
        { headline, caption, channelTexts, altText: altText ?? null },
      );

      // Text that no longer fits a channel is refused now, not discovered at approval.
      const tooLong = ctx.channels.channels
        .map((spec) => {
          const text = channelTexts[spec.id] ?? caption;
          return { spec, length: channelLength(spec.id, text) };
        })
        .filter((c) => c.spec.enabled && c.length > c.spec.maxTextLength)
        .map((c) => `${c.spec.name}: ${c.length} characters, limit ${c.spec.maxTextLength}`);
      if (tooLong.length > 0) {
        throw new ReviewError(
          422,
          'channel_rules',
          'The edited text does not fit a channel',
          tooLong,
        );
      }

      // The graphic can stay only while the words on it are unchanged.
      const headlineChanged = headline !== (base.headline ?? '');
      const keepAssets = headlineChanged ? [] : base.revision_assets;
      // Without a graphic the hash uses the planned template's id, as the first revision's does.
      const template =
        keepAssets.length > 0
          ? templateOf(base, candidate)
          : ((candidate.visual_plan as { template?: string } | null)?.template ?? '');
      const hash = revisionHash({
        headline,
        caption,
        channelTexts,
        template,
        assetHashes: keepAssets.map((a) => a.media_assets.sha256),
      });

      const created = await tx.post_revisions.create({
        data: {
          candidate_id: candidateId,
          revision_no: base.revision_no + 1,
          parent_revision_id: base.id,
          caption,
          channel_texts: channelTexts as Prisma.InputJsonValue,
          headline,
          alt_text: altText,
          template_version: keepAssets.length > 0 ? base.template_version : null,
          content_hash: hash,
          author_kind: 'human',
          author_id: actor.userId,
          change_note: input.changeNote ?? null,
          change_kind: changeKind,
          changed_fields: changed,
          change_tags: changeTags,
          revision_claims: { create: base.revision_claims.map((c) => ({ claim_id: c.claim_id })) },
          revision_assets: {
            create: keepAssets.map((a) => ({ asset_id: a.asset_id, role: a.role })),
          },
        },
      });

      // An approval covers one revision. A different revision means the approval no longer stands.
      let withdrawn = false;
      if (APPROVAL_IN_FORCE.includes(opp.status)) {
        withdrawn = true;
        await actingAs(tx, actor, 'approval withdrawn: the content was edited');
        await tx.post_opportunities.update({
          where: { id: opp.id },
          data: { status: 'awaiting_review' },
        });
        const approval = await tx.review_actions.findFirst({
          where: { opportunity_id: opp.id, action: 'approve' },
          orderBy: { created_at: 'desc' },
        });
        if (approval) {
          await tx.publications.updateMany({
            where: { approval_id: approval.id, status: 'pending' },
            data: { status: 'cancelled', last_error: 'approval withdrawn: the content was edited' },
          });
        }
        await tx.review_actions.create({
          data: {
            opportunity_id: opp.id,
            candidate_id: candidateId,
            revision_id: created.id,
            action: 'comment',
            content_hash: created.content_hash,
            reviewer_id: actor.userId,
            feedback: 'The approval was withdrawn because the content was edited',
            feedback_tags: ['approval_withdrawn'],
          },
        });
      }
      await tx.audit_log.create({
        data: {
          actor: actor.userId,
          action: 'review.edit',
          target_type: 'revision',
          target_id: created.id,
          details: {
            opportunityId: opp.id,
            candidateId,
            baseRevisionId: base.id,
            headlineChanged,
            approvalWithdrawn: withdrawn,
            changedFields: changed,
            changeKind,
            changeTags,
          },
        },
      });

      const hadGraphic =
        base.revision_assets.length > 0 ||
        (await tx.candidate_renders.count({ where: { candidate_id: candidateId } })) > 0;
      return {
        revisionId: created.id,
        revisionNo: created.revision_no,
        contentHash: created.content_hash,
        graphicStale: headlineChanged && hadGraphic,
        graphicRegenerated: false,
        approvalWithdrawn: withdrawn,
        changedFields: changed,
        changeKind,
      };
    },
    { timeout: 20_000 },
  );

  if (result.graphicStale && ctx.rerender) {
    try {
      await ctx.rerender(candidateId, result.revisionId);
      result.graphicStale = false;
      result.graphicRegenerated = true;
    } catch {
      // The edit is saved either way; the graphic stays marked stale until a new one is made.
    }
  }
  return result;
}

function sortKeys(o: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
}

// ---------------------------------------------------------------------------------------------------------
// Reject, defer, regenerate, request research, reopen
// ---------------------------------------------------------------------------------------------------------

export interface TransitionInput {
  feedback?: string;
  feedbackTags?: string[];
  /** For defer: when to look at it again. Recorded only; nothing is published by it. */
  deferUntil?: Date;
  candidateId?: string;
  revisionId?: string;
  idempotencyKey?: string;
}

export interface TransitionResult {
  actionId: string;
  opportunityId: string;
  status: string;
  /** For regenerate: the job that will write the new candidates. */
  jobId: string | null;
  /** For a regenerate tagged `wrong_angle`: the story the new candidates will tell instead. */
  newAngleId: string | null;
  replayed: boolean;
}

const ACTION_TYPE = {
  reject: 'reject',
  defer: 'defer',
  regenerate: 'regenerate',
  request_research: 'request_research',
  reopen: 'comment',
} as const;

/**
 * Reject, defer, regenerate, request research and reopen. Each is one guarded move recorded as a review action
 * and an audit entry. Regenerate also queues the job that writes a new set of three candidates, carrying the
 * reviewer's words so the model can use them.
 */
export async function transitionOpportunity(
  ctx: ActionContext,
  actor: ReviewActor,
  opportunityId: string,
  kind: ReviewTransition,
  input: TransitionInput = {},
): Promise<TransitionResult> {
  if (kind === 'approve') throw new Error('approve has its own function');
  const tags = normaliseTags(input.feedbackTags);
  const feedback = input.feedback?.trim() || null;
  if (feedback && feedback.length > MAX_FEEDBACK) {
    throw new ReviewError(
      422,
      'feedback_too_long',
      `Feedback is limited to ${MAX_FEEDBACK} characters`,
    );
  }
  if (tags.length > 10 || tags.some((t) => t.length > 40)) {
    throw new ReviewError(422, 'bad_tags', 'Use at most 10 tags of up to 40 characters');
  }
  if (kind !== 'reopen' && !feedback && tags.length === 0) {
    throw new ReviewError(422, 'feedback_required', 'Say why: add feedback or at least one tag');
  }
  const rule = REVIEW_TRANSITIONS[kind];
  const key = scopedKey(actor, input.idempotencyKey);

  return ctx.db.$transaction(
    async (tx) => {
      const opp = await lockOpportunity(tx, opportunityId);
      if (key) {
        const prior = await tx.review_actions.findUnique({ where: { idempotency_key: key } });
        if (prior) {
          if (prior.opportunity_id !== opportunityId || prior.action !== ACTION_TYPE[kind]) {
            throw new ReviewError(
              409,
              'idempotency_conflict',
              'That key was used for a different action',
            );
          }
          return {
            actionId: prior.id,
            opportunityId,
            status: opp.status,
            jobId: null,
            newAngleId: null,
            replayed: true,
          };
        }
      }
      assertStatus(opp.status, rule.from, kind.replace('_', ' '));

      let candidateId = input.candidateId ?? null;
      if (candidateId) {
        const c = await tx.post_candidates.findUnique({ where: { id: candidateId } });
        if (!c || c.opportunity_id !== opportunityId) {
          throw new ReviewError(404, 'not_found', 'Candidate not found on this opportunity');
        }
      }
      let revisionId = input.revisionId ?? null;
      let contentHash: string | null = null;
      if (revisionId) {
        const r = await tx.post_revisions.findUnique({
          where: { id: revisionId },
          include: { post_candidates: true },
        });
        if (!r || r.post_candidates.opportunity_id !== opportunityId) {
          throw new ReviewError(404, 'not_found', 'Revision not found on this opportunity');
        }
        candidateId ??= r.candidate_id;
        contentHash = r.content_hash;
      } else {
        revisionId = null;
      }

      await actingAs(
        tx,
        actor,
        kind === 'reopen' ? 'reopened for review' : (feedback ?? tags.join(', ')),
      );
      const action = await tx.review_actions.create({
        data: {
          opportunity_id: opportunityId,
          candidate_id: candidateId,
          revision_id: revisionId,
          action: ACTION_TYPE[kind],
          content_hash: contentHash,
          reviewer_id: actor.userId,
          scheduled_for: kind === 'defer' ? (input.deferUntil ?? null) : null,
          feedback: feedback ?? (kind === 'reopen' ? 'Reopened for review' : null),
          feedback_tags: kind === 'reopen' ? [...tags, 'reopen'] : tags,
          idempotency_key: key ?? null,
        },
      });
      await tx.post_opportunities.update({
        where: { id: opportunityId },
        data: { status: rule.to },
      });

      // "Tell a different story": pick another angle now, so a request that cannot be met is refused, not queued.
      let newAngleId: string | null = null;
      if (kind === 'regenerate' && tags.includes(WRONG_ANGLE_TAG)) {
        const noOther = (details: unknown) =>
          new ReviewError(
            422,
            'no_other_angle',
            'The research supports no other story for this post. Regenerate without the wrong_angle tag, or reject the post.',
            details,
          );
        try {
          const again = await reselectStory(tx, opportunityId, {
            reviewActionId: action.id,
            now: now(ctx),
          });
          if (!again.selection?.angleId) {
            throw noOther({ excludedAngles: again.excludedAngles, reason: again.reason });
          }
          newAngleId = again.selection.angleId;
        } catch (err) {
          if (err instanceof StoryNotReadyError) throw noOther({ reason: err.message });
          throw err;
        }
      }

      let jobId: string | null = null;
      if (kind === 'regenerate') {
        const job = await tx.jobs.create({
          data: {
            lane: 'gpu',
            kind: 'candidates_generate',
            opportunity_id: opportunityId,
            payload: {
              opportunityId,
              newCycle: true,
              feedback: { actionId: action.id, text: feedback, tags },
              ...(newAngleId && { angleId: newAngleId }),
            } as Prisma.InputJsonValue,
            idempotency_key: `regenerate:${action.id}`,
            not_after: opp.not_after,
          },
        });
        jobId = job.id;
      }
      await tx.audit_log.create({
        data: {
          actor: actor.userId,
          action: `review.${kind}`,
          target_type: 'opportunity',
          target_id: opportunityId,
          details: {
            from: opp.status,
            to: rule.to,
            actionId: action.id,
            tags,
            hasFeedback: Boolean(feedback),
            jobId,
            newAngleId,
          },
        },
      });
      return {
        actionId: action.id,
        opportunityId,
        status: rule.to,
        jobId,
        newAngleId,
        replayed: false,
      };
    },
    { timeout: 20_000 },
  );
}

// ---------------------------------------------------------------------------------------------------------
// Ask the model to rewrite one candidate (module 1.12)
// ---------------------------------------------------------------------------------------------------------

/** States in which a candidate can be sent back to the model for a rewrite. */
const REVISABLE = ['awaiting_review', 'deferred'];

export interface ReviseRequestInput {
  /** The revision the reviewer is looking at. Refused if the candidate has moved on. */
  baseRevisionId: string;
  feedback?: string;
  feedbackTags?: string[];
  idempotencyKey?: string;
}

export interface ReviseRequestResult {
  actionId: string;
  opportunityId: string;
  candidateId: string;
  baseRevisionId: string;
  /** The job that will write the new revision. */
  jobId: string | null;
  replayed: boolean;
}

/**
 * Records a reviewer's request to have one candidate rewritten from their feedback, and queues the job that
 * does it. The opportunity stays where it is: the other candidates can still be approved or edited, and if
 * this candidate is edited before the model answers, the answer is dropped as out of date.
 */
export async function requestRevision(
  ctx: Pick<ActionContext, 'db' | 'now'>,
  actor: ReviewActor,
  candidateId: string,
  input: ReviseRequestInput,
): Promise<ReviseRequestResult> {
  const tags = normaliseTags(input.feedbackTags);
  const feedback = input.feedback?.trim() || null;
  if (feedback && feedback.length > MAX_FEEDBACK) {
    throw new ReviewError(
      422,
      'feedback_too_long',
      `Feedback is limited to ${MAX_FEEDBACK} characters`,
    );
  }
  if (tags.length > 10 || tags.some((t) => t.length > 40)) {
    throw new ReviewError(422, 'bad_tags', 'Use at most 10 tags of up to 40 characters');
  }
  if (!feedback && tags.length === 0) {
    throw new ReviewError(
      422,
      'feedback_required',
      'Say what to change: add feedback or at least one tag',
    );
  }
  const candidate = await ctx.db.post_candidates.findUnique({ where: { id: candidateId } });
  if (!candidate) throw new ReviewError(404, 'not_found', 'Candidate not found');
  const key = scopedKey(actor, input.idempotencyKey);

  return ctx.db.$transaction(
    async (tx) => {
      const opp = await lockOpportunity(tx, candidate.opportunity_id);
      if (key) {
        const prior = await tx.review_actions.findUnique({ where: { idempotency_key: key } });
        if (prior) {
          if (prior.action !== 'revise' || prior.candidate_id !== candidateId) {
            throw new ReviewError(
              409,
              'idempotency_conflict',
              'That key was used for a different action',
            );
          }
          return {
            actionId: prior.id,
            opportunityId: opp.id,
            candidateId,
            baseRevisionId: prior.revision_id!,
            jobId: null,
            replayed: true,
          };
        }
      }
      assertStatus(opp.status, REVISABLE, 'A rewrite');
      const latestCycle = await tx.post_candidates.aggregate({
        where: { opportunity_id: opp.id },
        _max: { generation_cycle: true },
      });
      if (latestCycle._max.generation_cycle !== candidate.generation_cycle) {
        throw new ReviewError(
          409,
          'candidate_superseded',
          'This candidate was replaced by a regeneration',
        );
      }
      const base = await tx.post_revisions.findFirst({
        where: { candidate_id: candidateId },
        orderBy: { revision_no: 'desc' },
      });
      if (!base) throw new ReviewError(404, 'not_found', 'Candidate has no revision');
      if (base.id !== input.baseRevisionId) {
        throw new ReviewError(
          409,
          'revision_superseded',
          'This candidate has changed since you opened it',
          { newestRevisionId: base.id },
        );
      }
      const waiting = (await pendingRewrites(tx, opp.id)).find(
        (p) => p.candidateId === candidateId,
      );
      if (waiting) {
        throw new ReviewError(
          409,
          'revision_pending',
          'A rewrite of this candidate is already on its way',
          { jobId: waiting.jobId },
        );
      }

      const action = await tx.review_actions.create({
        data: {
          opportunity_id: opp.id,
          candidate_id: candidateId,
          revision_id: base.id,
          action: 'revise',
          content_hash: base.content_hash,
          reviewer_id: actor.userId,
          feedback,
          feedback_tags: tags,
          idempotency_key: key ?? null,
        },
      });
      const job = await tx.jobs.create({
        data: {
          lane: 'gpu',
          kind: 'revision_from_feedback',
          opportunity_id: opp.id,
          payload: {
            opportunityId: opp.id,
            candidateId,
            baseRevisionId: base.id,
            actionId: action.id,
          } as Prisma.InputJsonValue,
          idempotency_key: `revise:${action.id}`,
          job_scope: action.id,
          not_after: opp.not_after,
        },
      });
      await tx.audit_log.create({
        data: {
          actor: actor.userId,
          action: 'review.revise',
          target_type: 'revision',
          target_id: base.id,
          details: {
            opportunityId: opp.id,
            candidateId,
            actionId: action.id,
            tags,
            hasFeedback: Boolean(feedback),
            jobId: job.id,
          },
        },
      });
      return {
        actionId: action.id,
        opportunityId: opp.id,
        candidateId,
        baseRevisionId: base.id,
        jobId: job.id,
        replayed: false,
      };
    },
    { timeout: 20_000 },
  );
}
