import type { PrismaClient } from '@prisma/client';
import type { ChannelsRegistry } from '@smb/shared';
import type { ObjectStore } from '../storage/index.js';
import { channelPreviews } from '../review/previews.js';
import type { ApprovedPost } from './types.js';

export class PreflightError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PreflightError';
  }
}

function stringMap(val: unknown): Record<string, string> {
  if (!val || typeof val !== 'object' || Array.isArray(val)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(val)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

/**
 * Loads everything needed to publish an approved post from the database and storage.
 * Never re-renders graphics or generates content.
 */
export async function loadApprovedPost(
  deps: {
    db: PrismaClient;
    store: ObjectStore;
    channels: ChannelsRegistry;
  },
  publicationId: string,
): Promise<ApprovedPost> {
  const pub = await deps.db.publications.findUnique({
    where: { id: publicationId },
    include: {
      review_actions: true,
      post_revisions: {
        include: {
          post_candidates: {
            include: {
              post_opportunities: true,
            },
          },
          revision_assets: {
            include: {
              media_assets: true,
            },
          },
        },
      },
    },
  });

  if (!pub) {
    throw new PreflightError('not_found', `Publication ${publicationId} not found`);
  }

  const rev = pub.post_revisions;
  const candidate = rev.post_candidates;
  const opp = candidate.post_opportunities;
  const approval = pub.review_actions;

  // Resolve the text for this channel using channelPreviews (same rule as review)
  const channelTexts = stringMap(rev.channel_texts);
  const graphicAssets = rev.revision_assets
    .filter((ra) => ra.role === 'graphic')
    .map((ra) => ra.media_assets);

  const previews = channelPreviews(deps.channels, {
    caption: rev.caption,
    channelTexts,
    altText: rev.alt_text,
    hasGraphic: graphicAssets.length > 0,
  });

  const preview = previews.find((p) => p.channel === pub.channel);
  const text = preview ? preview.text : (channelTexts[pub.channel] ?? rev.caption);

  // Load media bytes for every graphic asset
  const media: ApprovedPost['media'] = [];
  for (const asset of graphicAssets) {
    let bytes: Uint8Array;
    try {
      bytes = await deps.store.get(asset.bucket, asset.path);
    } catch (err: unknown) {
      const error = err as Error;
      throw new PreflightError(
        'media_read_error',
        `Failed reading media asset ${asset.id} from storage: ${error.message}`,
      );
    }

    media.push({
      assetId: asset.id,
      bytes,
      mime: asset.mime,
      sha256: asset.sha256,
      altText: rev.alt_text,
    });
  }

  return {
    publicationId: pub.id,
    opportunityId: opp.id,
    postTypeId: opp.post_type_id,
    approvalId: approval.id,
    revisionId: rev.id,
    contentHash: pub.content_hash,
    channel: pub.channel,
    mode: pub.mode,
    text,
    media,
    idempotencyKey: pub.idempotency_key,
  };
}
