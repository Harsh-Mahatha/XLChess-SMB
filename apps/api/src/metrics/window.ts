import type { PrismaClient } from '@prisma/client';

/** How the KPI figures cut time: the timezone that decides which day a post belongs to, and the daily volume. */
export interface KpiConfig {
  timezone: string;
  requiredDailyVolume: number;
}

export interface KpiWindow {
  /** First and last day, `YYYY-MM-DD` in the reporting timezone. */
  fromDay: string;
  toDay: string;
  /** The same window as instants: `from` inclusive, `to` exclusive. */
  from: Date;
  to: Date;
}

/**
 * The last `days` days up to and including today in the reporting timezone. The database works the day
 * boundaries out, so daylight saving shifts are handled by the one place that knows the zone rules.
 */
export async function kpiWindow(
  db: PrismaClient,
  timezone: string,
  days: number,
  now?: Date,
): Promise<KpiWindow> {
  const at = now ?? null;
  const [row] = await db.$queryRaw<{ from_day: string; to_day: string; from_at: Date; to_at: Date }[]>`
    with t as (select (coalesce(${at}::timestamptz, now()) at time zone ${timezone})::date as today)
    select
      (t.today - ${days - 1}::int)::text                              as from_day,
      t.today::text                                                    as to_day,
      ((t.today - ${days - 1}::int)::timestamp at time zone ${timezone}) as from_at,
      ((t.today + 1)::timestamp at time zone ${timezone})              as to_at
    from t`;
  return { fromDay: row!.from_day, toDay: row!.to_day, from: row!.from_at, to: row!.to_at };
}
