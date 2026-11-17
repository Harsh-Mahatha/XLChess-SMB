/**
 * Reviewer feedback vocabulary (module 1.12). Tags say what was wrong with a post in a form that can be
 * counted; each belongs to one category and is either a factual correction or a creative improvement, the
 * distinction the Feature Definition asks for. A tag that is not listed here is still accepted and stored,
 * and is counted under `other`, so the list can grow from what reviewers actually write.
 */
export const FEEDBACK_CATEGORIES = [
  'factual',
  'wording',
  'tone',
  'headline',
  'image',
  'layout',
  'angle',
  'timing',
  'other',
] as const;
export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];

export interface FeedbackTagDefinition {
  category: FeedbackCategory;
  /** True for a correction of something that was wrong, false for a matter of taste. */
  factual: boolean;
  description: string;
}

const tag = (
  category: FeedbackCategory,
  factual: boolean,
  description: string,
): FeedbackTagDefinition => ({ category, factual, description });

export const FEEDBACK_TAGS = {
  wrong_fact: tag('factual', true, 'A statement is wrong'),
  wrong_figure: tag('factual', true, 'A score, rating, date or other figure is wrong'),
  wrong_name: tag('factual', true, 'A name or title is wrong or misspelt'),
  unsupported_claim: tag('factual', true, 'Says something the sources do not support'),
  outdated: tag('factual', true, 'True when written, no longer true'),
  misleading_headline: tag('headline', true, 'The headline says more than the facts do'),
  weak_headline: tag('headline', false, 'The headline is flat or unclear'),
  wording: tag('wording', false, 'Awkward or unclear wording'),
  grammar: tag('wording', false, 'Grammar, spelling or punctuation'),
  too_long: tag('wording', false, 'Too long'),
  too_short: tag('wording', false, 'Too short, missing context'),
  repetitive: tag('wording', false, 'Repeats itself or an earlier post'),
  tone: tag('tone', false, 'The tone is wrong for the audience'),
  too_promotional: tag('tone', false, 'Reads like an advert'),
  too_dry: tag('tone', false, 'Correct but dull'),
  wrong_image: tag('image', true, 'The picture shows the wrong person, event or place'),
  image_quality: tag('image', false, 'The picture is poor quality'),
  image_crop: tag('image', false, 'The picture is badly cropped'),
  layout: tag('layout', false, 'The layout of the graphic needs work'),
  visual_hierarchy: tag('layout', false, 'The wrong thing stands out in the graphic'),
  wrong_angle: tag('angle', false, 'A different story should be told'),
  not_newsworthy: tag('angle', false, 'Not worth posting'),
  duplicate_story: tag('angle', false, 'We already posted this'),
  bad_timing: tag('timing', false, 'Right post, wrong moment'),
} as const satisfies Record<string, FeedbackTagDefinition>;
export type FeedbackTag = keyof typeof FEEDBACK_TAGS;

/** The tag that asks for a different story when it is sent with a regeneration request. */
export const WRONG_ANGLE_TAG: FeedbackTag = 'wrong_angle';

/** Tags the system writes itself. They are not feedback and are left out of the figures. */
export const SYSTEM_TAGS: readonly string[] = ['approval_withdrawn', 'reopen'];

/** "Wrong Fact", "wrong-fact" and " wrong_fact " are the same tag. */
export function normaliseTag(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

export function normaliseTags(raw: readonly string[] | undefined): string[] {
  return [...new Set((raw ?? []).map(normaliseTag).filter(Boolean))];
}

export function tagDefinition(name: string): FeedbackTagDefinition | undefined {
  return Object.hasOwn(FEEDBACK_TAGS, name) ? FEEDBACK_TAGS[name as FeedbackTag] : undefined;
}

export function categoryOfTag(name: string): FeedbackCategory {
  return tagDefinition(name)?.category ?? 'other';
}

export const CHANGE_KINDS = ['factual', 'creative', 'mixed'] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

/**
 * Whether an edit was a factual correction, a creative improvement or both. What the reviewer said wins;
 * otherwise it follows from the tags. Returns null when neither tells us, and the edit is reported as
 * unclassified, never guessed.
 */
export function classifyChange(
  stated: ChangeKind | undefined,
  tags: readonly string[],
): ChangeKind | null {
  if (stated) return stated;
  const known = tags.flatMap((t) => tagDefinition(t) ?? []);
  if (known.length === 0) return null;
  const factual = known.some((d) => d.factual);
  const creative = known.some((d) => !d.factual);
  return factual && creative ? 'mixed' : factual ? 'factual' : 'creative';
}

export interface RevisionText {
  headline: string | null;
  caption: string;
  channelTexts: Record<string, string>;
  altText: string | null;
}

/** The fields that differ between two revisions: `headline`, `caption`, `altText`, `channel:<id>`. */
export function changedFields(before: RevisionText, after: RevisionText): string[] {
  const out: string[] = [];
  if ((before.headline ?? '') !== (after.headline ?? '')) out.push('headline');
  if (before.caption !== after.caption) out.push('caption');
  if ((before.altText ?? '') !== (after.altText ?? '')) out.push('altText');
  const channels = new Set([
    ...Object.keys(before.channelTexts),
    ...Object.keys(after.channelTexts),
  ]);
  for (const id of [...channels].sort()) {
    if (before.channelTexts[id] !== after.channelTexts[id]) out.push(`channel:${id}`);
  }
  return out;
}
