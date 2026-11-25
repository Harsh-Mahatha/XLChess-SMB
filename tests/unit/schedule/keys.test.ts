import { describe, expect, it } from 'vitest';
import {
  isoWeekLabel,
  renderDedupeKey,
  scheduleSlotLabel,
} from '../../../packages/shared/src/schedule/keys.js';

describe('dedupe keys and labels', () => {
  it('calculates ISO week labels correctly including year boundaries', () => {
    // 2026-01-01 is Thursday -> 2026-W01
    expect(isoWeekLabel({ year: 2026, month: 1, day: 1 })).toBe('2026-W01');

    // 2026-12-31 is Thursday -> 2026-W53
    expect(isoWeekLabel({ year: 2026, month: 12, day: 31 })).toBe('2026-W53');

    // 2027-01-01 is Friday -> belongs to 2026-W53
    expect(isoWeekLabel({ year: 2027, month: 1, day: 1 })).toBe('2026-W53');

    // 2026-11-20 is Friday in week 47
    expect(isoWeekLabel({ year: 2026, month: 11, day: 20 })).toBe('2026-W47');
  });

  it('formats scheduleSlotLabel in UTC', () => {
    const slot = new Date('2026-11-20T09:00:00Z');
    expect(scheduleSlotLabel(slot)).toBe('s20261120T0900Z');
  });

  it('renders dedupe key with template and variables', () => {
    const rendered = renderDedupeKey('{postType}:{eventId}:{slot}', {
      postType: '1.1',
      eventId: 'pt1-1',
      slot: 's20261120T0900Z',
      date: '2026-11-20',
      week: '2026-W47',
    });
    expect(rendered).toBe('1.1:pt1-1:s20261120T0900Z');

    const withDateAndWeek = renderDedupeKey('{postType}:{date}:{week}', {
      postType: '1.1',
      eventId: 'pt1-1',
      slot: 's20261120T0900Z',
      date: '2026-11-20',
      week: '2026-W47',
    });
    expect(withDateAndWeek).toBe('1.1:2026-11-20:2026-W47');
  });

  it('throws on unknown placeholder', () => {
    expect(() =>
      renderDedupeKey('{postType}:{invalidPlaceholder}', {
        postType: '1.1',
        eventId: 'pt1-1',
        slot: 's20261120T0900Z',
        date: '2026-11-20',
        week: '2026-W47',
      }),
    ).toThrow(RangeError);
  });
});
