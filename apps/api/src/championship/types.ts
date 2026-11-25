import type { PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import { z } from 'zod';

export class ChampionshipError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 422,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ChampionshipError';
  }
}

export interface ChampionshipDeps {
  db: PrismaClient;
  now?: () => Date;
  logger?: Logger;
}

export const CycleKeySchema = z.string().regex(/^[a-z0-9][a-z0-9-]{2,60}$/);

export const PlayerInfoSchema = z
  .object({
    name: z.string().trim().min(1),
    fideId: z.string().trim().min(1).optional(),
    title: z.string().trim().min(1).optional(),
    federation: z.string().trim().min(1).optional(),
  })
  .strict();

export const NextCycleSchema = z
  .object({
    stage: z.string().trim().min(1),
    summary: z.string().trim().min(1).optional(),
    expectedStart: z.string().trim().min(1).optional(),
    url: z.string().url().optional(),
  })
  .strict();

const SourceRefKey = z.string().regex(/^D\d+$/);
export const SourceEventRefsSchema = z
  .record(SourceRefKey, z.string().trim().min(1))
  .refine(
    (refs) => !Object.hasOwn(refs, 'D1'),
    'D1 is managed automatically and must not be provided in sourceEventRefs',
  );

const HttpsUrl = z
  .string()
  .url()
  .refine((u) => u.startsWith('https://'), 'officialUrl must use https://');

const IsoDateTime = z.string().datetime({ offset: true });

export const RegisterCycleBody = z
  .object({
    cycleKey: CycleKeySchema,
    title: z.string().trim().min(1),
    officialUrl: HttpsUrl,
    venue: z.string().trim().min(1).optional(),
    scheduledStart: IsoDateTime,
    scheduledEnd: IsoDateTime,
    totalGames: z.number().int().min(1).max(40),
    playerA: PlayerInfoSchema,
    playerB: PlayerInfoSchema,
    sourceEventRefs: SourceEventRefsSchema.optional(),
    nextCycle: NextCycleSchema.optional(),
  })
  .strict()
  .refine((b) => new Date(b.scheduledEnd).getTime() > new Date(b.scheduledStart).getTime(), {
    message: 'scheduledEnd must be after scheduledStart',
    path: ['scheduledEnd'],
  });
export type RegisterCycleInput = z.infer<typeof RegisterCycleBody>;

export const EditCycleBody = z
  .object({
    title: z.string().trim().min(1).optional(),
    officialUrl: HttpsUrl.optional(),
    venue: z.string().trim().min(1).nullable().optional(),
    scheduledStart: IsoDateTime.optional(),
    scheduledEnd: IsoDateTime.optional(),
    totalGames: z.number().int().min(1).max(40).optional(),
    playerA: PlayerInfoSchema.optional(),
    playerB: PlayerInfoSchema.optional(),
    sourceEventRefs: SourceEventRefsSchema.optional(),
    nextCycle: NextCycleSchema.nullable().optional(),
  })
  .strict();
export type EditCycleInput = z.infer<typeof EditCycleBody>;

export const AddTiebreakBody = z
  .object({
    kind: z.literal('tiebreak').default('tiebreak'),
    gameNumber: z.number().int().positive(),
    scheduledAt: IsoDateTime.optional(),
  })
  .strict();
export type AddTiebreakInput = z.infer<typeof AddTiebreakBody>;

export const ConfirmGameBody = z
  .object({
    result: z.enum(['1-0', '0-1', '1/2-1/2']),
    attested: z.boolean(),
    reason: z.string().trim().min(3).optional(),
    whitePlayer: z.enum(['a', 'b']).optional(),
  })
  .strict();
export type ConfirmGameInput = z.infer<typeof ConfirmGameBody>;

export const ConcludeCycleBody = z
  .object({
    winner: z.enum(['a', 'b']),
    attested: z.boolean(),
    note: z.string().trim().min(3),
  })
  .strict();
export type ConcludeCycleInput = z.infer<typeof ConcludeCycleBody>;

export const ForcePhaseBody = z
  .object({
    phase: z.enum(['pre_tournament', 'tournament', 'post_tournament']),
    reason: z.string().trim().min(3),
    lock: z.boolean().default(true),
    winner: z.enum(['a', 'b']).optional(),
  })
  .strict();
export type ForcePhaseInput = z.infer<typeof ForcePhaseBody>;

export const ResolveFlagBody = z
  .object({
    note: z.string().trim().min(3),
  })
  .strict();
export type ResolveFlagInput = z.infer<typeof ResolveFlagBody>;

export const ChampionshipIdParam = z.object({ id: z.string().uuid() });
export const ConfirmGameParams = z.object({
  id: z.string().uuid(),
  kind: z.enum(['classical', 'tiebreak']),
  number: z.coerce.number().int().positive(),
});
export const ResolveFlagParams = z.object({
  id: z.string().uuid(),
  flagId: z.string().uuid(),
});
export const ListChampionshipsQuery = z.object({
  current: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});
