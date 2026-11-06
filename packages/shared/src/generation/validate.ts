import { looksLikeInstruction } from './brief.js';
import type {
  BriefFact,
  CandidateDraft,
  GenerationInput,
  Slot,
  ValidationIssue,
  ValidationResult,
  VisualPlan,
} from './schemas.js';

/**
 * Deterministic checks on generated text (module 1.7). The model is never trusted to have kept to the
 * facts: every figure, score, name, quotation and claim of authority is checked here against the claims
 * the candidate cites. The server runs these again before storing anything, whoever produced the text.
 *
 * Known limits: figures written as words ("three"), country names and paraphrased results are not
 * checked; the editorial stage and the human reviewer cover those.
 */

/** Two captions at or above this trigram overlap are the same post reworded. */
export const MAX_CAPTION_SIMILARITY = 0.6;
/** X counts every link as this many characters. */
export const X_LINK_LENGTH = 23;

const MONTHS = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)';
const SCORE_RE = new RegExp(
  String.raw`(?<!\d\.|[\d\-–—/])(\d{1,2}(?:\.5)?|½)\s*[-–—]\s*(\d{1,2}(?:\.5)?|½)(?!\d|\.\d|\s*[-–—]\s*\d|\s*${MONTHS})`,
  'g',
);
const NUMBER_RE = /(?<![\w#.])\d+(?:[.,]\d+)?(?:st|nd|rd|th)?(?!\w)/g;
const URL_RE = /\bhttps?:\/\/[^\s)]+|\bwww\.[^\s)]+/gi;
const HANDLE_RE = /(?<![\w@])@\w{2,}/g;
const HASHTAG_RE = /#\w+/g;
const QUOTE_RE = /["“]([^"“”]{6,})["”]/g;

const issue = (
  code: string,
  severity: 'error' | 'warn',
  field: string,
  message: string,
): ValidationIssue => ({ code, severity, field, message });

const result = (issues: ValidationIssue[]): ValidationResult => ({
  passed: !issues.some((i) => i.severity === 'error'),
  issues,
});

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

function normalise(text: string): string {
  return text.replace(/1\/2/g, '½');
}

/** Score-like tokens such as "1-0", "2.5-1.5" and "½-½", normalised to one spelling. */
export function scoresIn(text: string): string[] {
  const out: string[] = [];
  for (const m of normalise(text).matchAll(SCORE_RE)) {
    out.push(`${m[1]}-${m[2]}`.replace(/½/g, '0.5'));
  }
  return out;
}

/** Plain numbers in a text, after score tokens, links and hashtags are taken out. */
export function numbersIn(text: string): number[] {
  const cleaned = normalise(text)
    .replace(URL_RE, ' ')
    .replace(HASHTAG_RE, ' ')
    .replace(SCORE_RE, ' ');
  return [...cleaned.matchAll(NUMBER_RE)].map((m) =>
    Number(m[0].replace(/(?:st|nd|rd|th)$/, '').replace(',', '.')),
  );
}

function jsonStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (typeof value === 'number') out.push(String(value));
  else if (Array.isArray(value)) value.forEach((x) => jsonStrings(x, out));
  else if (value && typeof value === 'object')
    Object.values(value).forEach((x) => jsonStrings(x, out));
  return out;
}

/** Everything a fact says, as one text: the sentence plus every value inside it. */
function factText(facts: BriefFact[]): string {
  return facts.map((f) => [f.statement, ...jsonStrings(f.value)].join(' ')).join(' \n ');
}

function trigrams(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (words.length < 3) return new Set(words);
  const out = new Set<string>();
  for (let i = 0; i + 2 < words.length; i++) out.add(words.slice(i, i + 3).join(' '));
  return out;
}

/** 0..1 word-trigram overlap of two captions. */
export function captionSimilarity(a: string, b: string): number {
  const x = trigrams(a);
  const y = trigrams(b);
  if (x.size === 0 || y.size === 0) return 0;
  let shared = 0;
  for (const t of x) if (y.has(t)) shared++;
  return shared / (x.size + y.size - shared);
}

/** Length as the channel counts it. X counts each link as a fixed length. */
export function channelLength(channel: string, text: string): number {
  const prepared = channel === 'x' ? text.replace(URL_RE, 'x'.repeat(X_LINK_LENGTH)) : text;
  return Array.from(prepared).length;
}

function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length]!;
}

// ---------------------------------------------------------------------------------------------
// Text rules
// ---------------------------------------------------------------------------------------------

interface TextContext {
  /** Facts the candidate cites: the only source for figures. */
  cited: BriefFact[];
  /** Every fact in the input: allowed for names, links and quotations. */
  all: BriefFact[];
}

const RATING_RE = /\b(?:ratings?|elo|rated)\b/i;
const TITLE_RE = /\b(?:GM|IM|FM|WGM|WIM|WFM|CM|NM)\b/g;
const ANNOUNCEMENT_RE = /\b(?:official(?:ly)?|announce[ds]?|confirm(?:s|ed)?)\b/i;
const PREDICTION_RE =
  /\b(?:will|is going to|are going to|set to|bound to|certain to)\s+(?:win|beat|lose|draw|clinch|retain|take|dominate|crush)\b/i;
const HEDGE_RE = /\b(?:could|might|may|possibly|perhaps|if|expected|predict\w*|forecast\w*)\b/i;
const FAVOURITE_RE = /\bfavou?rites?\b/i;

/** Checks one piece of text against the cited facts. */
function textIssues(field: string, text: string, ctx: TextContext): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const citedText = factText(ctx.cited);
  const allText = factText(ctx.all);
  const allLower = allText.toLowerCase();

  // Scores and results must be exactly one the facts give. "0-1" for a "1-0" is the classic error.
  const allowedScores = new Set(scoresIn(citedText));
  for (const s of new Set(scoresIn(text))) {
    if (!allowedScores.has(s)) {
      issues.push(
        issue('unsupported_score', 'error', field, `the score "${s}" is not in the cited facts`),
      );
    }
  }

  // Every other number must appear in a cited fact.
  const allowedNumbers = new Set([
    ...numbersIn(citedText),
    ...scoresIn(citedText).flatMap((s) => s.split('-').map(Number)),
  ]);
  for (const n of new Set(numbersIn(text))) {
    if (!allowedNumbers.has(n)) {
      issues.push(
        issue('unsupported_number', 'error', field, `the number ${n} is not in the cited facts`),
      );
    }
  }

  if (RATING_RE.test(text) && !ctx.cited.some((f) => f.key.startsWith('rating'))) {
    issues.push(
      issue(
        'unsupported_rating',
        'error',
        field,
        'mentions ratings but no cited fact provides one',
      ),
    );
  }

  for (const t of new Set(text.match(TITLE_RE) ?? [])) {
    if (!new RegExp(`\\b${t}\\b`).test(citedText)) {
      issues.push(
        issue('unsupported_title', 'error', field, `the title ${t} is not in the cited facts`),
      );
    }
  }

  for (const m of text.matchAll(QUOTE_RE)) {
    if (!allLower.includes((m[1] ?? '').toLowerCase())) {
      issues.push(
        issue('unsupported_quote', 'error', field, `the quotation "${m[1]}" is not in any fact`),
      );
    }
  }

  if (ANNOUNCEMENT_RE.test(text) && !ctx.cited.some((f) => f.verification === 'verified')) {
    issues.push(
      issue(
        'unsupported_announcement',
        'error',
        field,
        'claims something is official, announced or confirmed without a verified fact behind it',
      ),
    );
  }

  if (PREDICTION_RE.test(text)) {
    issues.push(
      HEDGE_RE.test(text)
        ? issue('prediction', 'warn', field, 'contains a prediction; make sure it reads as one')
        : issue('prediction_as_fact', 'error', field, 'states a prediction as if it were a fact'),
    );
  } else if (FAVOURITE_RE.test(text)) {
    issues.push(
      issue('prediction', 'warn', field, 'calls a player the favourite; this is an opinion'),
    );
  }

  for (const u of text.match(URL_RE) ?? []) {
    if (!allLower.includes(u.toLowerCase().replace(/[.,;:!?]+$/, ''))) {
      issues.push(issue('unsupported_link', 'error', field, `the link ${u} is not in any fact`));
    }
  }
  for (const h of new Set(text.match(HANDLE_RE) ?? [])) {
    if (!allLower.includes(h.toLowerCase())) {
      issues.push(
        issue('unsupported_handle', 'error', field, `the handle ${h} is not in any fact`),
      );
    }
  }

  if (looksLikeInstruction(text)) {
    issues.push(
      issue(
        'instruction_echo',
        'error',
        field,
        'contains instruction-like text from the source data',
      ),
    );
  }

  // Names: a near miss of a known name is probably a misspelling.
  const known = new Set(allText.match(/\b\p{Lu}\p{L}{3,}\b/gu) ?? []);
  for (const w of new Set(text.match(/\b\p{Lu}\p{L}{4,}\b/gu) ?? [])) {
    if (known.has(w)) continue;
    const near = [...known].find((k) => editDistance(w.toLowerCase(), k.toLowerCase()) <= 2);
    if (near) {
      issues.push(
        issue('name_variant', 'warn', field, `"${w}" looks like a misspelling of "${near}"`),
      );
    }
  }
  return issues;
}

function contextFor(
  input: GenerationInput,
  claimKeys: string[],
): {
  ctx: TextContext;
  issues: ValidationIssue[];
} {
  const issues: ValidationIssue[] = [];
  const byKey = new Map(input.facts.map((f) => [f.key, f]));
  const cited: BriefFact[] = [];
  for (const key of new Set(claimKeys)) {
    const fact = byKey.get(key);
    if (fact) cited.push(fact);
    else {
      issues.push(
        issue(
          'unknown_claim',
          'error',
          'claimKeys',
          `"${key}" is not a publishable fact for this post`,
        ),
      );
    }
  }
  return { ctx: { cited, all: input.facts }, issues };
}

// ---------------------------------------------------------------------------------------------
// Public checks
// ---------------------------------------------------------------------------------------------

export interface OtherCandidate {
  slot: Slot;
  draft: CandidateDraft;
}

/** Checks a candidate on its own, against the other candidates, and against the channels. */
export function validateCandidate(
  draft: CandidateDraft,
  input: GenerationInput,
  others: OtherCandidate[] = [],
): ValidationResult {
  const { ctx, issues } = contextFor(input, draft.claimKeys);
  if (ctx.cited.length === 0) {
    issues.push(issue('no_citation', 'error', 'claimKeys', 'cites no usable fact'));
  } else if (
    input.angle.requiredFacts.length > 0 &&
    !input.angle.requiredFacts.some((k) => ctx.cited.some((f) => f.key === k))
  ) {
    issues.push(
      issue(
        'angle_not_cited',
        'warn',
        'claimKeys',
        `cites none of the angle's facts (${input.angle.requiredFacts.join(', ')})`,
      ),
    );
  }

  const fields: [string, string][] = [
    ['headline', draft.headline],
    ['caption', draft.caption],
    ...Object.entries(draft.channelTexts).map(([ch, t]): [string, string] => [
      `channelTexts.${ch}`,
      t ?? '',
    ]),
  ];
  for (const [field, text] of fields) issues.push(...textIssues(field, text, ctx));

  for (const spec of input.channels) {
    const text = draft.channelTexts[spec.id];
    if (!text) {
      issues.push(
        issue('missing_channel_text', 'error', `channelTexts.${spec.id}`, `no text for ${spec.id}`),
      );
      continue;
    }
    const length = channelLength(spec.id, text);
    if (length > spec.maxTextLength) {
      issues.push(
        issue(
          'too_long',
          'error',
          `channelTexts.${spec.id}`,
          `${length} characters; ${spec.id} allows ${spec.maxTextLength}`,
        ),
      );
    }
  }

  for (const other of others) {
    const same = other.draft.headline.trim().toLowerCase() === draft.headline.trim().toLowerCase();
    const sim = captionSimilarity(draft.caption, other.draft.caption);
    if (same || sim >= MAX_CAPTION_SIMILARITY) {
      issues.push(
        issue(
          'not_distinct',
          'error',
          'caption',
          `too similar to candidate ${other.slot} (${Math.round(sim * 100)}% overlap${same ? ', same headline' : ''}); write a clearly different post`,
        ),
      );
    }
  }
  return result(issues);
}

/** Checks the visual plan: an allowed template, alt text where a channel needs it, and honest alt text. */
export function validateVisualPlan(
  plan: VisualPlan,
  input: GenerationInput,
  claimKeys: string[],
): ValidationResult {
  const { ctx } = contextFor(input, claimKeys);
  const issues: ValidationIssue[] = [];
  if (!input.allowedTemplates.includes(plan.template)) {
    issues.push(
      issue(
        'bad_template',
        'error',
        'template',
        `"${plan.template}" is not one of ${input.allowedTemplates.join(', ')}`,
      ),
    );
  }
  if (input.channels.some((c) => c.altTextRequired) && plan.altText.trim().length === 0) {
    issues.push(issue('missing_alt_text', 'error', 'altText', 'a channel requires alt text'));
  }
  issues.push(...textIssues('altText', plan.altText, ctx));
  for (const [i, line] of plan.composition.entries()) {
    issues.push(...textIssues(`composition.${i}`, line, ctx).filter((x) => x.severity === 'error'));
  }
  return result(issues);
}
