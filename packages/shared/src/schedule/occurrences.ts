import type { ScheduleRule } from '../config/schema.js';
import { localParts, localToUtc } from './zone.js';

export type TimedRule = Extract<ScheduleRule, { kind: 'weekly' | 'daily' | 'interval' }>;

export function isTimedRule(r: ScheduleRule): r is TimedRule {
  return r.kind === 'weekly' || r.kind === 'daily' || r.kind === 'interval';
}

export function ruleKey(rule: TimedRule, phaseId: string | null, tz: string): string {
  const prefix = phaseId ?? 'base';
  if (rule.kind === 'weekly') {
    return `${prefix}|${tz}|weekly|${rule.day}|${rule.time}`;
  }
  if (rule.kind === 'daily') {
    return `${prefix}|${tz}|daily|${rule.time}`;
  }
  return `${prefix}|${tz}|interval|${rule.everyMinutes}`;
}

const WEEKDAY_INDEX: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

/**
 * Returns slots t with after < t <= upTo, in ascending order.
 * Throws on a non-timed rule or an inverted range (after > upTo).
 * Caps at `limit` (default 500) and throws RangeError beyond it.
 */
export function occurrencesBetween(
  rule: TimedRule,
  tz: string,
  after: Date,
  upTo: Date,
  anchor: Date,
  limit = 500,
): Date[] {
  if (!isTimedRule(rule)) {
    throw new TypeError('Rule must be timed (weekly, daily, interval)');
  }
  if (after.getTime() > upTo.getTime()) {
    throw new RangeError('Range inverted: after must be <= upTo');
  }

  const results: Date[] = [];

  if (rule.kind === 'interval') {
    const everyMs = rule.everyMinutes * 60_000;
    const diff = after.getTime() - anchor.getTime();
    const kStart = Math.max(1, Math.floor(diff / everyMs) + 1);

    let k = kStart;
    while (true) {
      const slotMs = anchor.getTime() + k * everyMs;
      if (slotMs > upTo.getTime()) break;
      if (slotMs > after.getTime()) {
        results.push(new Date(slotMs));
        if (results.length > limit) {
          throw new RangeError(`Occurrence limit of ${limit} exceeded`);
        }
      }
      k++;
    }
    return results;
  }

  // weekly or daily: iterate calendar dates
  const [hourStr, minStr] = rule.time.split(':');
  const targetHour = Number.parseInt(hourStr!, 10);
  const targetMinute = Number.parseInt(minStr!, 10);

  const afterLocal = localParts(after.getTime(), tz);
  const upToLocal = localParts(upTo.getTime(), tz);

  const startDay = Date.UTC(afterLocal.year, afterLocal.month - 1, afterLocal.day) - 86_400_000;
  const endDay = Date.UTC(upToLocal.year, upToLocal.month - 1, upToLocal.day) + 86_400_000;

  for (let curDay = startDay; curDay <= endDay; curDay += 86_400_000) {
    const d = new Date(curDay);
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth() + 1;
    const day = d.getUTCDate();
    const weekday = d.getUTCDay();

    if (rule.kind === 'weekly') {
      const targetDayIndex = WEEKDAY_INDEX[rule.day];
      if (weekday !== targetDayIndex) {
        continue;
      }
    }

    const slot = localToUtc(
      { year: y, month: m, day, hour: targetHour, minute: targetMinute },
      tz,
    );

    if (slot.getTime() > after.getTime() && slot.getTime() <= upTo.getTime()) {
      results.push(slot);
      if (results.length > limit) {
        throw new RangeError(`Occurrence limit of ${limit} exceeded`);
      }
    }
  }

  results.sort((a, b) => a.getTime() - b.getTime());
  return results;
}

/** First slot strictly after `after`, searching at most 400 days (weekly/daily) or 2 intervals (interval). */
export function nextOccurrence(
  rule: TimedRule,
  tz: string,
  after: Date,
  anchor: Date,
): Date | null {
  if (rule.kind === 'interval') {
    const horizon = new Date(
      Math.max(after.getTime(), anchor.getTime()) + 2 * rule.everyMinutes * 60_000,
    );
    const slots = occurrencesBetween(rule, tz, after, horizon, anchor, 500);
    return slots[0] ?? null;
  }

  const horizon = new Date(after.getTime() + 400 * 86_400_000);
  const slots = occurrencesBetween(rule, tz, after, horizon, anchor, 500);
  return slots[0] ?? null;
}
