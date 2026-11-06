import type {
  CandidateInput,
  InterpretInput,
  VisualInput,
} from '../generation/prompts.js';
import type {
  CandidateDraft,
  EditorialReview,
  KeyPoints,
  VisualPlan,
} from '../generation/schemas.js';
import {
  AiError,
  type AiProvider,
  type AiResult,
  type AiSettings,
  type AiTask,
} from './provider.js';

/** Produces the raw answer for a task. `call` counts calls to the same stage, from 1. */
export type StubHandler = (task: AiTask<unknown>, call: number) => unknown;

export interface StubOptions {
  model?: string;
  /** Replace the answer for a stage, for example to simulate a model that invents a score. */
  handlers?: Partial<Record<string, StubHandler>>;
}

const stripDot = (s: string): string => s.replace(/[.\s]+$/, '');

/** Cuts a text to a limit at a sentence, then a word, boundary. */
function fit(text: string, max: number): string {
  if (Array.from(text).length <= max) return text;
  const sentences = text.split(/(?<=\.)\s+/);
  let out = '';
  for (const s of sentences) {
    const next = out ? `${out} ${s}` : s;
    if (Array.from(next).length > max) break;
    out = next;
  }
  if (out) return out;
  const words = text.split(/\s+/);
  out = '';
  for (const w of words) {
    const next = out ? `${out} ${w}` : w;
    if (Array.from(next).length > max - 1) break;
    out = next;
  }
  return `${out}…`;
}

function interpret(task: AiTask<unknown>): KeyPoints {
  const { input } = task.input as InterpretInput;
  return {
    points: input.facts
      .slice(0, 4)
      .map((f) => ({ text: stripDot(f.statement), claimKeys: [f.key] })),
    avoid: [],
  };
}

const WRAPPERS = {
  A: (body: string) => `Verified facts: ${body}.`,
  B: (body: string) =>
    `Look closely at this one. ${body}. That is the story so far, and every detail comes straight from the record.`,
  C: (body: string) =>
    `What do you make of this? ${body}. Tell us in the replies whether it changes how you see the event.`,
} as const;

function candidate(task: AiTask<unknown>): CandidateDraft {
  const { input, slot } = task.input as CandidateInput;
  const preferred = input.facts.filter((f) => input.angle.requiredFacts.includes(f.key));
  const pool = preferred.length > 0 ? preferred : input.facts;
  // Different slots lean on different facts so the three posts differ in substance, not only wording.
  const used =
    slot === 'A' ? pool.slice(0, 2) : slot === 'B' ? pool.slice(-2).reverse() : pool.slice(0, 1);
  const body = used.map((f) => stripDot(f.statement)).join('. ');
  const caption = WRAPPERS[slot](body);
  const headline =
    slot === 'A'
      ? stripDot(used[0]!.statement).slice(0, 120)
      : slot === 'B'
        ? 'What the record shows'
        : 'Your view on this one?';
  const channelTexts: Record<string, string> = {};
  for (const ch of input.channels) channelTexts[ch.id] = fit(caption, ch.maxTextLength);
  return {
    headline,
    caption,
    channelTexts,
    claimKeys: used.map((f) => f.key),
    hashtags: ['#Chess'],
  };
}

function editorial(): EditorialReview {
  return { verdict: 'pass', issues: [] };
}

function visual(task: AiTask<unknown>): VisualPlan {
  const { input, draft } = task.input as VisualInput;
  return {
    template: input.allowedTemplates[0]!,
    composition: input.imageRules.composition.slice(0, 3),
    altText: `Graphic for the post: ${draft.headline}`,
  };
}

const DEFAULTS: Record<string, StubHandler> = {
  interpret,
  candidate,
  editorial: () => editorial(),
  visual,
};

/**
 * A deterministic provider for development and tests. It builds its answers from the structured task
 * input, only from the facts it is given, so the whole pipeline can run without a model. Replace a
 * stage's handler to simulate a model that misbehaves. Its answers are checked against the task schema
 * exactly like a real provider's.
 */
export class StubProvider implements AiProvider {
  readonly name = 'stub';
  readonly model: string;
  private readonly handlers: Partial<Record<string, StubHandler>>;
  private readonly counts = new Map<string, number>();
  /** Every task received, in order. */
  readonly calls: { task: string; promptVersion: string }[] = [];

  constructor(options: StubOptions = {}) {
    this.model = options.model ?? 'stub-1';
    this.handlers = options.handlers ?? {};
  }

  async generate<T>(task: AiTask<T>): Promise<AiResult<T>> {
    const call = (this.counts.get(task.name) ?? 0) + 1;
    this.counts.set(task.name, call);
    this.calls.push({ task: task.name, promptVersion: task.promptVersion });

    const handler = this.handlers[task.name] ?? DEFAULTS[task.name];
    if (!handler)
      throw new AiError('bad_response', `stub has no handler for "${task.name}"`, false);
    const raw = handler(task as AiTask<unknown>, call);
    const checked = task.schema.safeParse(raw);
    if (!checked.success) {
      const why = checked.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      throw new AiError('invalid_output', `${task.name}: ${why}`, false);
    }
    const settings: AiSettings = { ...task.settings };
    return {
      output: checked.data,
      provider: this.name,
      model: this.model,
      settings,
      durationMs: 0,
      repaired: false,
    };
  }
}
export const STUB_HANDLERS: Readonly<Record<string, StubHandler>> = DEFAULTS;
