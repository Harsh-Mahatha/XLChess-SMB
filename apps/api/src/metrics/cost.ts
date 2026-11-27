import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import {
  computeCost,
  daysBetween,
  rateAt,
  type CostRate,
  type CostReport,
  type DailyUsage,
} from '@smb/shared';
import type { KpiConfig, KpiWindow } from './window.js';

/** Cost per approved post (module 1.19): the prices, what was used, and the result. */

export class CostRateError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CostRateError';
  }
}

export const CostRateBody = z
  .object({
    /** Defaults to today. Earlier days are refused: past periods keep the prices they were priced at. */
    effectiveFrom: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    gpuWatts: z.number().min(0).max(5000).optional(),
    electricityPerKwh: z.number().min(0).max(100).optional(),
    serverMonthly: z.number().min(0).max(1_000_000).optional(),
    xApiMonthly: z.number().min(0).max(1_000_000).optional(),
    reviewerHourly: z.number().min(0).max(10_000).optional(),
    reason: z.string().trim().min(1).max(300),
  })
  .strict();
export type CostRateBody = z.infer<typeof CostRateBody>;

interface RateRow {
  id: string;
  effective_from: Date;
  currency: string;
  gpu_watts: unknown;
  electricity_per_kwh: unknown;
  server_monthly: unknown;
  x_api_monthly: unknown;
  reviewer_hourly: unknown;
  reason: string;
  created_by: string;
  created_at: Date;
}

const num = (v: unknown): number => Number(v);
const day = (d: Date): string => d.toISOString().slice(0, 10);

function toRate(r: RateRow): CostRate {
  return {
    effectiveFrom: day(r.effective_from),
    currency: r.currency,
    gpuWatts: num(r.gpu_watts),
    electricityPerKwh: num(r.electricity_per_kwh),
    serverMonthly: num(r.server_monthly),
    xApiMonthly: num(r.x_api_monthly),
    reviewerHourly: num(r.reviewer_hourly),
  };
}

export async function listCostRates(
  db: PrismaClient,
): Promise<(CostRate & { id: string; reason: string; createdBy: string; createdAt: string })[]> {
  const rows = await db.cost_rates.findMany({ orderBy: { effective_from: 'asc' } });
  return rows.map((r) => ({
    ...toRate(r as unknown as RateRow),
    id: r.id,
    reason: r.reason,
    createdBy: r.created_by,
    createdAt: r.created_at.toISOString(),
  }));
}

/**
 * Adds a price list that takes effect from a day. Unset fields carry over from the list in force that day,
 * so a change of one price does not reset the others. The table is append-only: a day that already has a list
 * is refused rather than overwritten.
 */
export async function setCostRate(
  db: PrismaClient,
  actor: string,
  body: CostRateBody,
  today: string,
): Promise<CostRate> {
  const effectiveFrom = body.effectiveFrom ?? today;
  if (effectiveFrom < today) {
    throw new CostRateError(
      422,
      'rate_in_past',
      'A price list cannot start in the past: earlier periods keep the prices they were worked out with',
    );
  }
  const rates = (await listCostRates(db)) as CostRate[];
  if (rates.some((r) => r.effectiveFrom === effectiveFrom)) {
    throw new CostRateError(409, 'rate_exists', `A price list already starts on ${effectiveFrom}`);
  }
  const base = rateAt(rates, effectiveFrom);
  const next: CostRate = {
    effectiveFrom,
    currency: body.currency ?? base?.currency ?? 'USD',
    gpuWatts: body.gpuWatts ?? base?.gpuWatts ?? 0,
    electricityPerKwh: body.electricityPerKwh ?? base?.electricityPerKwh ?? 0,
    serverMonthly: body.serverMonthly ?? base?.serverMonthly ?? 0,
    xApiMonthly: body.xApiMonthly ?? base?.xApiMonthly ?? 0,
    reviewerHourly: body.reviewerHourly ?? base?.reviewerHourly ?? 0,
  };
  await db.$transaction(async (tx) => {
    await tx.cost_rates.create({
      data: {
        effective_from: new Date(`${effectiveFrom}T00:00:00Z`),
        currency: next.currency,
        gpu_watts: next.gpuWatts,
        electricity_per_kwh: next.electricityPerKwh,
        server_monthly: next.serverMonthly,
        x_api_monthly: next.xApiMonthly,
        reviewer_hourly: next.reviewerHourly,
        reason: body.reason,
        created_by: actor,
      },
    });
    await tx.audit_log.create({
      data: {
        actor,
        action: 'cost_rates.change',
        target_type: 'cost_rates',
        target_id: effectiveFrom,
        details: { reason: body.reason, rates: next } as never,
      },
    });
  });
  return next;
}

export interface CostResult extends CostReport {
  window: { from: string; to: string };
  /** True when no reviewer reported active time, so the review cost is missing rather than zero. */
  reviewTimeMeasured: boolean;
}

/**
 * Cost per approved post over a window. Everything used in the window is priced: posts that were rejected or
 * failed cost as much as the ones that were approved, and the approved ones carry that.
 */
export async function costReport(
  db: PrismaClient,
  kpi: KpiConfig,
  w: KpiWindow,
): Promise<CostResult> {
  const rates = (await listCostRates(db)) as CostRate[];
  const gpu = await db.$queryRaw<{ day: string; seconds: number }[]>`
    select (j.updated_at at time zone ${kpi.timezone})::date::text as day,
           (sum(j.duration_ms) / 1000.0)::float8 as seconds
    from smb.jobs j
    where j.lane = 'gpu' and j.duration_ms > 0
      and j.updated_at >= ${w.from}::timestamptz and j.updated_at < ${w.to}::timestamptz
    group by 1`;
  const review = await db.$queryRaw<{ day: string; seconds: number }[]>`
    select (a.created_at at time zone ${kpi.timezone})::date::text as day, sum(a.active_seconds)::float8 as seconds
    from smb.review_actions a
    where a.active_seconds is not null
      and a.created_at >= ${w.from}::timestamptz and a.created_at < ${w.to}::timestamptz
    group by 1`;
  const [approved] = await db.$queryRaw<{ n: number }[]>`
    select count(*)::int as n from smb.review_outcomes o
    where o.outcome = 'approved'
      and o.decided_at >= ${w.from}::timestamptz and o.decided_at < ${w.to}::timestamptz`;

  const days = daysBetween(w.fromDay, w.toDay);
  const usage: DailyUsage[] = days.map((d) => ({
    day: d,
    gpuSeconds: gpu.find((r) => r.day === d)?.seconds ?? 0,
    reviewSeconds: review.find((r) => r.day === d)?.seconds ?? 0,
  }));
  const report = computeCost(rates, usage, days, approved?.n ?? 0);
  return {
    ...report,
    window: { from: w.fromDay, to: w.toDay },
    reviewTimeMeasured: report.reviewSeconds > 0,
  };
}

export interface OpportunityCost {
  opportunityId: string;
  currency: string;
  gpuSeconds: number;
  jobs: number;
  promptTokens: number;
  completionTokens: number;
  reviewSeconds: number;
  compute: number;
  review: number;
  /** Compute and review. Hosting is shared by every post and is left out of a single post's figure. */
  total: number;
}

/** What one post cost to write and to review. */
export async function opportunityCost(
  db: PrismaClient,
  kpi: KpiConfig,
  opportunityId: string,
): Promise<OpportunityCost | null> {
  const exists = await db.post_opportunities.findUnique({
    where: { id: opportunityId },
    select: { id: true },
  });
  if (!exists) return null;
  const rates = (await listCostRates(db)) as CostRate[];
  const jobs = await db.$queryRaw<
    { day: string; seconds: number; prompt: number; completion: number; n: number }[]
  >`
    select (j.updated_at at time zone ${kpi.timezone})::date::text as day,
      (sum(j.duration_ms) / 1000.0)::float8 as seconds,
      coalesce(sum((j.usage -> 'llm' ->> 'promptTokens')::bigint), 0)::float8 as prompt,
      coalesce(sum((j.usage -> 'llm' ->> 'completionTokens')::bigint), 0)::float8 as completion,
      count(*)::int as n
    from smb.jobs j
    where j.opportunity_id = ${opportunityId}::uuid and j.lane = 'gpu'
    group by 1`;
  const review = await db.$queryRaw<{ day: string; seconds: number }[]>`
    select (a.created_at at time zone ${kpi.timezone})::date::text as day, sum(a.active_seconds)::float8 as seconds
    from smb.review_actions a
    where a.opportunity_id = ${opportunityId}::uuid and a.active_seconds is not null
    group by 1`;
  let compute = 0;
  let reviewCost = 0;
  let gpuSeconds = 0;
  let reviewSeconds = 0;
  let currency = rateAt(rates, '9999-12-31')?.currency ?? 'USD';
  for (const j of jobs) {
    const r = rateAt(rates, j.day);
    gpuSeconds += j.seconds;
    if (r) {
      currency = r.currency;
      compute += (r.gpuWatts / 1000) * (j.seconds / 3600) * r.electricityPerKwh;
    }
  }
  for (const a of review) {
    const r = rateAt(rates, a.day);
    reviewSeconds += a.seconds;
    if (r) reviewCost += (a.seconds / 3600) * r.reviewerHourly;
  }
  const round = (n: number): number => Math.round(n * 10_000) / 10_000;
  return {
    opportunityId,
    currency,
    gpuSeconds: Math.round(gpuSeconds * 10) / 10,
    jobs: jobs.reduce((n, j) => n + j.n, 0),
    promptTokens: jobs.reduce((n, j) => n + j.prompt, 0),
    completionTokens: jobs.reduce((n, j) => n + j.completion, 0),
    reviewSeconds,
    compute: round(compute),
    review: round(reviewCost),
    total: round(compute + reviewCost),
  };
}
