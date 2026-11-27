import type { PrismaClient } from '@prisma/client';
import { feedbackSummary, inPeriod, type FeedbackSummary, type Period } from '../review/feedback.js';

/**
 * Quality KPIs (module 1.19): the 1.12 acceptance and correction figures plus what 1.19 adds. Rates use every
 * decided post as the denominator, rejected ones included.
 */

export interface TimeSpread {
  /** Posts the figure is based on. */
  posts: number;
  medianSeconds: number | null;
  p90Seconds: number | null;
}

export interface QualityExtras {
  decided: number;
  /** Approved as first written with no regeneration, rewrite request or research request. */
  clean: number;
  cleanRate: number | null;
  /** Decided posts where a reviewer flagged the picture, or whose approved picture was swapped. */
  imageReplaced: number;
  imageReplacementRate: number | null;
  /** Time reviewers reported actively looking at a post, per post. Null figures mean nobody reported any. */
  activeReviewTime: TimeSpread;
  /** Time from ready-for-review to the decision. Includes waiting, so it overstates the effort. */
  timeToDecision: TimeSpread;
}

export interface QualityReport {
  feedback: FeedbackSummary;
  totals: QualityExtras;
  postTypes: (QualityExtras & { postType: string })[];
}

interface Row {
  post_type_id: string | null;
  decided: number;
  clean: number;
  image_replaced: number;
  active_n: number;
  active_p50: number | null;
  active_p90: number | null;
  elapsed_n: number;
  elapsed_p50: number | null;
  elapsed_p90: number | null;
}

const ratio = (n: number, d: number): number | null =>
  d > 0 ? Math.round((n / d) * 1000) / 1000 : null;
const secs = (n: number | null): number | null => (n === null ? null : Math.round(n));

function extras(r: Row): QualityExtras {
  return {
    decided: r.decided,
    clean: r.clean,
    cleanRate: ratio(r.clean, r.decided),
    imageReplaced: r.image_replaced,
    imageReplacementRate: ratio(r.image_replaced, r.decided),
    activeReviewTime: {
      posts: r.active_n,
      medianSeconds: secs(r.active_p50),
      p90Seconds: secs(r.active_p90),
    },
    timeToDecision: {
      posts: r.elapsed_n,
      medianSeconds: secs(r.elapsed_p50),
      p90Seconds: secs(r.elapsed_p90),
    },
  };
}

export async function qualityReport(
  db: PrismaClient,
  period: Period = {},
): Promise<QualityReport> {
  const where = inPeriod(period);
  const feedback = await feedbackSummary(db, period);
  const rows = await db.$queryRaw<Row[]>`
    select
      o.post_type_id,
      count(*) filter (where o.outcome in ('approved', 'rejected'))::int                as decided,
      count(*) filter (where o.clean)::int                                              as clean,
      count(*) filter (where o.outcome in ('approved', 'rejected')
        and (o.image_flagged or o.image_replaced))::int                                 as image_replaced,
      count(o.active_review_seconds)::int                                               as active_n,
      percentile_cont(0.5) within group (order by o.active_review_seconds)::float8      as active_p50,
      percentile_cont(0.9) within group (order by o.active_review_seconds)::float8      as active_p90,
      count(o.decided_at)::int                                                          as elapsed_n,
      percentile_cont(0.5) within group (order by extract(epoch from o.decided_at - o.first_ready_at))::float8
                                                                                        as elapsed_p50,
      percentile_cont(0.9) within group (order by extract(epoch from o.decided_at - o.first_ready_at))::float8
                                                                                        as elapsed_p90
    from smb.review_outcome_metrics o
    where ${where}
    group by rollup (o.post_type_id)`;
  const total = rows.find((r) => r.post_type_id === null);
  const empty: Row = {
    post_type_id: null,
    decided: 0,
    clean: 0,
    image_replaced: 0,
    active_n: 0,
    active_p50: null,
    active_p90: null,
    elapsed_n: 0,
    elapsed_p50: null,
    elapsed_p90: null,
  };
  return {
    feedback,
    totals: extras(total ?? empty),
    postTypes: rows
      .filter((r): r is Row & { post_type_id: string } => r.post_type_id !== null)
      .sort((a, b) => a.post_type_id.localeCompare(b.post_type_id))
      .map((r) => ({ postType: r.post_type_id, ...extras(r) })),
  };
}
