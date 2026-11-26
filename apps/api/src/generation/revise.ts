import type { Prisma, PrismaClient } from '@prisma/client';
import {
  CandidateDraft,
  changedFields,
  recheckRevision,
  runRevision,
  type AiProvider,
  type ChannelsRegistry,
  type GenerationInput,
  type OtherCandidate,
  type RevisionOptions,
  type RevisionRequest,
  type RevisionResult,
  type Slot,
} from '@smb/shared';
import { stringMap } from './feedback.js';
import { buildInputForOpportunity } from './payload.js';
import { revisionHash } from './service.js';

/** Why a rewrite could not be made or stored. `superseded` and `wrong_status` mean the request is out of date. */
export class RevisionNotPossibleError extends Error {
  constructor(
    readonly code: 'not_found' | 'superseded' | 'wrong_status' | 'no_change' | 'nothing_to_revise',
    message: string,
  ) {
    super(message);
    this.name = 'RevisionNotPossibleError';
  }
}

export interface StoredRevision {
  revisionId: string;
  revisionNo: number;
  contentHash: string;
  /** True when the rewrite passed every deterministic check. */
  passed: boolean;
  changedFields: string[];
  /** False when an earlier run already stored the rewrite for this request. */
  created: boolean;
}

export interface ReviseDeps {
  db: PrismaClient;
  provider: AiProvider;
  channels: ChannelsRegistry;
}

const REVISABLE = ['awaiting_review', 'deferred'];

type Db = PrismaClient | Prisma.TransactionClient;

/** Everything a rewrite needs, read fresh and checked: the request must still be about the newest revision. */
async function subject(db: Db, actionId: string) {
  const action = await db.review_actions.findUnique({ where: { id: actionId } });
  if (!action || action.action !== 'revise' || !action.candidate_id || !action.revision_id) {
    throw new RevisionNotPossibleError('not_found', `no revise request ${actionId}`);
  }
  const candidate = await db.post_candidates.findUniqueOrThrow({
    where: { id: action.candidate_id },
  });
  const opp = await db.post_opportunities.findUniqueOrThrow({
    where: { id: candidate.opportunity_id },
  });
  if (!REVISABLE.includes(opp.status)) {
    throw new RevisionNotPossibleError(
      'wrong_status',
      `the opportunity is ${opp.status}; a rewrite is only possible while it is in review`,
    );
  }
  const cycle = await db.post_candidates.findMany({
    where: { opportunity_id: opp.id },
    orderBy: [{ generation_cycle: 'desc' }, { slot: 'asc' }],
    include: {
      post_revisions: {
        orderBy: { revision_no: 'desc' },
        take: 1,
        include: {
          revision_claims: { include: { research_claims: { select: { claim_key: true } } } },
          revision_assets: { include: { media_assets: true } },
        },
      },
    },
  });
  const current = cycle.filter((c) => c.generation_cycle === cycle[0]!.generation_cycle);
  const mine = current.find((c) => c.id === candidate.id);
  if (!mine) {
    throw new RevisionNotPossibleError(
      'superseded',
      'the candidate was replaced by a regeneration',
    );
  }
  const base = mine.post_revisions[0]!;
  if (base.id !== action.revision_id) {
    throw new RevisionNotPossibleError(
      'superseded',
      'the candidate has changed since the rewrite was requested',
    );
  }
  const draftOf = (c: (typeof current)[number]): CandidateDraft => {
    const rev = c.post_revisions[0]!;
    return {
      headline: rev.headline ?? '',
      caption: rev.caption,
      channelTexts: stringMap(rev.channel_texts),
      claimKeys: rev.revision_claims.map((k) => k.research_claims.claim_key),
      hashtags: ((c.output as { hashtags?: string[] } | null)?.hashtags ?? []).slice(0, 5),
    };
  };
  const others: OtherCandidate[] = current
    .filter((c) => c.id !== candidate.id)
    .map((c) => ({ slot: c.slot as Slot, draft: draftOf(c) }));
  return { action, candidate, opp, base, draft: draftOf(mine), others };
}

/**
 * Stores a rewrite, whoever produced it, as a new revision written by the model. The rewrite is re-parsed and
 * every check is run again here. It is refused when the candidate moved on while the model was working, so a
 * late answer can never overwrite a reviewer's own edit. A rewrite that fails its checks is stored flagged:
 * approval then needs the reviewer to confirm they have read the failures, exactly as for a new candidate.
 */
export async function saveRevision(
  db: PrismaClient,
  input: GenerationInput,
  actionId: string,
  produced: RevisionResult,
  options: { jobId?: string } = {},
): Promise<StoredRevision> {
  return db.$transaction(
    async (tx) => {
      const first = await tx.review_actions.findUnique({ where: { id: actionId } });
      if (!first?.opportunity_id) {
        throw new RevisionNotPossibleError('not_found', `no revise request ${actionId}`);
      }
      await tx.$queryRaw`select id from smb.post_opportunities where id = ${first.opportunity_id}::uuid for update`;

      const already = await tx.post_revisions.findFirst({ where: { review_action_id: actionId } });
      if (already) {
        return {
          revisionId: already.id,
          revisionNo: already.revision_no,
          contentHash: already.content_hash,
          passed: Boolean((already.validation as { passed?: boolean } | null)?.passed),
          changedFields: already.changed_fields,
          created: false,
        };
      }

      const { action, candidate, opp, base, others } = await subject(tx, actionId);
      const result = recheckRevision(produced, input, others);
      const { draft } = result;
      const channelTexts = Object.fromEntries(
        Object.entries(draft.channelTexts).filter((e): e is [string, string] => Boolean(e[1])),
      );
      const changed = changedFields(
        {
          headline: base.headline,
          caption: base.caption,
          channelTexts: stringMap(base.channel_texts),
          altText: base.alt_text,
        },
        { headline: draft.headline, caption: draft.caption, channelTexts, altText: base.alt_text },
      );
      if (changed.length === 0) {
        throw new RevisionNotPossibleError('no_change', 'the model returned the post unchanged');
      }

      // The graphic can stay only while the words on it are unchanged (the same rule as a person's edit).
      const keepAssets = changed.includes('headline') ? [] : base.revision_assets;
      const template =
        keepAssets.length > 0 && base.template_version
          ? base.template_version
          : ((candidate.visual_plan as { template?: string } | null)?.template ?? '');
      const claimIds = new Map(
        (
          await tx.research_claims.findMany({
            where: { package_id: candidate.research_package_id },
            select: { id: true, claim_key: true },
          })
        ).map((c) => [c.claim_key, c.id]),
      );

      const created = await tx.post_revisions.create({
        data: {
          candidate_id: candidate.id,
          revision_no: base.revision_no + 1,
          parent_revision_id: base.id,
          caption: draft.caption,
          channel_texts: channelTexts as Prisma.InputJsonValue,
          headline: draft.headline,
          alt_text: base.alt_text,
          template_version: keepAssets.length > 0 ? base.template_version : null,
          content_hash: revisionHash({
            headline: draft.headline,
            caption: draft.caption,
            channelTexts,
            template,
            assetHashes: keepAssets.map((a) => a.media_assets.sha256),
          }),
          author_kind: 'ai',
          change_note: 'Rewritten by the model from reviewer feedback',
          change_kind: 'ai_revision',
          changed_fields: changed,
          change_tags: action.feedback_tags,
          review_action_id: action.id,
          validation: result.validation as unknown as Prisma.InputJsonValue,
          generation: {
            provider: result.provider,
            model: result.model,
            promptVersion: result.promptVersion,
            settings: result.settings,
            attempts: result.attempts,
            durationMs: result.durationMs,
            jobId: options.jobId ?? null,
          } as Prisma.InputJsonValue,
          revision_claims: {
            create: [...new Set(draft.claimKeys)].flatMap((k) => {
              const id = claimIds.get(k);
              return id ? [{ claim_id: id }] : [];
            }),
          },
          revision_assets: {
            create: keepAssets.map((a) => ({ asset_id: a.asset_id, role: a.role })),
          },
        },
      });
      await tx.audit_log.create({
        data: {
          actor: 'system',
          action: 'review.ai_revision',
          target_type: 'revision',
          target_id: created.id,
          details: {
            opportunityId: opp.id,
            candidateId: candidate.id,
            baseRevisionId: base.id,
            actionId: action.id,
            requestedBy: action.reviewer_id,
            promptVersion: result.promptVersion,
            model: result.model,
            passed: result.validation.passed,
            changedFields: changed,
          },
        },
      });
      return {
        revisionId: created.id,
        revisionNo: created.revision_no,
        contentHash: created.content_hash,
        passed: result.validation.passed,
        changedFields: changed,
        created: true,
      };
    },
    { timeout: 20_000 },
  );
}

/** Builds the model input and revision request for a pending `revise` review action. */
export async function buildRevisionSubject(
  db: PrismaClient,
  channels: ChannelsRegistry,
  actionId: string,
): Promise<{ input: GenerationInput; request: RevisionRequest }> {
  const { action, candidate, opp, draft, others } = await subject(db, actionId);
  const current = CandidateDraft.safeParse(draft);
  if (!current.success) {
    throw new RevisionNotPossibleError(
      'nothing_to_revise',
      `the current revision cannot be rewritten: ${current.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  }
  const { input } = await buildInputForOpportunity(db, channels, opp.id);
  return {
    input,
    request: {
      slot: candidate.slot as Slot,
      current: current.data,
      request: { text: action.feedback, tags: action.feedback_tags },
      others,
    },
  };
}

/**
 * Revision step for one request (prompt stage 6): build the model's input, rewrite the candidate from the
 * reviewer's feedback with the given provider, and store the result as a new revision. Running it again for
 * the same request returns the stored rewrite.
 */
export async function reviseCandidate(
  deps: ReviseDeps,
  actionId: string,
  options: RevisionOptions & { jobId?: string } = {},
): Promise<StoredRevision> {
  const already = await deps.db.post_revisions.findFirst({ where: { review_action_id: actionId } });
  if (already) {
    return {
      revisionId: already.id,
      revisionNo: already.revision_no,
      contentHash: already.content_hash,
      passed: Boolean((already.validation as { passed?: boolean } | null)?.passed),
      changedFields: already.changed_fields,
      created: false,
    };
  }
  const { input, request } = await buildRevisionSubject(deps.db, deps.channels, actionId);
  const result = await runRevision(deps.provider, input, request, options);
  return saveRevision(deps.db, input, actionId, result, options);
}
