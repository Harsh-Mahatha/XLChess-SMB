import { describe, expect, it } from 'vitest';
import { detectPhase, type PhaseInput } from '@smb/shared';

const BASE_START = new Date('2026-11-20T10:00:00Z');
const BASE_END = new Date('2026-12-05T10:00:00Z');

function input(overrides: Partial<PhaseInput> = {}): PhaseInput {
  return {
    now: new Date('2026-11-18T10:00:00Z'),
    phase: 'pre_tournament',
    locked: false,
    scheduledStart: BASE_START,
    scheduledEnd: BASE_END,
    feedStatus: 'upcoming',
    feedOk: true,
    anyGameObserved: false,
    classical: { total: 14, confirmed: 0, observedFinal: 0 },
    score: { a: 0, b: 0 },
    lastFeedOkAt: new Date('2026-11-18T10:00:00Z'),
    ...overrides,
  };
}

describe('detectPhase', () => {
  it('stays in pre_tournament when feed is upcoming', () => {
    const res = detectPhase(input());
    expect(res.next).toBe('pre_tournament');
    expect(res.flags).toEqual([]);
  });

  it('locked cycle never changes phase, explains what would have happened, and still computes flags', () => {
    const res = detectPhase(
      input({
        locked: true,
        now: new Date('2026-11-20T10:00:00Z'),
        feedStatus: 'in_progress',
      }),
    );
    expect(res.next).toBe('pre_tournament');
    expect(res.reasons[0]).toMatch(/locked/i);
    expect(res.reasons[0]).toMatch(/tournament/);

    const withFlag = detectPhase(
      input({
        locked: true,
        now: new Date('2026-11-18T00:00:00Z'), // > 24h before start
        feedStatus: 'in_progress',
      }),
    );
    expect(withFlag.next).toBe('pre_tournament');
    expect(withFlag.flags.map((f) => f.kind)).toContain('premature_start');
  });

  it('pre_tournament -> tournament when feed started within 24h of scheduledStart', () => {
    const res = detectPhase(
      input({
        now: new Date('2026-11-19T12:00:00Z'), // 22h before start
        feedStatus: 'in_progress',
      }),
    );
    expect(res.next).toBe('tournament');
    expect(res.flags).toEqual([]);
  });

  it('pre_tournament -> tournament when feed is completed and within start window (caller loops)', () => {
    const res = detectPhase(
      input({
        now: new Date('2026-12-06T10:00:00Z'),
        feedStatus: 'completed',
        classical: { total: 14, confirmed: 14, observedFinal: 14 },
        score: { a: 7.5, b: 6.5 },
      }),
    );
    expect(res.next).toBe('tournament');
  });

  it('pre_tournament -> tournament when anyGameObserved is true within start window', () => {
    const res = detectPhase(
      input({
        now: new Date('2026-11-20T10:05:00Z'),
        feedStatus: 'upcoming',
        anyGameObserved: true,
      }),
    );
    expect(res.next).toBe('tournament');
  });

  it('pre_tournament with started feed > 24h early stays pre_tournament and flags premature_start', () => {
    const res = detectPhase(
      input({
        now: new Date('2026-11-18T09:00:00Z'), // 49h before start
        feedStatus: 'in_progress',
      }),
    );
    expect(res.next).toBe('pre_tournament');
    expect(res.flags).toEqual([
      expect.objectContaining({ kind: 'premature_start', severity: 'blocking', autoClear: true }),
    ]);
  });

  it('pre_tournament not started > 24h past scheduledStart with healthy feed flags late_start', () => {
    const res = detectPhase(
      input({
        now: new Date('2026-11-21T11:00:00Z'), // 25h after start
        feedStatus: 'upcoming',
        feedOk: true,
      }),
    );
    expect(res.next).toBe('pre_tournament');
    expect(res.flags).toEqual([
      expect.objectContaining({ kind: 'late_start', severity: 'blocking', autoClear: true }),
    ]);
  });

  it('tournament -> post_tournament when feed completed, all classical confirmed, and unique winner', () => {
    const res = detectPhase(
      input({
        now: new Date('2026-12-05T15:00:00Z'),
        phase: 'tournament',
        feedStatus: 'completed',
        classical: { total: 14, confirmed: 14, observedFinal: 14 },
        score: { a: 7.5, b: 6.5 },
      }),
    );
    expect(res.next).toBe('post_tournament');
    expect(res.flags).toEqual([]);
  });

  it('tournament with feed completed and unconfirmed classical games stays and flags unconfirmed_games', () => {
    const res = detectPhase(
      input({
        now: new Date('2026-12-05T15:00:00Z'),
        phase: 'tournament',
        feedStatus: 'completed',
        classical: { total: 14, confirmed: 12, observedFinal: 14, unconfirmedNumbers: [13, 14] },
        score: { a: 6.5, b: 5.5 },
      }),
    );
    expect(res.next).toBe('tournament');
    expect(res.flags).toEqual([
      expect.objectContaining({
        kind: 'unconfirmed_games',
        severity: 'advisory',
        autoClear: true,
        detail: expect.objectContaining({ numbers: [13, 14] }),
      }),
    ]);
  });

  it('tournament with early clinch flags conclusion_unconfirmed', () => {
    const res = detectPhase(
      input({
        now: new Date('2026-11-30T15:00:00Z'),
        phase: 'tournament',
        feedStatus: 'in_progress',
        classical: { total: 14, confirmed: 10, observedFinal: 10 },
        score: { a: 7.5, b: 2.5 },
      }),
    );
    expect(res.next).toBe('tournament');
    expect(res.flags).toEqual([
      expect.objectContaining({
        kind: 'conclusion_unconfirmed',
        severity: 'advisory',
        autoClear: true,
      }),
    ]);
  });

  it('tournament with all classical confirmed and tied score flags no_unique_winner', () => {
    const res = detectPhase(
      input({
        now: new Date('2026-12-05T15:00:00Z'),
        phase: 'tournament',
        feedStatus: 'completed',
        classical: { total: 14, confirmed: 14, observedFinal: 14 },
        score: { a: 7, b: 7 },
      }),
    );
    expect(res.next).toBe('tournament');
    expect(res.flags).toEqual([
      expect.objectContaining({
        kind: 'no_unique_winner',
        severity: 'advisory',
        autoClear: true,
      }),
    ]);
  });

  it('tournament never regresses to pre_tournament when feed reports upcoming; flags feed_regressed', () => {
    const res = detectPhase(
      input({
        now: new Date('2026-11-22T12:00:00Z'),
        phase: 'tournament',
        feedStatus: 'upcoming',
        feedOk: true,
      }),
    );
    expect(res.next).toBe('tournament');
    expect(res.flags).toEqual([
      expect.objectContaining({ kind: 'feed_regressed', severity: 'blocking', autoClear: true }),
    ]);
  });

  it('tournament past scheduledEnd + 48h flags overdue_conclusion', () => {
    const res = detectPhase(
      input({
        now: new Date('2026-12-07T11:00:00Z'), // 49h past end
        phase: 'tournament',
        feedStatus: 'in_progress',
      }),
    );
    expect(res.next).toBe('tournament');
    expect(res.flags).toEqual([
      expect.objectContaining({
        kind: 'overdue_conclusion',
        severity: 'advisory',
        autoClear: true,
      }),
    ]);
  });

  it('tournament outage > 6h flags feed_unavailable and does not change phase', () => {
    const res = detectPhase(
      input({
        now: new Date('2026-11-22T17:00:00Z'),
        phase: 'tournament',
        feedStatus: null,
        feedOk: false,
        lastFeedOkAt: new Date('2026-11-22T10:00:00Z'), // 7h ago
      }),
    );
    expect(res.next).toBe('tournament');
    expect(res.flags).toEqual([
      expect.objectContaining({
        kind: 'feed_unavailable',
        severity: 'advisory',
        autoClear: true,
      }),
    ]);
  });

  it('post_tournament never changes automatically', () => {
    const res = detectPhase(
      input({
        now: new Date('2026-12-10T10:00:00Z'),
        phase: 'post_tournament',
        feedStatus: 'upcoming',
      }),
    );
    expect(res.next).toBe('post_tournament');
    expect(res.flags).toEqual([]);
  });
});
