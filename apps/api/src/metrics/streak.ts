import type { PrismaClient } from '@prisma/client';
import { buildStreak, type DayTally, type StreakReport } from '@smb/shared';
import { kpiWindow, type KpiConfig, type KpiWindow } from './window.js';

export interface StreakOptions {
  /** How many days to show. The current streak is counted inside this window only. */
  days: number;
  postType?: string;
  now?: Date;
}

export interface StreakResult extends StreakReport {
  timezone: string;
  window: { from: string; to: string };
  /** The same figures for each post type, so the weak ones stand out. */
  byPostType: { postType: string; current: number; best: number; posts: number; clean: number }[];
}

interface Row {
  day: string;
  post_type_id: string;
  posts: number;
  clean: number;
  pending: number;
}

/**
 * The ten-day goal (module 1.19). A post belongs to the day it first became ready for review. Every post that
 * reached review counts towards that day's volume, rejected ones included, and a post that was rejected,
 * edited, regenerated or sent back for research makes the day `broken`. See `buildStreak` for the rules.
 */
export async function uneditedStreak(
  db: PrismaClient,
  kpi: KpiConfig,
  o: StreakOptions,
  window?: KpiWindow,
): Promise<StreakResult> {
  const w = window ?? (await kpiWindow(db, kpi.timezone, o.days, o.now));
  const rows = await db.$queryRaw<Row[]>`
    select
      (m.first_ready_at at time zone ${kpi.timezone})::date::text as day,
      m.post_type_id,
      count(*)::int                                      as posts,
      count(*) filter (where m.clean)::int               as clean,
      count(*) filter (where m.outcome = 'pending')::int as pending
    from smb.review_outcome_metrics m
    where m.first_ready_at >= ${w.from}::timestamptz and m.first_ready_at < ${w.to}::timestamptz
      and (${o.postType ?? null}::text is null or m.post_type_id = ${o.postType ?? null}::text)
    group by 1, 2`;

  const window2 = { from: w.fromDay, to: w.toDay };
  const options = { requiredDailyVolume: kpi.requiredDailyVolume };

  const all = new Map<string, DayTally>();
  for (const r of rows) {
    const t = all.get(r.day) ?? { day: r.day, posts: 0, clean: 0, pending: 0 };
    t.posts += r.posts;
    t.clean += r.clean;
    t.pending += r.pending;
    all.set(r.day, t);
  }
  const report = buildStreak([...all.values()], window2, options);

  const types = [...new Set(rows.map((r) => r.post_type_id))].sort();
  const byPostType = types.map((postType) => {
    const mine = rows.filter((r) => r.post_type_id === postType);
    const r = buildStreak(
      mine.map((x) => ({ day: x.day, posts: x.posts, clean: x.clean, pending: x.pending })),
      window2,
      options,
    );
    return {
      postType,
      current: r.current,
      best: r.best,
      posts: mine.reduce((s, x) => s + x.posts, 0),
      clean: mine.reduce((s, x) => s + x.clean, 0),
    };
  });
  return { ...report, timezone: kpi.timezone, window: window2, byPostType };
}
