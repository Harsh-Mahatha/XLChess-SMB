import { z } from 'zod';
import { Channel, ClaimVerification } from '../domain/index.js';

/** Bump when the shape of a generation input or result changes incompatibly. */
export const GENERATION_SCHEMA_VERSION = 1;

export const SLOTS = ['A', 'B', 'C'] as const;
export const Slot = z.enum(SLOTS);
export type Slot = z.infer<typeof Slot>;

/** The three approaches the Feature Definition asks for. */
export const APPROACHES: Record<Slot, { id: string; instruction: string }> = {
  A: {
    id: 'factual',
    instruction:
      'Factual and informative. Lead with the most important verified facts, plainly and precisely. No hype.',
  },
  B: {
    id: 'narrative',
    instruction:
      'A strong headline and a compelling narrative. Tell the story the facts add up to, without adding any fact.',
  },
  C: {
    id: 'engagement',
    instruction:
      'Engagement-focused: open with a question or a comparison that invites replies, then ground it in the verified facts.',
  },
};

// ---------------------------------------------------------------------------------------------
// Input (built from the database by the server; sent to whoever runs the model)
// ---------------------------------------------------------------------------------------------

export const BriefFact = z
  .object({
    /** The claim key the candidate cites, for example "game.result". */
    key: z.string().min(1),
    description: z.string(),
    /** One plain sentence rendered by code from `value`. The model should prefer it to the raw value. */
    statement: z.string().min(1),
    value: z.unknown(),
    verification: ClaimVerification,
    eventTime: z.string().optional(),
  })
  .strict();
export type BriefFact = z.infer<typeof BriefFact>;

export const ChannelSpec = z
  .object({
    id: Channel,
    maxTextLength: z.number().int().positive(),
    altTextRequired: z.boolean(),
    mediaRequired: z.boolean(),
  })
  .strict();
export type ChannelSpec = z.infer<typeof ChannelSpec>;

export const GenerationInput = z
  .object({
    schemaVersion: z.literal(GENERATION_SCHEMA_VERSION),
    postType: z.string(),
    opportunityId: z.string(),
    packageId: z.string(),
    phase: z.string().nullable(),
    angle: z
      .object({
        id: z.string(),
        description: z.string(),
        requiredFacts: z.array(z.string()),
      })
      .strict(),
    /** Only claims that meet their verification level, and that passed the injection screen. */
    facts: z.array(BriefFact).min(1),
    contentRules: z
      .object({
        tone: z.string(),
        structure: z.array(z.string()),
        restrictions: z.array(z.string()),
      })
      .strict(),
    channels: z.array(ChannelSpec).min(1),
    imageRules: z
      .object({
        need: z.enum(['required', 'preferred', 'none']),
        preferOriginalPhoto: z.boolean(),
        template: z.string().optional(),
        composition: z.array(z.string()),
      })
      .strict(),
    /** Visual templates the plan may choose from. */
    allowedTemplates: z.array(z.string()).min(1),
    /** Things the builder left out or flagged, for example a claim that looked like an instruction. */
    warnings: z.array(z.string()),
  })
  .strict();
export type GenerationInput = z.infer<typeof GenerationInput>;

// ---------------------------------------------------------------------------------------------
// Stage outputs (what the model returns; every one is validated)
// ---------------------------------------------------------------------------------------------

export const KeyPoints = z
  .object({
    points: z
      .array(
        z
          .object({
            text: z.string().min(1).max(300),
            claimKeys: z.array(z.string()).min(1),
          })
          .strict(),
      )
      .min(1)
      .max(8),
    /** Things the posts should not say, for example because the evidence is missing. */
    avoid: z.array(z.string()).max(8),
  })
  .strict();
export type KeyPoints = z.infer<typeof KeyPoints>;

export const ChannelTexts = z
  .object({
    x: z.string().min(1).optional(),
    facebook: z.string().min(1).optional(),
    instagram: z.string().min(1).optional(),
    discord: z.string().min(1).optional(),
  })
  .strict();
export type ChannelTexts = z.infer<typeof ChannelTexts>;

export const CandidateDraft = z
  .object({
    headline: z.string().min(1).max(140),
    caption: z.string().min(1).max(2000),
    channelTexts: ChannelTexts,
    /** Every claim the text relies on. The validator checks the text against exactly these. */
    claimKeys: z.array(z.string().min(1)).min(1).max(12),
    hashtags: z.array(z.string().regex(/^#\w{2,40}$/)).max(5),
    visualTemplate: z.string().optional(),
  })
  .strict();
export type CandidateDraft = z.infer<typeof CandidateDraft>;

export const EditorialReview = z
  .object({
    verdict: z.enum(['pass', 'revise']),
    issues: z
      .array(
        z
          .object({
            severity: z.enum(['error', 'warn']),
            field: z.string(),
            message: z.string().max(400),
          })
          .strict(),
      )
      .max(10),
  })
  .strict();
export type EditorialReview = z.infer<typeof EditorialReview>;

export const VisualPlan = z
  .object({
    template: z.string().min(1),
    composition: z.array(z.string().min(1)).max(6),
    altText: z.string().max(1000),
  })
  .strict();
export type VisualPlan = z.infer<typeof VisualPlan>;

// ---------------------------------------------------------------------------------------------
// Validation and result
// ---------------------------------------------------------------------------------------------

export interface ValidationIssue {
  code: string;
  severity: 'error' | 'warn';
  field: string;
  message: string;
}

export interface ValidationResult {
  /** True when there is no `error` issue. */
  passed: boolean;
  issues: ValidationIssue[];
}

export interface GeneratedCandidate {
  slot: Slot;
  approach: string;
  draft: CandidateDraft;
  validation: ValidationResult;
  editorial: EditorialReview;
  visualPlan: VisualPlan;
  visualValidation: ValidationResult;
  /** Candidate-writing attempts used (2 means the first one failed validation). */
  attempts: number;
}

export interface GenerationResult {
  schemaVersion: typeof GENERATION_SCHEMA_VERSION;
  angleId: string;
  provider: string;
  model: string;
  /** Stage name to prompt version. */
  promptVersions: Record<string, string>;
  /** Settings actually used per stage. */
  settings: Record<string, unknown>;
  interpretation: KeyPoints;
  candidates: GeneratedCandidate[];
  durationMs: number;
}
