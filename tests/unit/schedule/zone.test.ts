import { describe, expect, it } from 'vitest';
import {
  localParts,
  localToUtc,
  zoneOffsetMinutes,
} from '../../../packages/shared/src/schedule/zone.js';

describe('timezone maths and DST (D2)', () => {
  it('handles America/New_York DST transitions and normal seasons', () => {
    const tz = 'America/New_York';

    // 2026-03-08 02:30 is in the spring-forward gap (02:00 -> 03:00)
    // Offset before gap is EST (-300 min), so 02:30 - (-300m) = 07:30Z
    const springGap = localToUtc({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, tz);
    expect(springGap.toISOString()).toBe('2026-03-08T07:30:00.000Z');

    // 2026-11-01 01:30 is in the fall-back overlap (02:00 -> 01:00)
    // First occurrence is EDT (-240 min), so 01:30 - (-240m) = 05:30Z
    const fallOverlap = localToUtc({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, tz);
    expect(fallOverlap.toISOString()).toBe('2026-11-01T05:30:00.000Z');

    // Normal winter: 2026-01-15 09:00 EST -> 14:00Z
    const winter = localToUtc({ year: 2026, month: 1, day: 15, hour: 9, minute: 0 }, tz);
    expect(winter.toISOString()).toBe('2026-01-15T14:00:00.000Z');

    // Normal summer: 2026-07-10 09:00 EDT -> 13:00Z
    const summer = localToUtc({ year: 2026, month: 7, day: 10, hour: 9, minute: 0 }, tz);
    expect(summer.toISOString()).toBe('2026-07-10T13:00:00.000Z');
  });

  it('handles Europe/London DST transitions', () => {
    const tz = 'Europe/London';

    // 2026-03-29 01:30 gap (clocks jump 01:00 to 02:00 local) -> 01:30:00Z (02:30 BST)
    const springGap = localToUtc({ year: 2026, month: 3, day: 29, hour: 1, minute: 30 }, tz);
    expect(springGap.toISOString()).toBe('2026-03-29T01:30:00.000Z');

    // 2026-10-25 01:30 overlap (clocks fall back 02:00 to 01:00) -> first occurrence at 00:30:00Z (BST)
    const fallOverlap = localToUtc({ year: 2026, month: 10, day: 25, hour: 1, minute: 30 }, tz);
    expect(fallOverlap.toISOString()).toBe('2026-10-25T00:30:00.000Z');
  });

  it('handles Asia/Kolkata constant offset', () => {
    const tz = 'Asia/Kolkata';
    const winter = localToUtc({ year: 2026, month: 1, day: 15, hour: 9, minute: 0 }, tz);
    expect(winter.toISOString()).toBe('2026-01-15T03:30:00.000Z');

    const summer = localToUtc({ year: 2026, month: 7, day: 15, hour: 9, minute: 0 }, tz);
    expect(summer.toISOString()).toBe('2026-07-15T03:30:00.000Z');

    expect(zoneOffsetMinutes(winter.getTime(), tz)).toBe(330);
  });

  it('handles Australia/Lord_Howe 30-minute shift and round-trips non-ambiguous times', () => {
    const tz = 'Australia/Lord_Howe';
    const janTime = Date.UTC(2026, 0, 15, 12, 0); // January (summer / DST: +11h = 660 min)
    const julTime = Date.UTC(2026, 6, 15, 12, 0); // July (winter / standard: +10:30 = 630 min)

    expect(zoneOffsetMinutes(janTime, tz)).toBe(660);
    expect(zoneOffsetMinutes(julTime, tz)).toBe(630);

    // Hourly round-trip test across zones
    const zones = ['America/New_York', 'Europe/London', 'Asia/Kolkata', 'Australia/Lord_Howe', 'UTC'];
    for (const testTz of zones) {
      // Step through every 24 hours of 2026 at 12:00 UTC (guaranteed non-ambiguous)
      for (let day = 0; day < 365; day += 7) {
        const t = Date.UTC(2026, 0, 1, 12, 0) + day * 86_400_000;
        const parts = localParts(t, testTz);
        const roundTripped = localToUtc(parts, testTz);
        expect(roundTripped.getTime()).toBe(t);
      }
    }
  });

  it('treats UTC as identity', () => {
    const date = { year: 2026, month: 11, day: 20, hour: 9, minute: 0 };
    const utc = localToUtc(date, 'UTC');
    expect(utc.toISOString()).toBe('2026-11-20T09:00:00.000Z');
    expect(zoneOffsetMinutes(utc.getTime(), 'UTC')).toBe(0);

    const parts = localParts(utc.getTime(), 'UTC');
    expect(parts.year).toBe(2026);
    expect(parts.month).toBe(11);
    expect(parts.day).toBe(20);
    expect(parts.hour).toBe(9);
    expect(parts.minute).toBe(0);
    expect(parts.weekday).toBe(5); // Friday = 5
  });
});
