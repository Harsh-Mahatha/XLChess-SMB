import { z } from 'zod';

export const ErrorBody = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ErrorBody = z.infer<typeof ErrorBody>;

export const HealthResponse = z.object({
  status: z.literal('ok'),
  service: z.literal('smb-api'),
  version: z.string(),
  publishMode: z.enum(['dry_run', 'sandbox', 'live']),
  time: z.string(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;
