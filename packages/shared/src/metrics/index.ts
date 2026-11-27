import { z } from 'zod';
import type { AiProvider, AiResult, AiTask } from '../ai/provider.js';

/**
 * Monitoring, cost and quality KPIs (module 1.19): the pure parts. The day classification behind the
 * ten-day unedited-approval goal, the cost model and the usage a worker reports. Nothing here reads a
 * database, so the definitions can be tested exactly.
 */

// ---------------------------------------------------------------------------------------------------------
// What a job used (reported by the worker, optional so older workers keep working)
// ---------------------------------------------------------------------------------------------------------

export const JobUsage = z
  .object({
    /** Model calls made by the job, summed. */
    llm: z
      .object({
        calls: z.number().int().nonnegative(),
        durationMs: z.number().nonnegative(),
        promptTokens: z.number().int().nonnegative(),
        completionTokens: z.number().int().nonnegative(),
        model: z.string().max(200).optional(),
      })
      .optional(),
    /** Wall-clock time the GPU was held by the job. */
    gpuMs: z.number().nonnegative().optional(),
  })
  .strict();
export type JobUsage = z.infer<typeof JobUsage>;

/** Wraps a provider and adds up what its calls used. Read `usage()` after the job. */
export function meterProvider(provider: AiProvider): { provider: AiProvider; usage: () => JobUsage } {
  const total = { calls: 0, durationMs: 0, promptTokens: 0, completionTokens: 0 };
  const metered: AiProvider = {
    name: provider.name,
    model: provider.model,
    async generate<T>(task: AiTask<T>): Promise<AiResult<T>> {
      const result = await provider.generate(task);
      total.calls += 1;
      total.durationMs += result.durationMs;
      total.promptTokens += result.promptTokens ?? 0;
      total.completionTokens += result.completionTokens ?? 0;
      return result;
    },
  };
  return { provider: metered, usage: () => ({ llm: { ...total, model: provider.model } }) };
}

// ---------------------------------------------------------------------------------------------------------
// The ten-day goal
// ---------------------------------------------------------------------------------------------------------

/** The target from the Feature Definition: ten consecutive qualifying days with every post approved unedited. */
export const UNEDITED_STREAK_GOAL_DAYS = 10;

/** What happened to the posts that became ready for review on one day. */
export interface DayTally {
  /** `YYYY-MM-DD` in the reporting timezone. */
  day: string;
  /** Posts that became ready for review that day, whatever became of them. */
  posts: number;
  /** Approved exactly as written, with no regeneration, rewrite request or research request. */
  clean: number;
  /** Still waiting for a decision. */
  pending: number;
}

/**
 * - `clean`: enough posts, all decided, every one clean.
 * - `broken`: enough posts and at least one decided post was rejected, edited, regenerated or otherwise not clean.
 * - `incomplete`: enough posts, none broken yet, but some are undecided. Provisional: it neither counts nor breaks.
 * - `below_volume`: fewer posts than the required volume. Not evaluated: it neither counts nor breaks.
 */
export type DayStatus = 'clean' | 'broken' | 'incomplete' | 'below_volume';

export interface DayResult extends DayTally {
  status: DayStatus;
  /** Decided posts that were not clean (rejected, edited, regenerated, failed). */
  notClean: number;
}

export function classifyDay(t: DayTally, requiredVolume: number): DayResult {
  const notClean = Math.max(0, t.posts - t.clean - t.pending);
  let status: DayStatus;
  // Rejected posts count towards the volume, so a day cannot fall under it by turning posts down.
  if (t.posts < requiredVolume) status = 'below_volume';
  else if (notClean > 0) status = 'broken';
  else if (t.pending > 0) status = 'incomplete';
  else status = 'clean';
  return { ...t, notClean, status };
}

export interface StreakReport {
  goalDays: number;
  requiredDailyVolume: number;
  /** Consecutive clean days up to the most recent evaluated day. Days that are not evaluated are skipped. */
  current: number;
  /** The longest run of clean days in the window. */
  best: number;
  goalReached: boolean;
  /** True when the current streak reaches the start of the window, so it may be longer than shown. */
  windowLimited: boolean;
  /** The day that ended the current run, if any. */
  brokenOn: string | null;
  days: DayResult[];
}

/** Every day from `from` to `to` inclusive (`YYYY-MM-DD`), in order. */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= end; t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/**
 * Builds the day-by-day report for `days` (oldest first, no gaps required: a missing day is a day with no
 * posts). Rejected posts are inside `posts` and never excluded.
 */
export function buildStreak(
  tallies: readonly DayTally[],
  window: { from: string; to: string },
  options: { requiredDailyVolume: number; goalDays?: number } = { requiredDailyVolume: 1 },
): StreakReport {
  const goalDays = options.goalDays ?? UNEDITED_STREAK_GOAL_DAYS;
  const required = Math.max(1, options.requiredDailyVolume);
  const byDay = new Map(tallies.map((t) => [t.day, t]));
  const days = daysBetween(window.from, window.to).map((day) =>
    classifyDay(byDay.get(day) ?? { day, posts: 0, clean: 0, pending: 0 }, required),
  );

  let best = 0;
  let run = 0;
  for (const d of days) {
    if (d.status === 'clean') {
      run += 1;
      best = Math.max(best, run);
    } else if (d.status === 'broken') run = 0;
  }

  let current = 0;
  let brokenOn: string | null = null;
  let reachedStart = true;
  for (let i = days.length - 1; i >= 0; i--) {
    const d = days[i]!;
    if (d.status === 'clean') current += 1;
    else if (d.status === 'broken') {
      brokenOn = d.day;
      reachedStart = false;
      break;
    }
  }
  return {
    goalDays,
    requiredDailyVolume: required,
    current,
    best,
    goalReached: current >= goalDays,
    windowLimited: reachedStart && current > 0,
    brokenOn,
    days,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------------------------------------

export interface CostRate {
  /** `YYYY-MM-DD`: the rate applies from this day until the next rate's day. */
  effectiveFrom: string;
  currency: string;
  /** Average draw while a GPU job runs. */
  gpuWatts: number;
  electricityPerKwh: number;
  /** Hosting, database and storage. Spread evenly over the days of the month. */
  serverMonthly: number;
  xApiMonthly: number;
  reviewerHourly: number;
}

export const COST_RATE_FIELDS = [
  'gpuWatts',
  'electricityPerKwh',
  'serverMonthly',
  'xApiMonthly',
  'reviewerHourly',
] as const;
export type CostRateField = (typeof COST_RATE_FIELDS)[number];

/** What the system used on one day, whatever the posts became. Failed attempts are included. */
export interface DailyUsage {
  day: string;
  gpuSeconds: number;
  /** Time reviewers reported actively looking at posts. */
  reviewSeconds: number;
}

export interface CostReport {
  currency: string;
  /** Electricity for the GPU time. */
  compute: number;
  /** Reviewer time at the hourly rate. */
  review: number;
  /** Hosting, database, storage. */
  server: number;
  xApi: number;
  total: number;
  approvedPosts: number;
  /** Everything spent in the period, including on posts that were rejected or failed, per approved post. */
  perApprovedPost: number | null;
  gpuSeconds: number;
  reviewSeconds: number;
  /** Rates still at zero in the newest rate in the period: the matching cost is not counted, not free. */
  unpriced: CostRateField[];
}

/** The rate in force on `day`: the newest one that started on or before it, else the oldest one. */
export function rateAt(rates: readonly CostRate[], day: string): CostRate | undefined {
  const sorted = [...rates].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  let found: CostRate | undefined;
  for (const r of sorted) if (r.effectiveFrom <= day) found = r;
  return found ?? sorted[0];
}

const daysInMonthOf = (day: string): number => {
  const y = Number(day.slice(0, 4));
  const m = Number(day.slice(5, 7));
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};

const round = (n: number, places = 4): number => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};

/**
 * The cost of the days in `periodDays`. Every day is priced at the rates of its own time. Usage on days
 * outside the period is ignored.
 */
export function computeCost(
  rates: readonly CostRate[],
  usage: readonly DailyUsage[],
  periodDays: readonly string[],
  approvedPosts: number,
): CostReport {
  let compute = 0;
  let review = 0;
  let server = 0;
  let xApi = 0;
  let gpuSeconds = 0;
  let reviewSeconds = 0;
  const inPeriod = new Set(periodDays);
  for (const u of usage) {
    if (!inPeriod.has(u.day)) continue;
    const r = rateAt(rates, u.day);
    gpuSeconds += u.gpuSeconds;
    reviewSeconds += u.reviewSeconds;
    if (!r) continue;
    compute += (r.gpuWatts / 1000) * (u.gpuSeconds / 3600) * r.electricityPerKwh;
    review += (u.reviewSeconds / 3600) * r.reviewerHourly;
  }
  for (const day of periodDays) {
    const r = rateAt(rates, day);
    if (!r) continue;
    const n = daysInMonthOf(day);
    server += r.serverMonthly / n;
    xApi += r.xApiMonthly / n;
  }
  const last = periodDays.length > 0 ? rateAt(rates, periodDays[periodDays.length - 1]!) : undefined;
  const unpriced = last ? COST_RATE_FIELDS.filter((f) => last[f] === 0) : [...COST_RATE_FIELDS];
  const total = compute + review + server + xApi;
  return {
    currency: last?.currency ?? 'USD',
    compute: round(compute),
    review: round(review),
    server: round(server),
    xApi: round(xApi),
    total: round(total),
    approvedPosts,
    perApprovedPost: approvedPosts > 0 ? round(total / approvedPosts) : null,
    gpuSeconds: round(gpuSeconds, 1),
    reviewSeconds,
    unpriced,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------------------------------------

export type AlertSeverity = 'warning' | 'critical';

export interface HealthAlert {
  /** Stable, so a log line can say an alert opened or cleared. */
  key: string;
  severity: AlertSeverity;
  message: string;
  /** The ids or counts behind it. Never contains secrets. */
  detail?: Record<string, unknown>;
}

export interface HealthInputs {
  /** Workers that are paired, not revoked and not paused, and when each was last heard from. */
  workers: { id: string; lastSeenAt: Date | null }[];
  gpuJobsQueued: number;
  oldestGpuJobQueuedAt: Date | null;
  deadJobsLast24h: number;
  publicationsFailed: number;
  publicationsUncertain: number;
  pollersFailing: { id: string; consecutiveFailures: number; lastError: string | null }[];
  oldestReviewWaitingAt: Date | null;
}

export interface HealthThresholds {
  workerOfflineMinutes: number;
  pollerFailures: number;
  reviewWaitHours: number;
}

export const DEFAULT_HEALTH_THRESHOLDS: HealthThresholds = {
  workerOfflineMinutes: 10,
  pollerFailures: 3,
  reviewWaitHours: 6,
};

/** The problems visible right now. Pure: the same inputs always give the same alerts. */
export function evaluateHealth(
  i: HealthInputs,
  now: Date,
  t: HealthThresholds = DEFAULT_HEALTH_THRESHOLDS,
): HealthAlert[] {
  const alerts: HealthAlert[] = [];
  const minutes = (d: Date): number => (now.getTime() - d.getTime()) / 60_000;

  if (i.gpuJobsQueued > 0 && i.oldestGpuJobQueuedAt) {
    const waited = minutes(i.oldestGpuJobQueuedAt);
    if (waited >= t.workerOfflineMinutes) {
      const online = i.workers.filter(
        (w) => w.lastSeenAt && minutes(w.lastSeenAt) < t.workerOfflineMinutes,
      );
      if (online.length === 0) {
        alerts.push({
          key: 'worker_offline',
          severity: 'critical',
          message: `${i.gpuJobsQueued} GPU job(s) are waiting and no worker has been seen for ${t.workerOfflineMinutes} minutes`,
          detail: { queued: i.gpuJobsQueued, workers: i.workers.length },
        });
      }
    }
  }
  if (i.deadJobsLast24h > 0) {
    alerts.push({
      key: 'dead_jobs',
      severity: 'critical',
      message: `${i.deadJobsLast24h} job(s) ran out of attempts in the last 24 hours`,
      detail: { count: i.deadJobsLast24h },
    });
  }
  if (i.publicationsUncertain > 0) {
    alerts.push({
      key: 'publications_uncertain',
      severity: 'critical',
      message: `${i.publicationsUncertain} publication(s) have an unknown outcome and need a decision`,
      detail: { count: i.publicationsUncertain },
    });
  }
  if (i.publicationsFailed > 0) {
    alerts.push({
      key: 'publications_failed',
      severity: 'warning',
      message: `${i.publicationsFailed} publication(s) failed`,
      detail: { count: i.publicationsFailed },
    });
  }
  const failing = i.pollersFailing.filter((p) => p.consecutiveFailures >= t.pollerFailures);
  if (failing.length > 0) {
    alerts.push({
      key: 'source_failing',
      severity: 'warning',
      message: `${failing.length} event poller(s) failed ${t.pollerFailures} or more times in a row`,
      detail: { pollers: failing.map((p) => p.id) },
    });
  }
  if (i.oldestReviewWaitingAt && minutes(i.oldestReviewWaitingAt) >= t.reviewWaitHours * 60) {
    alerts.push({
      key: 'review_waiting',
      severity: 'warning',
      message: `A post has waited for review more than ${t.reviewWaitHours} hours`,
      detail: { since: i.oldestReviewWaitingAt.toISOString() },
    });
  }
  return alerts;
}
