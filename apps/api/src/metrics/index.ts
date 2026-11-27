import type { PrismaClient } from '@prisma/client';
import type { HealthThresholds } from '@smb/shared';
import { costReport, type CostResult } from './cost.js';
import { healthReport, type HealthReport } from './health.js';
import { operationsReport, type OperationsReport } from './operations.js';
import { qualityReport, type QualityReport } from './quality.js';
import { uneditedStreak, type StreakResult } from './streak.js';
import { kpiWindow, type KpiConfig } from './window.js';

export * from './cost.js';
export * from './health.js';
export * from './operations.js';
export * from './quality.js';
export * from './streak.js';
export * from './window.js';

export interface MetricsConfig extends KpiConfig {
  thresholds: HealthThresholds;
}

export interface Dashboard {
  generatedAt: string;
  timezone: string;
  window: { from: string; to: string; days: number };
  streak: StreakResult;
  quality: QualityReport;
  operations: OperationsReport;
  cost: CostResult;
  health: HealthReport;
}

/** Everything the dashboard shows, for the last `days` days, in one call. */
export async function dashboard(
  db: PrismaClient,
  cfg: MetricsConfig,
  o: { days: number; postType?: string; now?: Date },
): Promise<Dashboard> {
  const w = await kpiWindow(db, cfg.timezone, o.days, o.now);
  const period = { from: w.from, to: w.to, postType: o.postType };
  const [streak, quality, operations, cost, health] = await Promise.all([
    uneditedStreak(db, cfg, { days: o.days, postType: o.postType, now: o.now }, w),
    qualityReport(db, period),
    operationsReport(db, { from: w.from, to: w.to }),
    costReport(db, cfg, w),
    healthReport(db, cfg.thresholds, o.now),
  ]);
  return {
    generatedAt: (o.now ?? new Date()).toISOString(),
    timezone: cfg.timezone,
    window: { from: w.fromDay, to: w.toDay, days: o.days },
    streak,
    quality,
    operations,
    cost,
    health,
  };
}
