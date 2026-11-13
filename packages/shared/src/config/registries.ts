import { z } from 'zod';
import { Channel } from '../domain/index.js';
import { IMAGE_ROLES } from '../images/types.js';

/** What a data source adapter can be asked for. Mirrors the ChessDataSource methods. */
export const SourceCapability = z.enum(['events', 'players', 'games', 'news']);
export type SourceCapability = z.infer<typeof SourceCapability>;

/** Reliability hierarchy from the development guide (2.3 Source reliability), most to least trusted. */
export const SourceReliability = z.enum([
  'official',
  'structured_feed',
  'publication',
  'unverified',
]);
export type SourceReliability = z.infer<typeof SourceReliability>;

const Url = z.string().url();

export const SourceAccess = z
  .object({
    method: z.enum(['api', 'file_download', 'rss', 'none']),
    baseUrl: Url.optional(),
    auth: z.enum(['none', 'token']),
    termsUrl: Url.optional(),
  })
  .strict();

/**
 * Usage policy. A source is `approved` only after someone read its API, limits and licence terms
 * (docs/sources/). Everything else fails closed: no capabilities, no automated retrieval.
 */
export const SourcePolicy = z
  .object({
    status: z.enum(['approved', 'pending_verification', 'blocked']),
    /** ISO date (YYYY-MM-DD) when the terms were last checked. */
    verifiedAt: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    automatedRetrieval: z.boolean(),
    attributionRequired: z.boolean(),
    notes: z.string().optional(),
  })
  .strict();

export const SourceLimits = z
  .object({
    maxConcurrent: z.number().int().positive(),
    minIntervalMs: z.number().int().min(0),
    /** Pause applied after HTTP 429 when the provider sends no Retry-After. */
    rateLimitBackoffMs: z.number().int().positive(),
    timeoutMs: z.number().int().positive(),
    maxRetries: z.number().int().min(0).max(5),
    /** Per-capability cache lifetime. A capability missing here is not cached. */
    cacheTtlSeconds: z.record(SourceCapability, z.number().int().min(0)).default({}),
  })
  .strict();
export type SourceLimits = z.infer<typeof SourceLimits>;

const DataSourceFields = z
  .object({
    id: z.string().regex(/^D\d+$/),
    kind: z.literal('data'),
    name: z.string().min(1),
    enabled: z.boolean(),
    reliability: SourceReliability,
    access: SourceAccess,
    policy: SourcePolicy,
    capabilities: z.array(SourceCapability),
    limits: SourceLimits,
  })
  .strict();
export type DataSourceEntry = z.infer<typeof DataSourceFields>;

/**
 * Image sources (module 1.8) follow the same fail-closed rule as data sources: only an approved source
 * with automated retrieval on may have roles, and a source without roles is never called.
 */
const ImageSourceFields = z
  .object({
    id: z.string().regex(/^I\d+$/),
    kind: z.literal('image'),
    name: z.string().min(1),
    enabled: z.boolean(),
    access: SourceAccess,
    policy: SourcePolicy,
    /** What the source may be searched for. Generic-only sources must not be used for named people. */
    roles: z.array(z.enum(IMAGE_ROLES)),
    limits: SourceLimits,
  })
  .strict();
export type ImageSourceEntry = z.infer<typeof ImageSourceFields>;

export const SourceEntry = z.discriminatedUnion('kind', [DataSourceFields, ImageSourceFields]);
export type SourceEntry = z.infer<typeof SourceEntry>;

export const SourcesRegistry = z
  .object({
    schemaVersion: z.literal(1),
    sources: z.array(SourceEntry).min(1),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (new Set(r.sources.map((s) => s.id)).size !== r.sources.length) {
      ctx.addIssue({ code: 'custom', message: 'source ids must be unique' });
    }
    for (const s of r.sources) {
      const bad = (msg: string) => ctx.addIssue({ code: 'custom', message: `${s.id}: ${msg}` });
      const abilities = s.kind === 'data' ? s.capabilities : s.roles;
      const noun = s.kind === 'data' ? 'capabilities' : 'roles';
      if (new Set(abilities).size !== abilities.length)
        bad(s.kind === 'data' ? 'duplicate capability' : 'duplicate role');
      if (abilities.length > 0) {
        if (s.policy.status !== 'approved') bad(`${noun} require policy.status "approved"`);
        if (!s.policy.automatedRetrieval) bad(`${noun} require policy.automatedRetrieval`);
        if (s.access.method === 'none') bad(`${noun} require an access method`);
      }
      if (s.policy.status === 'approved') {
        if (s.kind === 'data' && s.reliability === 'unverified') {
          bad('an unverified source cannot be approved');
        }
        if (!s.policy.verifiedAt) bad('an approved source needs policy.verifiedAt');
        if (!s.access.termsUrl) bad('an approved source needs access.termsUrl');
      }
      if (s.policy.automatedRetrieval && s.policy.status !== 'approved') {
        bad('automatedRetrieval requires policy.status "approved"');
      }
      if (s.access.method !== 'none' && !s.access.baseUrl) bad('access.baseUrl is required');
    }
  });
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
