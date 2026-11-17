import { AiError, type AiProvider, type AiResult, type AiSettings } from '../ai/provider.js';
import {
  REVISE,
  candidateTask,
  editorialTask,
  interpretTask,
  promptVersion,
  promptVersions,
  reviseTask,
  visualTask,
  type StageName,
} from './prompts.js';
import {
  APPROACHES,
  CandidateDraft,
  EditorialReview,
  GENERATION_SCHEMA_VERSION,
  KeyPoints,
  SLOTS,
  VisualPlan,
  type FeedbackNote,
  type GeneratedCandidate,
  type GenerationInput,
  type GenerationResult,
  type RevisionResult,
  type Slot,
  type ValidationIssue,
  type ValidationResult,
} from './schemas.js';
import { validateCandidate, validateVisualPlan, type OtherCandidate } from './validate.js';

export interface GenerationOptions {
  /** Per-stage overrides of temperature, seed and so on. */
  settings?: Partial<Record<StageName, AiSettings>>;
  /** Candidate-writing attempts per slot, including the first. Default 2: one regeneration. */
  maxAttempts?: number;
  now?: () => number;
}

/**
 * The whole generation step (module 1.7): interpret the facts, write the three candidates, validate each
 * (regenerating a failing one once with the problems fed back), review them and plan their visuals.
 * It takes any `AiProvider`, so the same code runs in the API with the stub and on the home PC with Ollama.
 * A candidate that still fails validation after its last attempt is returned flagged, never silently passed.
 */
export async function runGeneration(
  provider: AiProvider,
  input: GenerationInput,
  options: GenerationOptions = {},
): Promise<GenerationResult> {
  const now = options.now ?? Date.now;
  const started = now();
  const maxAttempts = Math.max(1, options.maxAttempts ?? 2);
  const used: Record<string, unknown> = {};
  const record = (stage: StageName, r: AiResult<unknown>): void => {
    used[stage] = r.settings;
  };

  const factKeys = new Set(input.facts.map((f) => f.key));
  const interpreted = await provider.generate(interpretTask(input, options.settings?.interpret));
  record('interpret', interpreted);
  // A point that cites a fact we do not have is dropped, not trusted.
  let keyPoints: KeyPoints = {
    ...interpreted.output,
    points: interpreted.output.points.filter((p) => p.claimKeys.every((k) => factKeys.has(k))),
  };
  if (keyPoints.points.length === 0) {
    keyPoints = {
      points: input.facts
        .slice(0, 4)
        .map((f) => ({ text: f.statement.slice(0, 300), claimKeys: [f.key] })),
      avoid: interpreted.output.avoid,
    };
  }

  const candidates: GeneratedCandidate[] = [];
  const written: OtherCandidate[] = [];

  for (const slot of SLOTS) {
    let feedback: ValidationIssue[] = [];
    let kept: { draft: CandidateDraft; validation: ValidationResult; attempts: number } | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let written1: AiResult<CandidateDraft>;
      try {
        written1 = await provider.generate(
          candidateTask(
            {
              input,
              slot,
              keyPoints,
              others: written.map((w) => ({
                slot: w.slot,
                headline: w.draft.headline,
                caption: w.draft.caption,
              })),
              feedback,
            },
            options.settings?.candidate,
          ),
        );
      } catch (err) {
        if (err instanceof AiError && err.code === 'invalid_output' && attempt < maxAttempts) {
          feedback = [
            { code: 'invalid_output', severity: 'error', field: 'output', message: err.message },
          ];
          continue;
        }
        throw err;
      }
      record('candidate', written1);
      const validation = validateCandidate(written1.output, input, written);
      kept = { draft: written1.output, validation, attempts: attempt };
      if (validation.passed) break;
      feedback = validation.issues;
    }
    if (!kept) throw new AiError('invalid_output', `candidate ${slot}: no usable output`, false);
    written.push({ slot, draft: kept.draft });

    const review = await provider.generate(
      editorialTask({ input, draft: kept.draft }, options.settings?.editorial),
    );
    record('editorial', review);

    let visualFeedback: ValidationIssue[] = [];
    let plan: { plan: VisualPlan; validation: ValidationResult } | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const visual = await provider.generate(
        visualTask(
          { input, draft: kept.draft, feedback: visualFeedback },
          options.settings?.visual,
        ),
      );
      record('visual', visual);
      const validation = validateVisualPlan(visual.output, input, kept.draft.claimKeys);
      plan = { plan: visual.output, validation };
      if (validation.passed) break;
      visualFeedback = validation.issues.filter((i) => i.severity === 'error');
    }

    candidates.push({
      slot,
      approach: APPROACHES[slot].id,
      draft: kept.draft,
      validation: kept.validation,
      editorial: review.output,
      visualPlan: plan!.plan,
      visualValidation: plan!.validation,
      attempts: kept.attempts,
    });
  }

  return {
    schemaVersion: GENERATION_SCHEMA_VERSION,
    angleId: input.angle.id,
    provider: provider.name,
    model: provider.model,
    promptVersions: promptVersions(),
    settings: used,
    interpretation: keyPoints,
    candidates,
    durationMs: now() - started,
  };
}

/**
 * The server's check of a result it did not produce itself (for example one returned by the home PC).
 * It re-parses every part against the schemas and recomputes all validation, so a worker that skipped
 * or misreported its own checks cannot get a bad candidate stored as passing. Throws on a malformed result.
 */
export function recheckGeneration(
  result: GenerationResult,
  input: GenerationInput,
): GenerationResult {
  if (result.schemaVersion !== GENERATION_SCHEMA_VERSION) {
    throw new Error(`unsupported generation result version ${String(result.schemaVersion)}`);
  }
  if (result.angleId !== input.angle.id) {
    throw new Error(`result is for angle ${result.angleId}, expected ${input.angle.id}`);
  }
  const slots = result.candidates.map((c) => c.slot);
  if (slots.join() !== SLOTS.join()) {
    throw new Error(`expected candidates ${SLOTS.join(',')}, got ${slots.join(',')}`);
  }
  const interpretation = KeyPoints.parse(result.interpretation);

  const others: OtherCandidate[] = [];
  const candidates = result.candidates.map((c): GeneratedCandidate => {
    const draft = CandidateDraft.parse(c.draft);
    const plan = VisualPlan.parse(c.visualPlan);
    const editorial = EditorialReview.parse(c.editorial);
    const validation = validateCandidate(draft, input, others);
    others.push({ slot: c.slot as Slot, draft });
    return {
      slot: c.slot,
      approach: APPROACHES[c.slot].id,
      draft,
      validation,
      editorial,
      visualPlan: plan,
      visualValidation: validateVisualPlan(plan, input, draft.claimKeys),
      attempts: c.attempts,
    };
  });
  return { ...result, interpretation, candidates };
}

// ---------------------------------------------------------------------------------------------
// Revision from reviewer feedback (module 1.12)
// ---------------------------------------------------------------------------------------------

export interface RevisionRequest {
  slot: Slot;
  /** The post as it stands. */
  current: CandidateDraft;
  /** What the reviewer asked for. */
  request: FeedbackNote;
  /** The other candidates of the same cycle, as they stand. */
  others: OtherCandidate[];
}

export interface RevisionOptions {
  settings?: AiSettings;
  /** Rewrite attempts, including the first. Default 2. */
  maxAttempts?: number;
  now?: () => number;
}

/**
 * Rewrites one candidate from a reviewer's feedback. The rewrite goes through the same deterministic checks
 * as a new candidate, and a failing one is tried once more with the problems fed back. A rewrite that still
 * fails is returned flagged, never silently passed.
 */
export async function runRevision(
  provider: AiProvider,
  input: GenerationInput,
  request: RevisionRequest,
  options: RevisionOptions = {},
): Promise<RevisionResult> {
  const now = options.now ?? Date.now;
  const started = now();
  const maxAttempts = Math.max(1, options.maxAttempts ?? 2);
  let feedback: ValidationIssue[] = [];
  let kept:
    | { draft: CandidateDraft; validation: ValidationResult; attempts: number; settings: unknown }
    | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let written: AiResult<CandidateDraft>;
    try {
      written = await provider.generate(
        reviseTask(
          {
            input,
            slot: request.slot,
            current: request.current,
            request: request.request,
            others: request.others.map((o) => ({
              slot: o.slot,
              headline: o.draft.headline,
              caption: o.draft.caption,
            })),
            feedback,
          },
          options.settings,
        ),
      );
    } catch (err) {
      if (err instanceof AiError && err.code === 'invalid_output' && attempt < maxAttempts) {
        feedback = [
          { code: 'invalid_output', severity: 'error', field: 'output', message: err.message },
        ];
        continue;
      }
      throw err;
    }
    const validation = validateCandidate(written.output, input, request.others);
    kept = { draft: written.output, validation, attempts: attempt, settings: written.settings };
    if (validation.passed) break;
    feedback = validation.issues;
  }
  if (!kept) throw new AiError('invalid_output', 'revision: no usable output', false);

  return {
    schemaVersion: GENERATION_SCHEMA_VERSION,
    slot: request.slot,
    provider: provider.name,
    model: provider.model,
    promptVersion: promptVersion(REVISE),
    settings: kept.settings,
    draft: kept.draft,
    validation: kept.validation,
    attempts: kept.attempts,
    durationMs: now() - started,
  };
}

/** The server's check of a rewrite it did not produce itself: re-parse it and run every check again. */
export function recheckRevision(
  result: RevisionResult,
  input: GenerationInput,
  others: OtherCandidate[],
): RevisionResult {
  if (result.schemaVersion !== GENERATION_SCHEMA_VERSION) {
    throw new Error(`unsupported revision result version ${String(result.schemaVersion)}`);
  }
  const draft = CandidateDraft.parse(result.draft);
  return { ...result, draft, validation: validateCandidate(draft, input, others) };
}
