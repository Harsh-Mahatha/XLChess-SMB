export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: 0 | 1 | 2 | 3 | 4 | 5 | 6; // 0 = Sunday
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function getFormatter(tz: string): Intl.DateTimeFormat {
  let fmt = formatters.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    formatters.set(tz, fmt);
  }
  return fmt;
}

const WEEKDAY_MAP: Record<string, 0 | 1 | 2 | 3 | 4 | 5 | 6> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export function localParts(utcMs: number, tz: string): LocalParts {
  const fmt = getFormatter(tz);
  const parts = fmt.formatToParts(new Date(utcMs));
  let year = 0;
  let month = 0;
  let day = 0;
  let hour = 0;
  let minute = 0;
  let weekday: 0 | 1 | 2 | 3 | 4 | 5 | 6 = 0;

  for (const p of parts) {
    if (p.type === 'year') {
      year = Number.parseInt(p.value, 10);
    } else if (p.type === 'month') {
      month = Number.parseInt(p.value, 10);
    } else if (p.type === 'day') {
      day = Number.parseInt(p.value, 10);
    } else if (p.type === 'hour') {
      const h = Number.parseInt(p.value, 10);
      hour = h === 24 ? 0 : h;
    } else if (p.type === 'minute') {
      minute = Number.parseInt(p.value, 10);
    } else if (p.type === 'weekday') {
      weekday = WEEKDAY_MAP[p.value] ?? 0;
    }
  }

  return { year, month, day, hour, minute, weekday };
}

/** Local minus UTC in minutes, e.g. -300 for New York in winter. */
export function zoneOffsetMinutes(utcMs: number, tz: string): number {
  const parts = localParts(utcMs, tz);
  const localAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  const utcFloorMinute = Math.floor(utcMs / 60_000) * 60_000;
  return Math.round((localAsUtc - utcFloorMinute) / 60_000);
}

/**
 * Converts local calendar parts in a timezone to a UTC Date.
 * Implements D2:
 * - Fall-back overlap (2 occurrences): returns the earlier instant.
 * - Spring-forward gap (0 occurrences): returns the first instant after the gap using the offset in force just before the gap.
 */
export function localToUtc(
  p: { year: number; month: number; day: number; hour: number; minute: number },
  tz: string,
): Date {
  const guess = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  const before = zoneOffsetMinutes(guess - 86_400_000, tz);
  const after = zoneOffsetMinutes(guess + 86_400_000, tz);

  const offsets = before === after ? [before] : [before, after];
  const valid: number[] = [];

  for (const o of offsets) {
    const t = guess - o * 60_000;
    if (zoneOffsetMinutes(t, tz) === o) {
      valid.push(t);
    }
  }

  if (valid.length > 0) {
    valid.sort((a, b) => a - b);
    return new Date(valid[0]!);
  }

  // Spring-forward gap: instant shifted by the pre-gap offset
  return new Date(guess - before * 60_000);
}
