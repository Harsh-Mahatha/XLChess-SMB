import { describe, expect, it } from 'vitest';
import type { ScheduleRule } from '../../../packages/shared/src/config/schema.js';
import {
  isTimedRule,
  nextOccurrence,
  occurrencesBetween,
  ruleKey,
  type TimedRule,
} from '../../../packages/shared/src/schedule/occurrences.js';

describe('schedule occurrences and rule evaluation', () => {
  it('handles weekly rule across DST change in America/New_York', () => {
    const rule: TimedRule = { kind: 'weekly', day: 'fri', time: '09:00' };
    const tz = 'America/New_York';
    // Nov 1 2026 is the DST fallback in NY (EDT -> EST)
    const after = new Date('2026-10-25T00:00:00Z');
    const upTo = new Date('2026-11-10T00:00:00Z');
    const anchor = new Date('2026-10-20T00:00:00Z');

    const slots = occurrencesBetween(rule, tz, after, upTo, anchor);
    expect(slots.map((s) => s.toISOString())).toEqual([
      '2026-10-30T13:00:00.000Z', // EDT (UTC-4)
      '2026-11-06T14:00:00.000Z', // EST (UTC-5)
    ]);
  });

  it('handles daily rule across DST spring-forward and fall-back in America/New_York', () => {
    const rule: TimedRule = { kind: 'daily', time: '02:30' };
    const tz = 'America/New_York';
    const anchor = new Date('2026-03-01T00:00:00Z');

    // Across spring gap: 2026-03-07 to 2026-03-10
    const springSlots = occurrencesBetween(
      rule,
      tz,
      new Date('2026-03-07T00:00:00Z'),
      new Date('2026-03-10T00:00:00Z'),
      anchor,
    );
    expect(springSlots.map((s) => s.toISOString())).toEqual([
      '2026-03-07T07:30:00.000Z', // 02:30 EST
      '2026-03-08T07:30:00.000Z', // gap shifted -> 03:30 EDT = 07:30Z
      '2026-03-09T06:30:00.000Z', // 02:30 EDT = 06:30Z
    ]);

    // Across fall-back: 2026-10-31 to 2026-11-02
    // 02:30 on Nov 1 is after 02:00 -> clocks already fell back to 01:00, so 02:30 occurs once under EST (07:30Z)
    const fallSlots = occurrencesBetween(
      rule,
      tz,
      new Date('2026-10-31T00:00:00Z'),
      new Date('2026-11-02T00:00:00Z'),
      anchor,
    );
    expect(fallSlots.map((s) => s.toISOString())).toEqual([
      '2026-10-31T06:30:00.000Z', // 02:30 EDT
      '2026-11-01T07:30:00.000Z', // 02:30 EST (fires once, never twice)
    ]);
  });

  it('respects range boundaries: after exclusive, upTo inclusive', () => {
    const rule: TimedRule = { kind: 'weekly', day: 'fri', time: '09:00' };
    const tz = 'UTC';
    const anchor = new Date('2026-11-01T00:00:00Z');

    const exactSlot = new Date('2026-11-20T09:00:00Z');
    const nextSlot = new Date('2026-11-27T09:00:00Z');

    // after == exactSlot -> excludes exactSlot
    const afterExact = occurrencesBetween(rule, tz, exactSlot, nextSlot, anchor);
    expect(afterExact.map((s) => s.toISOString())).toEqual(['2026-11-27T09:00:00.000Z']);

    // upTo == exactSlot -> includes exactSlot
    const upToExact = occurrencesBetween(
      rule,
      tz,
      new Date('2026-11-13T09:00:00Z'),
      exactSlot,
      anchor,
    );
    expect(upToExact.map((s) => s.toISOString())).toEqual(['2026-11-20T09:00:00.000Z']);
  });

  it('calculates intervals from anchor regardless of DST', () => {
    const rule: TimedRule = { kind: 'interval', everyMinutes: 1440 }; // 24 hours
    const anchor = new Date('2026-10-30T12:00:00Z');
    const after = new Date('2026-10-30T12:00:00Z');
    const upTo = new Date('2026-11-03T12:00:00Z');

    const slots = occurrencesBetween(rule, 'America/New_York', after, upTo, anchor);
    expect(slots.map((s) => s.toISOString())).toEqual([
      '2026-10-31T12:00:00.000Z',
      '2026-11-01T12:00:00.000Z',
      '2026-11-02T12:00:00.000Z',
      '2026-11-03T12:00:00.000Z',
    ]);
  });

  it('guards against non-timed rules, inverted range, and limit overflow', () => {
    const eventRule = { kind: 'event', event: 'game_completed' } as unknown as TimedRule;
    expect(isTimedRule(eventRule as ScheduleRule)).toBe(false);
    expect(() =>
      occurrencesBetween(eventRule, 'UTC', new Date(), new Date(), new Date()),
    ).toThrow(TypeError);

    const weekly: TimedRule = { kind: 'weekly', day: 'fri', time: '09:00' };
    expect(() =>
      occurrencesBetween(
        weekly,
        'UTC',
        new Date('2026-11-20T00:00:00Z'),
        new Date('2026-11-10T00:00:00Z'),
        new Date(),
      ),
    ).toThrow(RangeError);

    // Limit exceeded
    const daily: TimedRule = { kind: 'daily', time: '09:00' };
    expect(() =>
      occurrencesBetween(
        daily,
        'UTC',
        new Date('2026-01-01T00:00:00Z'),
        new Date('2026-01-10T00:00:00Z'),
        new Date(),
        3, // limit of 3 with 9 slots
      ),
    ).toThrow(RangeError);
  });

  it('computes nextOccurrence for the 1.1 base rule', () => {
    const rule: TimedRule = { kind: 'weekly', day: 'fri', time: '09:00' };
    const tz = 'UTC';
    const anchor = new Date('2026-11-01T00:00:00Z');

    const next = nextOccurrence(rule, tz, new Date('2026-11-18T12:00:00Z'), anchor);
    expect(next?.toISOString()).toBe('2026-11-20T09:00:00.000Z');
  });

  it('formats ruleKey strings', () => {
    expect(ruleKey({ kind: 'weekly', day: 'fri', time: '09:00' }, null, 'UTC')).toBe(
      'base|UTC|weekly|fri|09:00',
    );
    expect(
      ruleKey({ kind: 'daily', time: '18:30' }, 'tournament', 'Europe/London'),
    ).toBe('tournament|Europe/London|daily|18:30');
    expect(ruleKey({ kind: 'interval', everyMinutes: 1440 }, null, 'UTC')).toBe(
      'base|UTC|interval|1440',
    );
  });
});
