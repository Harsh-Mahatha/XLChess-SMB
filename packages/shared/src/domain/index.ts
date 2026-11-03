import { z } from 'zod';

/**
 * Domain enums that mirror Postgres enums in the `smb` schema (supabase/migrations).
 * tests/integration/db/enums.test.ts fails if the two drift apart.
 */

export const OpportunityStatus = z.enum([
  'pending',
  'researching',
  'generating',
  'awaiting_review',
  'approved',
  'scheduled',
  'publishing',
  'published',
  'partially_published',
  'rejected',
  'deferred',
  'failed',
]);
export type OpportunityStatus = z.infer<typeof OpportunityStatus>;

export const Channel = z.enum(['x', 'facebook', 'instagram', 'discord']);
export type Channel = z.infer<typeof Channel>;

export const PublishMode = z.enum(['dry_run', 'sandbox', 'live']);
export type PublishMode = z.infer<typeof PublishMode>;

export const PublicationStatus = z.enum([
  'pending',
  'publishing',
  'published',
  'dry_run_recorded',
  'failed',
  'cancelled',
]);
export type PublicationStatus = z.infer<typeof PublicationStatus>;

export const ReviewActionType = z.enum([
  'approve',
  'reject',
  'defer',
  'regenerate',
  'request_research',
  'comment',
]);
export type ReviewActionType = z.infer<typeof ReviewActionType>;

export const ClaimVerification = z.enum(['unverified', 'single_source', 'verified', 'conflicting']);
export type ClaimVerification = z.infer<typeof ClaimVerification>;

export const AssetKind = z.enum(['original', 'derived', 'render', 'evidence']);
export type AssetKind = z.infer<typeof AssetKind>;

export const LicenceDecision = z.enum(['accepted', 'rejected']);
export type LicenceDecision = z.infer<typeof LicenceDecision>;
