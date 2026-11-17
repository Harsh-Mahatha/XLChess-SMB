import { Prisma, type PrismaClient } from '@prisma/client';
import {
  FEEDBACK_CATEGORIES,
  FEEDBACK_TAGS,
  SYSTEM_TAGS,
  categoryOfTag,
  changedFields,
  normaliseTag,
  tagDefinition,
  type ChangeKind,
  type FeedbackCategory,
} from '@smb/shared';

/**
 * Feedback learning (module 1.12): how often generated posts are accepted as written, what reviewers keep
 * correcting, and the corrections themselves, by post type. Everything is computed on read from the review
 * records (`smb.review_outcomes` and the tables behind it), so there is one source of truth and a changed
 * definition never leaves stale figures behind.
 *
 * Rates use every decided opportunity as the denominator, approved and rejected alike: a rejected post counts
 * against the unedited-approval rate, it is never left out.
 */

export interface Period {
  from?: Date;
  to?: Date;
  postType?: string;
}

export interface OutcomeCounts {
  /** Opportunities that reached review in the period. */
  reviewed: number;
  /** Approved or rejected. The denominator of every rate. */
  decided: number;
  approved: number;
  /** Approved with the text exactly as the model first wrote it. */
  approvedUnedited: number;
  /** Approved unedited from the first set of candidates: no regeneration either. */
  firstPass: number;
  rejected: number;
  /** Still waiting for a decision (in review, deferred, or being written or researched again). */
  pending: number;
  regenerations: number;
  reviseRequests: number;
  researchRequests: number;
  humanEdits: number;
  factualEdits: number;
  creativeEdits: number;
  unclassifiedEdits: number;
  /** Decided opportunities in which a person corrected at least one fact. */
  withFactualCorrection: number;
  /** approvedUnedited / decided. Null when nothing has been decided. */
  uneditedApprovalRate: number | null;
  firstPassRate: number | null;
  rejectionRate: number | null;
  factualCorrectionRate: number | null;
  /** regenerations / reviewed. */
  averageRegenerations: number | null;
  /** Mean time from "ready for review" to the decision. Elapsed time, not time spent reading. */
  averageSecondsToDecision: number | null;
}

export interface TagCount {
  tag: string;
  category: FeedbackCategory;
  /** True for a factual correction, false for a creative one, null for a tag outside the vocabulary. */
  factual: boolean | null;
  count: number;
  /** Where it was used: reject, defer, regenerate, request_research, revise, edit. */
  bySource: Record<string, number>;
}

export interface PostTypeSummary extends OutcomeCounts {
  postType: string;
  /** The same figures split by the candidate prompt version, to see whether a prompt change helped. */
  byPromptVersion: (OutcomeCounts & { promptVersion: string })[];
  /** What reviewers flagged, most frequent first. */
  tags: TagCount[];
  /** Stories reviewers turned down (a rejection, or a regeneration tagged `wrong_angle`). */
  rejectedAngles: { angle: string; count: number }[];
}

export interface FeedbackSummary {
  period: { from: string | null; to: string | null };
  totals: OutcomeCounts;
  postTypes: PostTypeSummary[];
}

interface CountRow {
  post_type_id: string;
  prompt_version: string | null;
  reviewed: number;
  approved: number;
  approved_unedited: number;
  first_pass: number;
  rejected: number;
  pending: number;
  regenerations: number;
  revise_requests: number;
  research_requests: number;
  human_edits: number;
  factual_edits: number;
  creative_edits: number;
  unclassified_edits: number;
  with_factual_correction: number;
  decision_seconds: number | null;
  decisions_timed: number;
}

const ratio = (n: number, d: number): number | null =>
  d > 0 ? Math.round((n / d) * 1000) / 1000 : null;

function counts(rows: CountRow[]): OutcomeCounts {
  const sum = (pick: (r: CountRow) => number): number => rows.reduce((s, r) => s + pick(r), 0);
  const approved = sum((r) => r.approved);
  const rejected = sum((r) => r.rejected);
  const decided = approved + rejected;
  const reviewed = sum((r) => r.reviewed);
  const approvedUnedited = sum((r) => r.approved_unedited);
  const firstPass = sum((r) => r.first_pass);
  const regenerations = sum((r) => r.regenerations);
  const withFactualCorrection = sum((r) => r.with_factual_correction);
  const timed = sum((r) => r.decisions_timed);
  const seconds = sum((r) => Number(r.decision_seconds ?? 0));
  return {
    reviewed,
    decided,
    approved,
    approvedUnedited,
    firstPass,
    rejected,
    pending: sum((r) => r.pending),
    regenerations,
    reviseRequests: sum((r) => r.revise_requests),
    researchRequests: sum((r) => r.research_requests),
    humanEdits: sum((r) => r.human_edits),
    factualEdits: sum((r) => r.factual_edits),
    creativeEdits: sum((r) => r.creative_edits),
    unclassifiedEdits: sum((r) => r.unclassified_edits),
    withFactualCorrection,
    uneditedApprovalRate: ratio(approvedUnedited, decided),
    firstPassRate: ratio(firstPass, decided),
    rejectionRate: ratio(rejected, decided),
    factualCorrectionRate: ratio(withFactualCorrection, decided),
    averageRegenerations: ratio(regenerations, reviewed),
    averageSecondsToDecision: timed > 0 ? Math.round(seconds / timed) : null,
  };
}

/** The opportunities a report covers: those that became ready for review inside the period. */
function inPeriod(p: Period): Prisma.Sql {
  return Prisma.sql`
    (${p.from ?? null}::timestamptz is null or o.first_ready_at >= ${p.from ?? null}::timestamptz)
    and (${p.to ?? null}::timestamptz is null or o.first_ready_at < ${p.to ?? null}::timestamptz)
    and (${p.postType ?? null}::text is null or o.post_type_id = ${p.postType ?? null}::text)`;
}

/** Acceptance and correction figures per post type. */
export async function feedbackSummary(
  db: PrismaClient,
  period: Period = {},
): Promise<FeedbackSummary> {
  const where = inPeriod(period);
  const rows = await db.$queryRaw<CountRow[]>`
    select
      o.post_type_id,
      o.prompt_version,
      count(*)::int                                                              as reviewed,
      count(*) filter (where o.outcome = 'approved')::int                        as approved,
      count(*) filter (where o.approved_unedited)::int                           as approved_unedited,
      count(*) filter (where o.approved_unedited and o.regenerations = 0)::int   as first_pass,
      count(*) filter (where o.outcome = 'rejected')::int                        as rejected,
      count(*) filter (where o.outcome = 'pending')::int                         as pending,
      coalesce(sum(o.regenerations), 0)::int                                     as regenerations,
      coalesce(sum(o.revise_requests), 0)::int                                   as revise_requests,
      coalesce(sum(o.research_requests), 0)::int                                 as research_requests,
      coalesce(sum(o.human_edits), 0)::int                                       as human_edits,
      coalesce(sum(o.factual_edits), 0)::int                                     as factual_edits,
      coalesce(sum(o.creative_edits), 0)::int                                    as creative_edits,
      coalesce(sum(o.unclassified_edits), 0)::int                                as unclassified_edits,
      count(*) filter (where o.outcome in ('approved', 'rejected') and o.factual_edits > 0)::int
                                                                                 as with_factual_correction,
      coalesce(sum(extract(epoch from o.decided_at - o.first_ready_at))
        filter (where o.decided_at is not null), 0)::float8                      as decision_seconds,
      count(*) filter (where o.decided_at is not null)::int                      as decisions_timed
    from smb.review_outcomes o
    where ${where}
    group by o.post_type_id, o.prompt_version
    order by o.post_type_id, o.prompt_version`;

  const tagRows = await db.$queryRaw<
    { post_type_id: string; tag: string; source: string; count: number }[]
  >`
    select o.post_type_id, t.tag, t.source, count(*)::int as count
    from (
      select a.opportunity_id, unnest(a.feedback_tags) as tag, a.action::text as source
      from smb.review_actions a
      where a.action in ('reject', 'defer', 'regenerate', 'request_research', 'revise')
      union all
      select c.opportunity_id, unnest(r.change_tags) as tag, 'edit' as source
      from smb.post_revisions r
      join smb.post_candidates c on c.id = r.candidate_id
      where r.author_kind = 'human'
    ) t
    join smb.review_outcomes o on o.opportunity_id = t.opportunity_id
    where ${where}
    group by o.post_type_id, t.tag, t.source`;

  const angleRows = await db.$queryRaw<{ post_type_id: string; angle: string; count: number }[]>`
    select o.post_type_id, x.angle, count(*)::int as count
    from (
      select a.opportunity_id, coalesce(c.angle, lc.angle) as angle
      from smb.review_actions a
      left join smb.post_candidates c on c.id = a.candidate_id
      left join lateral (
        select pc.angle from smb.post_candidates pc
        where pc.opportunity_id = a.opportunity_id and pc.created_at <= a.created_at
        order by pc.generation_cycle desc limit 1
      ) lc on true
      where a.action = 'reject' or (a.action = 'regenerate' and 'wrong_angle' = any (a.feedback_tags))
    ) x
    join smb.review_outcomes o on o.opportunity_id = x.opportunity_id
    where x.angle is not null and ${where}
    group by o.post_type_id, x.angle
    order by count(*) desc, x.angle`;

  const postTypes = [...new Set(rows.map((r) => r.post_type_id))].map(
    (postType): PostTypeSummary => {
      const mine = rows.filter((r) => r.post_type_id === postType);
      const tags = new Map<string, TagCount>();
      for (const t of tagRows.filter((r) => r.post_type_id === postType)) {
        const name = normaliseTag(t.tag);
        if (!name || SYSTEM_TAGS.includes(name)) continue;
        const entry = tags.get(name) ?? {
          tag: name,
          category: categoryOfTag(name),
          factual: tagDefinition(name)?.factual ?? null,
          count: 0,
          bySource: {},
        };
        entry.count += t.count;
        entry.bySource[t.source] = (entry.bySource[t.source] ?? 0) + t.count;
        tags.set(name, entry);
      }
      return {
        postType,
        ...counts(mine),
        byPromptVersion: mine.map((r) => ({
          promptVersion: r.prompt_version ?? 'unknown',
          ...counts([r]),
        })),
        tags: [...tags.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)),
        rejectedAngles: angleRows
          .filter((r) => r.post_type_id === postType)
          .map((r) => ({ angle: r.angle, count: r.count })),
      };
    },
  );

  return {
    period: { from: period.from?.toISOString() ?? null, to: period.to?.toISOString() ?? null },
    totals: counts(rows),
    postTypes,
  };
}

// ---------------------------------------------------------------------------------------------------------
// The corrections themselves
// ---------------------------------------------------------------------------------------------------------

export interface EditCorrection {
  revisionId: string;
  opportunityId: string;
  candidateId: string;
  postType: string;
  slot: string;
  approach: string | null;
  angle: string | null;
  promptVersion: string;
  model: string | null;
  reviewerId: string | null;
  at: string;
  kind: ChangeKind | null;
  tags: string[];
  note: string | null;
  /** Each field that changed, before and after. */
  changes: { field: string; before: string | null; after: string | null }[];
}

export interface FeedbackItem {
  actionId: string;
  action: string;
  opportunityId: string;
  candidateId: string | null;
  postType: string;
  slot: string | null;
  angle: string | null;
  promptVersion: string | null;
  reviewerId: string;
  at: string;
  feedback: string | null;
  tags: string[];
  /** The post the feedback was about, when the reviewer pointed at one. */
  about: { headline: string | null; caption: string } | null;
}

export interface Corrections {
  edits: EditCorrection[];
  feedback: FeedbackItem[];
}

export interface CorrectionsFilter extends Period {
  kind?: ChangeKind | 'unclassified';
  tag?: string;
  limit?: number;
}

interface EditRow {
  id: string;
  created_at: Date;
  author_id: string | null;
  change_kind: string | null;
  change_tags: string[];
  change_note: string | null;
  candidate_id: string;
  slot: string;
  approach: string | null;
  angle: string | null;
  prompt_version: string;
  model: string | null;
  opportunity_id: string;
  post_type_id: string;
  before_headline: string | null;
  after_headline: string | null;
  before_caption: string;
  after_caption: string;
  before_channels: unknown;
  after_channels: unknown;
  before_alt: string | null;
  after_alt: string | null;
}

function stringMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) if (typeof v === 'string') out[k] = v;
  }
  return out;
}

/**
 * What reviewers changed and said, newest first: every edit by a person with the text before and after, and
 * every piece of feedback given with a reject, defer, regenerate, research request or rewrite request. This
 * is the material a developer reads before revising a prompt, a template or a post-type configuration.
 */
export async function feedbackCorrections(
  db: PrismaClient,
  filter: CorrectionsFilter = {},
): Promise<Corrections> {
  const limit = Math.min(filter.limit ?? 50, 200);
  const from = filter.from ?? null;
  const to = filter.to ?? null;
  const postType = filter.postType ?? null;
  const tag = filter.tag ? normaliseTag(filter.tag) : null;
  const kind = filter.kind ?? null;

  const editRows = await db.$queryRaw<EditRow[]>`
    select
      r.id::text, r.created_at, r.author_id, r.change_kind, r.change_tags, r.change_note,
      c.id::text as candidate_id, c.slot, c.approach, c.angle, c.prompt_version, c.model,
      c.opportunity_id::text, o.post_type_id,
      p.headline as before_headline, r.headline as after_headline,
      p.caption as before_caption, r.caption as after_caption,
      p.channel_texts as before_channels, r.channel_texts as after_channels,
      p.alt_text as before_alt, r.alt_text as after_alt
    from smb.post_revisions r
    join smb.post_revisions p on p.id = r.parent_revision_id
    join smb.post_candidates c on c.id = r.candidate_id
    join smb.post_opportunities o on o.id = c.opportunity_id
    where r.author_kind = 'human'
      and (r.headline is distinct from p.headline or r.caption <> p.caption
        or r.channel_texts <> p.channel_texts or r.alt_text is distinct from p.alt_text)
      and (${from}::timestamptz is null or r.created_at >= ${from}::timestamptz)
      and (${to}::timestamptz is null or r.created_at < ${to}::timestamptz)
      and (${postType}::text is null or o.post_type_id = ${postType}::text)
      and (${tag}::text is null or ${tag}::text = any (r.change_tags))
      and (${kind}::text is null
        or (${kind}::text = 'unclassified' and r.change_kind is null)
        or r.change_kind = ${kind}::text)
    order by r.created_at desc, r.id
    limit ${limit}`;

  const edits = editRows.map((r): EditCorrection => {
    const before = {
      headline: r.before_headline,
      caption: r.before_caption,
      channelTexts: stringMap(r.before_channels),
      altText: r.before_alt,
    };
    const after = {
      headline: r.after_headline,
      caption: r.after_caption,
      channelTexts: stringMap(r.after_channels),
      altText: r.after_alt,
    };
    const value = (side: typeof before, field: string): string | null =>
      field === 'headline'
        ? side.headline
        : field === 'caption'
          ? side.caption
          : field === 'altText'
            ? side.altText
            : (side.channelTexts[field.slice('channel:'.length)] ?? null);
    return {
      revisionId: r.id,
      opportunityId: r.opportunity_id,
      candidateId: r.candidate_id,
      postType: r.post_type_id,
      slot: r.slot,
      approach: r.approach,
      angle: r.angle,
      promptVersion: r.prompt_version,
      model: r.model,
      reviewerId: r.author_id,
      at: r.created_at.toISOString(),
      kind: r.change_kind as ChangeKind | null,
      tags: r.change_tags,
      note: r.change_note,
      changes: changedFields(before, after).map((field) => ({
        field,
        before: value(before, field),
        after: value(after, field),
      })),
    };
  });

  // The kind filter is about edits; feedback is listed only when it was not asked for.
  const feedbackRows = kind
    ? []
    : await db.$queryRaw<
        {
          id: string;
          action: string;
          opportunity_id: string;
          candidate_id: string | null;
          post_type_id: string;
          slot: string | null;
          angle: string | null;
          prompt_version: string | null;
          reviewer_id: string;
          created_at: Date;
          feedback: string | null;
          feedback_tags: string[];
          headline: string | null;
          caption: string | null;
        }[]
      >`
        select
          a.id::text, a.action::text as action, a.opportunity_id::text, a.candidate_id::text,
          o.post_type_id, c.slot, c.angle, c.prompt_version,
          a.reviewer_id, a.created_at, a.feedback, a.feedback_tags,
          r.headline, r.caption
        from smb.review_actions a
        join smb.post_opportunities o on o.id = a.opportunity_id
        left join smb.post_candidates c on c.id = a.candidate_id
        left join smb.post_revisions r on r.id = a.revision_id
        where a.action in ('reject', 'defer', 'regenerate', 'request_research', 'revise')
          and (${from}::timestamptz is null or a.created_at >= ${from}::timestamptz)
          and (${to}::timestamptz is null or a.created_at < ${to}::timestamptz)
          and (${postType}::text is null or o.post_type_id = ${postType}::text)
          and (${tag}::text is null or ${tag}::text = any (a.feedback_tags))
        order by a.created_at desc, a.id
        limit ${limit}`;

  return {
    edits,
    feedback: feedbackRows.map((a) => ({
      actionId: a.id,
      action: a.action,
      opportunityId: a.opportunity_id,
      candidateId: a.candidate_id,
      postType: a.post_type_id,
      slot: a.slot,
      angle: a.angle,
      promptVersion: a.prompt_version,
      reviewerId: a.reviewer_id,
      at: a.created_at.toISOString(),
      feedback: a.feedback,
      tags: a.feedback_tags,
      about: a.caption === null ? null : { headline: a.headline, caption: a.caption },
    })),
  };
}

/** The tag vocabulary, for a picker in the review screen. */
export function feedbackVocabulary() {
  return {
    categories: [...FEEDBACK_CATEGORIES],
    tags: Object.entries(FEEDBACK_TAGS).map(([name, def]) => ({ tag: name, ...def })),
  };
}
