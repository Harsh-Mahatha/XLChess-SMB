import { z } from 'zod';
import { Channel } from '../domain/index.js';

/** config/sources.json: the approved source registry. Adapter details live with modules 1.4 and 1.8. */
export const SourceEntry = z
  .object({
    id: z.string().regex(/^[DI]\d+$/),
    kind: z.enum(['data', 'image']),
    name: z.string().min(1),
    enabled: z.boolean(),
  })
  .strict()
  .refine(
    (s) => s.id.startsWith(s.kind === 'data' ? 'D' : 'I'),
    'D ids are data sources and I ids are image sources',
  );

export const SourcesRegistry = z
  .object({
    schemaVersion: z.literal(1),
    sources: z.array(SourceEntry).min(1),
  })
  .strict()
  .refine(
    (r) => new Set(r.sources.map((s) => s.id)).size === r.sources.length,
    'source ids must be unique',
  );
export type SourcesRegistry = z.infer<typeof SourcesRegistry>;

/** config/channels.json: what each channel can carry, and whether publishing to it is switched on. */
export const ChannelEntry = z
  .object({
    id: Channel,
    name: z.string().min(1),
    /** Disabled channels may appear in a post-type config; they are skipped at publish time. */
    enabled: z.boolean(),
    maxTextLength: z.number().int().positive(),
    maxImages: z.number().int().min(0),
    mediaRequired: z.boolean(),
    altTextRequired: z.boolean(),
  })
  .strict();

export const ChannelsRegistry = z
  .object({
    schemaVersion: z.literal(1),
    channels: z.array(ChannelEntry).min(1),
  })
  .strict()
  .refine(
    (r) => new Set(r.channels.map((c) => c.id)).size === r.channels.length,
    'channel ids must be unique',
  );
export type ChannelsRegistry = z.infer<typeof ChannelsRegistry>;

/** config/taxonomy.json: the 18 categories and their subtypes. */
export const TaxonomySubtype = z
  .object({ id: z.string().regex(/^\d+\.\d+$/), name: z.string().min(1) })
  .strict();

export const Taxonomy = z
  .object({
    schemaVersion: z.literal(1),
    categories: z
      .array(
        z
          .object({
            id: z.number().int().positive(),
            name: z.string().min(1),
            subtypes: z.array(TaxonomySubtype).min(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict()
  .superRefine((t, ctx) => {
    const seen = new Set<string>();
    for (const c of t.categories) {
      for (const s of c.subtypes) {
        if (!s.id.startsWith(`${c.id}.`)) {
          ctx.addIssue({ code: 'custom', message: `subtype ${s.id} is not in category ${c.id}` });
        }
        if (seen.has(s.id))
          ctx.addIssue({ code: 'custom', message: `duplicate subtype id ${s.id}` });
        seen.add(s.id);
      }
    }
    const catIds = t.categories.map((c) => c.id);
    if (new Set(catIds).size !== catIds.length) {
      ctx.addIssue({ code: 'custom', message: 'duplicate category id' });
    }
  });
export type Taxonomy = z.infer<typeof Taxonomy>;
