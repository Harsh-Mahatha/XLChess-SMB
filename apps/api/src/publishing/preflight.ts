import type { PrismaClient } from '@prisma/client';
import { captionSimilarity, type ChannelsRegistry, type PublishMode } from '@smb/shared';
import type { ObjectStore } from '../storage/index.js';
import { sha256Hex } from '../storage/content.js';
import { revisionHash } from '../generation/service.js';
import { AssetLicenceError, assertAssetsLicensed } from '../images/guard.js';
import { AssetIntegrityError, ensureAssetsIntact } from '../assets/guard.js';
import { channelPreviews } from '../review/previews.js';
import { publisherFor, PublisherDeps } from './registry.js';
import { matchKey } from './x/text.js';
import type { ApprovedPost } from './types.js';
import type { Env } from '../env.js';

export interface PreflightProblem {
  code: string;
  message: string;
  permanent: boolean;
}

export interface PreflightDeps {
  db: PrismaClient;
  store: ObjectStore;
  channels: ChannelsRegistry;
  env: Pick<Env, 'SMB_PUBLISH_MODE' | 'SMB_ALLOW_LIVE_PUBLISH'>;
  publishers: PublisherDeps;
}

export interface PreflightResult {
  ok: boolean;
  isDue: boolean;
  problems: PreflightProblem[];
}

function stringMap(val: unknown): Record<string, string> {
  if (!val || typeof val !== 'object' || Array.isArray(val)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(val)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

/** Check 1: Approval must be valid, newest, not withdrawn, and opportunity in a publishable state. */
export async function checkApprovalInForce(
  deps: Pick<PreflightDeps, 'db'>,
  post: ApprovedPost,
): Promise<PreflightProblem | null> {
  const approval = await deps.db.review_actions.findUnique({
    where: { id: post.approvalId },
  });

  if (!approval || approval.action !== 'approve') {
    return {
      code: 'approval_not_in_force',
      message: `Approval ${post.approvalId} not found or not an approve action`,
      permanent: true,
    };
  }

  const newestApprove = await deps.db.review_actions.findFirst({
    where: { opportunity_id: post.opportunityId, action: 'approve' },
    orderBy: { created_at: 'desc' },
  });

  if (newestApprove?.id !== post.approvalId) {
    return {
      code: 'approval_not_in_force',
      message: 'A newer approval exists for this opportunity',
      permanent: true,
    };
  }

  const withdrawnComment = await deps.db.review_actions.findFirst({
    where: {
      opportunity_id: post.opportunityId,
      action: 'comment',
      created_at: { gt: approval.created_at },
      feedback_tags: { has: 'approval_withdrawn' },
    },
  });

  if (withdrawnComment) {
    return {
      code: 'approval_not_in_force',
      message: 'Approval was withdrawn by a subsequent change',
      permanent: true,
    };
  }

  const opp = await deps.db.post_opportunities.findUnique({
    where: { id: post.opportunityId },
  });

  if (!opp || !['approved', 'scheduled', 'publishing'].includes(opp.status)) {
    return {
      code: 'approval_not_in_force',
      message: `Opportunity status '${opp?.status}' cannot be published`,
      permanent: true,
    };
  }

  return null;
}

/** Check 2: Content hash must match recomputed revision hash, and revision must not be superseded. */
export async function checkVersionUnchanged(
  deps: Pick<PreflightDeps, 'db'>,
  post: ApprovedPost,
): Promise<PreflightProblem | null> {
  const rev = await deps.db.post_revisions.findUnique({
    where: { id: post.revisionId },
    include: {
      revision_assets: {
        include: { media_assets: true },
      },
    },
  });

  if (!rev) {
    return {
      code: 'revision_superseded',
      message: `Revision ${post.revisionId} not found`,
      permanent: true,
    };
  }

  const graphicAssets = rev.revision_assets
    .filter((ra) => ra.role === 'graphic')
    .map((ra) => ra.media_assets);

  const computedHash = revisionHash({
    headline: rev.headline ?? '',
    caption: rev.caption,
    channelTexts: stringMap(rev.channel_texts),
    template: rev.template_version,
    assetHashes: graphicAssets.map((g) => g.sha256).sort(),
  });

  if (computedHash !== rev.content_hash || computedHash !== post.contentHash) {
    return {
      code: 'hash_mismatch',
      message:
        'Revision content hash does not match computed hash (content changed after approval)',
      permanent: true,
    };
  }

  const newestRev = await deps.db.post_revisions.findFirst({
    where: { candidate_id: rev.candidate_id },
    orderBy: { revision_no: 'desc' },
  });

  if (newestRev?.id !== rev.id) {
    return {
      code: 'revision_superseded',
      message: 'A newer revision exists for this candidate',
      permanent: true,
    };
  }

  const cycle = await deps.db.post_candidates.aggregate({
    where: { opportunity_id: post.opportunityId },
    _max: { generation_cycle: true },
  });
  const cand = await deps.db.post_candidates.findUnique({
    where: { id: rev.candidate_id },
  });

  if (cycle._max.generation_cycle !== cand?.generation_cycle) {
    return {
      code: 'revision_superseded',
      message: 'This candidate belongs to an older generation cycle',
      permanent: true,
    };
  }

  return null;
}

/** Check 3: Required media must exist in Storage and match its recorded SHA-256 hash. */
export async function checkMediaExists(
  deps: Pick<PreflightDeps, 'db' | 'channels'>,
  post: ApprovedPost,
): Promise<PreflightProblem[]> {
  const problems: PreflightProblem[] = [];

  const channelSpec = deps.channels.channels.find((c) => c.id === post.channel);
  if (channelSpec?.mediaRequired && post.media.length === 0) {
    problems.push({
      code: 'media_missing',
      message: `Channel '${post.channel}' requires an image attachment`,
      permanent: true,
    });
  }

  for (const m of post.media) {
    const asset = await deps.db.media_assets.findUnique({
      where: { id: m.assetId },
    });

    if (!asset || asset.deleted_at !== null) {
      problems.push({
        code: 'media_missing',
        message: `Media asset ${m.assetId} has been deleted or is missing`,
        permanent: false,
      });
      continue;
    }

    const computed = sha256Hex(m.bytes);
    if (computed !== m.sha256 || computed !== asset.sha256) {
      problems.push({
        code: 'media_changed',
        message: `Media asset ${m.assetId} bytes do not match expected sha256`,
        permanent: true,
      });
    }
  }

  return problems;
}

/** Check 4: Photographs in the graphic must have accepted licenses and intact pixel integrity. */
export async function checkLicenceAndIntegrity(
  deps: Pick<PreflightDeps, 'db' | 'store'>,
  post: ApprovedPost,
): Promise<PreflightProblem | null> {
  const assetIds = post.media.map((m) => m.assetId);
  if (assetIds.length === 0) return null;

  try {
    await assertAssetsLicensed(deps.db, assetIds);
  } catch (err: unknown) {
    if (err instanceof AssetLicenceError) {
      return {
        code: 'licence_problem',
        message: `Asset licence refused for ${err.assetId}: ${err.reason}`,
        permanent: true,
      };
    }
    throw err;
  }

  try {
    await ensureAssetsIntact({ db: deps.db, store: deps.store }, assetIds);
  } catch (err: unknown) {
    if (err instanceof AssetIntegrityError) {
      return {
        code: 'integrity_problem',
        message: `Asset integrity check failed for ${err.assetId}: ${err.reason}`,
        permanent: true,
      };
    }
    throw err;
  }

  return null;
}

/** Check 5: Channel must be enabled, pass preview checks, and pass publisher validation. */
export function checkChannelConstraints(
  deps: Pick<PreflightDeps, 'channels' | 'publishers'>,
  post: ApprovedPost,
): PreflightProblem[] {
  const problems: PreflightProblem[] = [];

  const spec = deps.channels.channels.find((c) => c.id === post.channel);
  if (!spec || !spec.enabled) {
    problems.push({
      code: 'channel_disabled',
      message: `Channel '${post.channel}' is disabled in configuration`,
      permanent: true,
    });
  }

  const previews = channelPreviews(deps.channels, {
    caption: post.text,
    channelTexts: { [post.channel]: post.text },
    altText: post.media[0]?.altText,
    hasGraphic: post.media.length > 0,
  });

  const preview = previews.find((p) => p.channel === post.channel);
  if (preview && preview.problems.length > 0) {
    problems.push({
      code: 'channel_rules',
      message: `Channel rules failed: ${preview.problems.join('; ')}`,
      permanent: true,
    });
  }

  try {
    const publisher = publisherFor(post.mode, post.channel, deps.publishers);
    const validation = publisher.validate(post);
    if (!validation.ok) {
      problems.push({
        code: 'channel_rules',
        message: `Publisher validation failed: ${validation.problems.join('; ')}`,
        permanent: true,
      });
    }
  } catch (err: unknown) {
    const error = err as Error;
    problems.push({
      code: 'channel_rules',
      message: error.message,
      permanent: true,
    });
  }

  return problems;
}

/** Check 6: Duplicate safeguards — no other active publication for this opportunity, and caption deduplication. */
export async function checkDuplicateSafeguards(
  deps: Pick<PreflightDeps, 'db'>,
  post: ApprovedPost,
  now: Date,
): Promise<PreflightProblem | null> {
  // Safeguard 6a: Under opportunity lock, no other publication for this opp + channel in publishing, uncertain, published, dry_run_recorded
  const otherForOpp = await deps.db.publications.findFirst({
    where: {
      channel: post.channel,
      id: { not: post.publicationId },
      status: { in: ['publishing', 'uncertain', 'published', 'dry_run_recorded'] },
      review_actions: { opportunity_id: post.opportunityId },
    },
  });

  if (otherForOpp) {
    return {
      code: 'already_published',
      message: `Another publication for opportunity ${post.opportunityId} is already in state '${otherForOpp.status}'`,
      permanent: true,
    };
  }

  // Safeguard 6b: Caption-level deduplication window and similarity threshold from post_configs
  const activeConfig = await deps.db.post_configs.findFirst({
    where: { post_type_id: post.postTypeId, is_active: true },
  });

  const configJson = (activeConfig?.config_json as Record<string, any>) ?? {};
  const dedupe = configJson.deduplication ?? {};
  const windowDays = typeof dedupe.windowDays === 'number' ? dedupe.windowDays : 30;
  const similarityThreshold =
    typeof dedupe.similarityThreshold === 'number' ? dedupe.similarityThreshold : 0.85;

  const windowCutoff = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);

  const recentPubs = await deps.db.publications.findMany({
    where: {
      channel: post.channel,
      id: { not: post.publicationId },
      status: { in: ['published', 'dry_run_recorded', 'uncertain'] },
      OR: [{ published_at: { gte: windowCutoff } }, { updated_at: { gte: windowCutoff } }],
      review_actions: {
        post_opportunities: {
          post_type_id: post.postTypeId,
        },
      },
    },
    include: {
      post_revisions: true,
    },
  });

  const postKey = matchKey(post.text);
  for (const pub of recentPubs) {
    const otherChannelTexts = stringMap(pub.post_revisions.channel_texts);
    const otherText = otherChannelTexts[post.channel] ?? pub.post_revisions.caption;

    if (matchKey(otherText) === postKey) {
      return {
        code: 'duplicate_caption',
        message: `Post text matches an existing publication ${pub.id} from the last ${windowDays} days`,
        permanent: true,
      };
    }

    const similarity = captionSimilarity(post.text, otherText);
    if (similarity >= similarityThreshold) {
      return {
        code: 'duplicate_caption',
        message: `Post text similarity (${similarity.toFixed(2)}) meets or exceeds threshold ${similarityThreshold} against publication ${pub.id}`,
        permanent: true,
      };
    }
  }

  return null;
}

/** Check 7: Schedule timing and opportunity expiration. */
export async function checkScheduleAndInstruction(
  deps: Pick<PreflightDeps, 'db'>,
  post: ApprovedPost,
  now: Date,
): Promise<{ isDue: boolean; problem?: PreflightProblem }> {
  const pub = await deps.db.publications.findUnique({
    where: { id: post.publicationId },
  });

  const opp = await deps.db.post_opportunities.findUnique({
    where: { id: post.opportunityId },
  });

  if (opp?.not_after && opp.not_after <= now) {
    return {
      isDue: true,
      problem: {
        code: 'expired',
        message: `Opportunity ${post.opportunityId} is past its not_after expiration time`,
        permanent: true,
      },
    };
  }

  if (pub?.scheduled_for && pub.scheduled_for > now) {
    return { isDue: false };
  }

  if (pub?.retry_after && pub.retry_after > now) {
    return { isDue: false };
  }

  return { isDue: true };
}

/** Mode safety check (D2): ensure publish mode is permitted by the runtime environment. */
export function checkModeAllowed(
  env: Pick<Env, 'SMB_PUBLISH_MODE' | 'SMB_ALLOW_LIVE_PUBLISH'>,
  mode: PublishMode,
): PreflightProblem | null {
  if (mode === 'live') {
    if (env.SMB_PUBLISH_MODE !== 'live' || !env.SMB_ALLOW_LIVE_PUBLISH) {
      return {
        code: 'mode_not_allowed',
        message: 'Publication mode is live but current environment does not allow live publishing',
        permanent: false,
      };
    }
  }

  if (mode === 'sandbox') {
    if (env.SMB_PUBLISH_MODE !== 'sandbox' && env.SMB_PUBLISH_MODE !== 'live') {
      return {
        code: 'mode_not_allowed',
        message: 'Publication mode is sandbox but current environment is dry_run',
        permanent: false,
      };
    }
  }

  return null;
}

/**
 * Runs all seven preflight checks for an approved post. Returns every problem found (does not abort early).
 */
export async function preflight(
  deps: PreflightDeps,
  post: ApprovedPost,
  now: Date = new Date(),
): Promise<PreflightResult> {
  const problems: PreflightProblem[] = [];

  // Check 1: Approval in force
  const p1 = await checkApprovalInForce(deps, post);
  if (p1) problems.push(p1);

  // Check 2: Version unchanged
  const p2 = await checkVersionUnchanged(deps, post);
  if (p2) problems.push(p2);

  // Check 3: Media exists and matches sha256
  const p3 = await checkMediaExists(deps, post);
  problems.push(...p3);

  // Check 4: Rights & pixel integrity
  const p4 = await checkLicenceAndIntegrity(deps, post);
  if (p4) problems.push(p4);

  // Check 5: Channel rules
  const p5 = checkChannelConstraints(deps, post);
  problems.push(...p5);

  // Check 6: Duplicate safeguards
  const p6 = await checkDuplicateSafeguards(deps, post, now);
  if (p6) problems.push(p6);

  // Check 7: Timing / Schedule
  const schedule = await checkScheduleAndInstruction(deps, post, now);
  if (schedule.problem) problems.push(schedule.problem);

  // Mode check
  const pMode = checkModeAllowed(deps.env, post.mode);
  if (pMode) problems.push(pMode);

  return {
    ok: problems.length === 0,
    isDue: schedule.isDue,
    problems,
  };
}
