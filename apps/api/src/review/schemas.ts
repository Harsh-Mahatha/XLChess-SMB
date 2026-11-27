import { z } from 'zod';
import { CHANGE_KINDS } from '@smb/shared';

const hash = z.string().regex(/^[0-9a-f]{64}$/, 'a sha256 hash');

export const ApproveBody = z
  .object({
    contentHash: hash,
    channels: z
      .array(z.enum(['x', 'facebook', 'instagram', 'discord']))
      .min(1)
      .max(4),
    scheduledFor: z.coerce.date().optional(),
    acknowledgeFailedChecks: z.boolean().optional(),
    /** Seconds the reviewer actively looked at the post before acting. Optional; capped at two hours. */
    activeSeconds: z.number().int().min(0).max(7200).optional(),
  })
  .strict();
export type ApproveBody = z.infer<typeof ApproveBody>;

export const EditBody = z
  .object({
    baseRevisionId: z.string().uuid(),
    headline: z.string().trim().min(1).max(300).optional(),
    caption: z.string().max(10_000).optional(),
    channelTexts: z.record(z.string().max(10_000)).optional(),
    altText: z.string().max(1500).optional(),
    changeNote: z.string().trim().max(500).optional(),
    /** A factual correction, a creative improvement, or both. Worked out from the tags when left out. */
    changeKind: z.enum(CHANGE_KINDS).optional(),
    changeTags: z.array(z.string().max(40)).max(10).optional(),
  })
  .strict();
export type EditBody = z.infer<typeof EditBody>;

export const ActionBody = z
  .object({
    feedback: z.string().max(4000).optional(),
    feedbackTags: z.array(z.string().max(40)).max(10).optional(),
    deferUntil: z.coerce.date().optional(),
    candidateId: z.string().uuid().optional(),
    revisionId: z.string().uuid().optional(),
    /** Seconds the reviewer actively looked at the post before acting. Optional; capped at two hours. */
    activeSeconds: z.number().int().min(0).max(7200).optional(),
  })
  .strict();
export type ActionBody = z.infer<typeof ActionBody>;

export const ReviseBody = z
  .object({
    baseRevisionId: z.string().uuid(),
    feedback: z.string().max(4000).optional(),
    feedbackTags: z.array(z.string().max(40)).max(10).optional(),
    /** Seconds the reviewer actively looked at the post before acting. Optional; capped at two hours. */
    activeSeconds: z.number().int().min(0).max(7200).optional(),
  })
  .strict();
export type ReviseBody = z.infer<typeof ReviseBody>;

const period = {
  /** Opportunities that became ready for review at or after this time. */
  from: z.coerce.date().optional(),
  /** ... and before this time. */
  to: z.coerce.date().optional(),
  postType: z.string().min(1).max(20).optional(),
};

export const FeedbackSummaryQuery = z.object(period).strict();
export type FeedbackSummaryQuery = z.infer<typeof FeedbackSummaryQuery>;

export const CorrectionsQuery = z
  .object({
    ...period,
    /** Edits only: `unclassified` lists the ones nobody labelled. */
    kind: z.enum([...CHANGE_KINDS, 'unclassified']).optional(),
    tag: z.string().max(40).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();
export type CorrectionsQuery = z.infer<typeof CorrectionsQuery>;

export const QueueQuery = z
  .object({
    status: z.enum(['awaiting_review', 'deferred']).default('awaiting_review'),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

export const IdParam = z.object({ id: z.string().uuid() });
