import { z } from 'zod';
import { Channel } from '../domain/index.js';
import { StorySelection } from '../story/index.js';

/** Bump when the shape of a post-type config file changes incompatibly. */
export const CONFIG_SCHEMA_VERSION = 1;

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM (24-hour)');

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
export const Timezone = z.string().refine(isValidTimezone, 'not a valid IANA timezone');

const nonEmpty = z.string().trim().min(1);
const uniqueList = <T extends z.ZodTypeAny>(item: T) =>
  z.array(item).refine((a) => new Set(a).size === a.length, 'entries must be unique');

// ---------------------------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------------------------

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

/** Events the trigger-ingestion module (1.16) can raise. Adding one is a pipeline capability, not a config change. */
export const EVENT_TRIGGERS = [
  'game_completed',
  'round_completed',
  'tournament_started',
  'tournament_completed',
  'rating_list_published',
  'news_published',
] as const;
export const EventTrigger = z.enum(EVENT_TRIGGERS);
export type EventTrigger = z.infer<typeof EventTrigger>;

export const ScheduleRule = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('weekly'), day: z.enum(WEEKDAYS), time: HHMM }).strict(),
  z.object({ kind: z.literal('daily'), time: HHMM }).strict(),
  z.object({ kind: z.literal('interval'), everyMinutes: z.number().int().min(5) }).strict(),
  z.object({ kind: z.literal('event'), event: EventTrigger }).strict(),
  z.object({ kind: z.literal('manual') }).strict(),
]);
export type ScheduleRule = z.infer<typeof ScheduleRule>;

const Schedule = z.array(ScheduleRule).min(1);

// ---------------------------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------------------------

export const CANDIDATE_COUNT = 3;

export const ContentRules = z
  .object({
    requiredFacts: z.array(nonEmpty).min(1),
    tone: nonEmpty,
    structure: z.array(nonEmpty).min(1),
    restrictions: z.array(nonEmpty),
    candidateCount: z.literal(CANDIDATE_COUNT),
  })
  .strict();
export type ContentRules = z.infer<typeof ContentRules>;

export const ImageRules = z
  .object({
    need: z.enum(['required', 'preferred', 'none']),
    preferOriginalPhoto: z.boolean(),
    template: nonEmpty.optional(),
    composition: z.array(nonEmpty),
  })
  .strict();
export type ImageRules = z.infer<typeof ImageRules>;

export const DEDUPE_PLACEHOLDERS = ['postType', 'eventId', 'slot', 'date', 'week'] as const;

export const Deduplication = z
  .object({
    keyTemplate: z.string().superRefine((tpl, ctx) => {
      const found = [...tpl.matchAll(/\{([^}]*)\}/g)].map((m) => m[1] ?? '');
      if (found.length === 0) {
        ctx.addIssue({ code: 'custom', message: 'keyTemplate needs at least one {placeholder}' });
      }
      for (const p of found) {
        if (!(DEDUPE_PLACEHOLDERS as readonly string[]).includes(p)) {
          ctx.addIssue({ code: 'custom', message: `unknown placeholder {${p}}` });
        }
      }
    }),
    windowDays: z.number().int().min(1).max(3650),
    similarityThreshold: z.number().min(0).max(1),
  })
  .strict();
export type Deduplication = z.infer<typeof Deduplication>;

export const RetryPolicy = z
  .object({
    maxAttempts: z.number().int().min(1).max(10),
    backoffSeconds: z.number().int().min(1),
    backoffMultiplier: z.number().min(1),
    /** Work older than this is reconsidered instead of run (becomes jobs.not_after). */
    staleAfterMinutes: z.number().int().min(1),
  })
  .strict();
export type RetryPolicy = z.infer<typeof RetryPolicy>;

// ---------------------------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------------------------

/**
 * A phase can only adjust timing, importance, wording and staleness. It cannot touch channels, approval,
 * sources or the candidate count, so a phase can never widen what the post type is allowed to do.
 * The detector that decides which phase is active is module 1.15.
 */
export const PhaseContentOverlay = z
  .object({
    requiredFacts: z.array(nonEmpty).min(1).optional(),
    tone: nonEmpty.optional(),
    structure: z.array(nonEmpty).min(1).optional(),
    /** Added to the base restrictions, never replacing them. */
    restrictions: z.array(nonEmpty).optional(),
  })
  .strict();

export const Phase = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_]*$/),
    name: nonEmpty,
    activation: z.object({ signal: nonEmpty, value: nonEmpty }).strict(),
    schedule: Schedule.optional(),
    priority: z.number().int().min(1).max(1000).optional(),
    contentRules: PhaseContentOverlay.optional(),
    staleAfterMinutes: z.number().int().min(1).optional(),
  })
  .strict();
export type Phase = z.infer<typeof Phase>;

// ---------------------------------------------------------------------------------------------
// Post-type config
// ---------------------------------------------------------------------------------------------

export const PostTypeConfig = z
  .object({
    schemaVersion: z.literal(CONFIG_SCHEMA_VERSION),
    id: z.string().regex(/^\d+\.\d+$/, 'expected <category>.<subtype>, e.g. 1.1'),
    name: nonEmpty,
    enabled: z.boolean(),
    sources: uniqueList(z.string().regex(/^D\d+$/, 'data source ids look like D1')),
    imageSources: uniqueList(z.string().regex(/^I\d+$/, 'image source ids look like I1')),
    channels: uniqueList(Channel).pipe(z.array(Channel).min(1)),
    schedule: Schedule,
    timezone: Timezone,
    phases: z.array(Phase).default([]),
    contentRules: ContentRules,
    imageRules: ImageRules,
    /** SMB never publishes unapproved content, so this cannot be switched off. */
    approvalRequired: z.literal(true),
    /** Lower runs first (same scale as jobs.priority). */
    priority: z.number().int().min(1).max(1000),
    deduplication: Deduplication,
    /** Optional tuning of story selection (module 1.6). Defaults apply when omitted. */
    storySelection: StorySelection.optional(),
    retryPolicy: RetryPolicy,
  })
  .strict()
  .superRefine((cfg, ctx) => {
    if (cfg.sources.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['sources'],
        message: 'at least one data source is required',
      });
    }
    if (cfg.imageRules.need !== 'none' && cfg.imageSources.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['imageSources'],
        message: 'imageRules.need is not "none" but no image sources are listed',
      });
    }
    const phaseIds = cfg.phases.map((p) => p.id);
    if (new Set(phaseIds).size !== phaseIds.length) {
      ctx.addIssue({ code: 'custom', path: ['phases'], message: 'phase ids must be unique' });
    }
  });
export type PostTypeConfig = z.infer<typeof PostTypeConfig>;

// ---------------------------------------------------------------------------------------------
// Runtime override (stored in the database, applied on top of the file config)
// ---------------------------------------------------------------------------------------------

/** The only things an operator can change at runtime. Everything else needs a reviewed config change. */
export const ConfigOverride = z
  .object({
    enabled: z.boolean().optional(),
    priority: z.number().int().min(1).max(1000).optional(),
    /** Must be a subset of the channels in the file config. */
    channels: uniqueList(Channel).pipe(z.array(Channel).min(1)).optional(),
    schedule: Schedule.optional(),
    contentRules: z
      .object({ restrictions: z.array(nonEmpty) })
      .strict()
      .optional(),
  })
  .strict()
  .refine((o) => Object.keys(o).length > 0, 'override is empty');
export type ConfigOverride = z.infer<typeof ConfigOverride>;
