import type { Channel, PublishMode } from '@smb/shared';
export type { XCredentials } from '../env.js';

/** Everything a channel needs to post one approved revision, already checked. Built from the database only. */
export interface ApprovedPost {
  publicationId: string;
  opportunityId: string;
  postTypeId: string;
  approvalId: string;
  revisionId: string;
  contentHash: string;
  channel: Channel;
  mode: PublishMode;
  /** The text for this channel: its own channel text, or the caption (same rule as channelPreviews). */
  text: string;
  media: Array<{
    assetId: string;
    bytes: Uint8Array;
    mime: string;
    sha256: string;
    altText: string | null;
  }>;
  idempotencyKey: string;
}

export interface ValidationResult {
  ok: boolean;
  problems: string[];
}

export type PublishResult =
  | {
      kind: 'published';
      externalId: string;
      url: string;
      publishedAt: Date;
      response: Record<string, unknown>;
    }
  | { kind: 'dry_run'; request: Record<string, unknown> };

/** How a failed call must be treated. This classification is the heart of "exactly once". */
export type FailureKind =
  | 'before_send' // nothing reached the create endpoint (validation, media upload, auth, 4xx on create other than duplicate). Safe to retry.
  | 'uncertain' // the create request may have been accepted. Never retry before a lookup.
  | 'rate_limited' // 429. Safe to retry after `retryAt`.
  | 'permanent'; // will never work (e.g. 403 account suspended, 400 text rejected). Do not retry; mark failed.

export class PublishError extends Error {
  constructor(
    readonly kind: FailureKind,
    readonly code: string,
    message: string,
    readonly retryAt?: Date,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'PublishError';
  }
}

export type LookupResult =
  | { kind: 'found'; externalId: string; url: string; publishedAt: Date }
  | { kind: 'absent' }
  | { kind: 'unknown'; reason: string };

/** Shared interface (FEATURES.md "Channel adapters", ARCHITECTURE.md section 4). */
export interface SocialPublisher {
  readonly channel: Channel;
  validate(post: ApprovedPost): ValidationResult;
  publish(post: ApprovedPost, signal?: AbortSignal): Promise<PublishResult>;
  /** Did a post with this content appear since `since`? Used before any retry of an uncertain attempt. */
  lookup(post: ApprovedPost, since: Date): Promise<LookupResult>;
  /** Is a known post still there? */
  getStatus(externalId: string): Promise<'live' | 'deleted' | 'unknown'>;
}
