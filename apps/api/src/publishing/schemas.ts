import { z } from 'zod';
import { Channel, PublicationStatus } from '@smb/shared';

export const PublicationIdParam = z.object({
  id: z.string().uuid(),
});

export const ListPublicationsQuery = z.object({
  status: PublicationStatus.optional(),
  channel: Channel.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.string().datetime().optional(),
});

export const RetryPublicationBody = z.object({
  reason: z.string().min(1).max(1000),
});

export const ResolvePublicationBody = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('published'),
    externalId: z.string().min(1).max(256),
    url: z.string().url().optional(),
  }),
  z.object({
    outcome: z.literal('not_published'),
    reason: z.string().min(1).max(1000),
  }),
  z.object({
    outcome: z.literal('abandon'),
    reason: z.string().min(1).max(1000),
  }),
]);

export type ListPublicationsQuery = z.infer<typeof ListPublicationsQuery>;
export type RetryPublicationBody = z.infer<typeof RetryPublicationBody>;
export type ResolvePublicationBody = z.infer<typeof ResolvePublicationBody>;
