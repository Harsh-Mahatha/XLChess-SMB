import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HEALTH_THRESHOLDS,
  JobUsage,
  buildStreak,
  classifyDay,
  computeCost,
  daysBetween,
  evaluateHealth,
  meterProvider,
  rateAt,
  type AiProvider,
  type CostRate,
  type DayTally,
  type HealthInputs,
} from '@smb/shared';

const day = (d: string, posts: number, clean: number, pending = 0): DayTally => ({
  day: d,
  posts,
  clean,
  pending,
});

describe('classifyDay', () => {
  it('is clean only when every post is clean and none is waiting', () => {
    expect(classifyDay(day('2026-11-01', 2, 2), 1).status).toBe('clean');
  });

  it('is broken by a rejected or edited post, which is a decided post that is not clean', () => {
    const r = classifyDay(day('2026-11-01', 3, 2), 1);
    expect(r.status).toBe('broken');
    expect(r.notClean).toBe(1);
  });

  it('is incomplete while a post is undecided, and does not call it clean', () => {
    expect(classifyDay(day('2026-11-01', 2, 1, 1), 1).status).toBe('incomplete');
  });

  it('is not evaluated below the required volume', () => {
    expect(classifyDay(day('2026-11-01', 1, 1), 2).status).toBe('below_volume');
    expect(classifyDay(day('2026-11-01', 0, 0), 1).status).toBe('below_volume');
  });

  it('counts rejected posts towards the volume so a day cannot hide them', () => {
    // Two posts reached review and both were rejected: volume 2 is met, so the day is evaluated and broken.
    expect(classifyDay(day('2026-11-01', 2, 0), 2).status).toBe('broken');
  });

  it('lets a broken post outrank an undecided one', () => {
    expect(classifyDay(day('2026-11-01', 3, 1, 1), 1).status).toBe('broken');
  });
});

describe('buildStreak', () => {
  const window = { from: '2026-11-01', to: '2026-11-12' };
  const clean = (d: string): DayTally => day(d, 1, 1);

  it('counts consecutive clean days back from the latest', () => {
    const t = ['03', '04', '05', '06', '07', '08', '09', '10', '11', '12'].map((n) =>
      clean(`2026-11-${n}`),
    );
    const r = buildStreak(t, window, { requiredDailyVolume: 1 });
    expect(r.current).toBe(10);
    expect(r.goalReached).toBe(true);
    expect(r.brokenOn).toBeNull();
  });

  it('is reset by a broken day, and reports where', () => {
    const t = [
      clean('2026-11-08'),
      day('2026-11-09', 2, 1),
      clean('2026-11-10'),
      clean('2026-11-11'),
      clean('2026-11-12'),
    ];
    const r = buildStreak(t, window, { requiredDailyVolume: 1 });
    expect(r.current).toBe(3);
    expect(r.brokenOn).toBe('2026-11-09');
    expect(r.goalReached).toBe(false);
  });

  it('skips days under the volume without breaking or extending the run', () => {
    const t = [clean('2026-11-09'), clean('2026-11-11'), clean('2026-11-12')];
    const r = buildStreak(t, window, { requiredDailyVolume: 1 });
    expect(r.current).toBe(3); // 11-10 had no posts and is not evaluated
  });

  it('skips an undecided day: it neither counts nor breaks', () => {
    const t = [clean('2026-11-10'), day('2026-11-11', 1, 0, 1), clean('2026-11-12')];
    const r = buildStreak(t, window, { requiredDailyVolume: 1 });
    expect(r.current).toBe(2);
    expect(r.days.find((d) => d.day === '2026-11-11')?.status).toBe('incomplete');
  });

  it('keeps the best run separate from the current one', () => {
    const t = [
      clean('2026-11-01'),
      clean('2026-11-02'),
      clean('2026-11-03'),
      day('2026-11-04', 1, 0),
      clean('2026-11-05'),
    ];
    const r = buildStreak(t, window, { requiredDailyVolume: 1 });
    expect(r.best).toBe(3);
    expect(r.current).toBe(1);
  });

  it('says when the window may be hiding a longer streak', () => {
    const t = daysBetween('2026-11-01', '2026-11-12').map(clean);
    expect(buildStreak(t, window).windowLimited).toBe(true);
    expect(buildStreak([day('2026-11-12', 1, 0)], window).windowLimited).toBe(false);
  });

  it('has no streak when nothing was reviewed', () => {
    const r = buildStreak([], window, { requiredDailyVolume: 1 });
    expect(r.current).toBe(0);
    expect(r.days).toHaveLength(12);
  });
});

describe('cost', () => {
  const rates: CostRate[] = [
    {
      effectiveFrom: '2026-01-01',
      currency: 'USD',
      gpuWatts: 300,
      electricityPerKwh: 0.2,
      serverMonthly: 30,
      xApiMonthly: 0,
      reviewerHourly: 12,
    },
    {
      effectiveFrom: '2026-11-15',
      currency: 'USD',
      gpuWatts: 300,
      electricityPerKwh: 0.4,
      serverMonthly: 30,
      xApiMonthly: 60,
      reviewerHourly: 12,
    },
  ];

  it('picks the rate in force on a day', () => {
    expect(rateAt(rates, '2026-11-14')?.electricityPerKwh).toBe(0.2);
    expect(rateAt(rates, '2026-11-15')?.electricityPerKwh).toBe(0.4);
    expect(rateAt(rates, '2025-01-01')?.effectiveFrom).toBe('2026-01-01');
  });

  it('prices each day at its own rate when the price changes inside a period', () => {
    const usage = [
      { day: '2026-11-14', gpuSeconds: 3600, reviewSeconds: 0 },
      { day: '2026-11-15', gpuSeconds: 3600, reviewSeconds: 0 },
    ];
    const r = computeCost(rates, usage, ['2026-11-14', '2026-11-15'], 2);
    // 0.3 kW for an hour: 0.3 * 0.2 + 0.3 * 0.4
    expect(r.compute).toBeCloseTo(0.18, 4);
  });

  it('spreads monthly costs over the days of the month', () => {
    const r = computeCost(rates, [], ['2026-11-01', '2026-11-02'], 1);
    expect(r.server).toBeCloseTo((30 / 30) * 2, 4);
    expect(r.xApi).toBe(0);
  });

  it('charges review time at the hourly rate', () => {
    const r = computeCost(
      rates,
      [{ day: '2026-11-01', gpuSeconds: 0, reviewSeconds: 1800 }],
      ['2026-11-01'],
      1,
    );
    expect(r.review).toBe(6);
  });

  it('puts the whole spend on the approved posts, so rejected work is not free', () => {
    const usage = [{ day: '2026-11-01', gpuSeconds: 7200, reviewSeconds: 0 }];
    const approvedOne = computeCost(rates, usage, ['2026-11-01'], 1);
    const approvedTwo = computeCost(rates, usage, ['2026-11-01'], 2);
    expect(approvedTwo.perApprovedPost).toBeCloseTo((approvedOne.perApprovedPost ?? 0) / 2, 4);
    expect(computeCost(rates, usage, ['2026-11-01'], 0).perApprovedPost).toBeNull();
  });

  it('ignores usage outside the period', () => {
    const r = computeCost(
      rates,
      [{ day: '2026-10-01', gpuSeconds: 3600, reviewSeconds: 3600 }],
      ['2026-11-01'],
      1,
    );
    expect(r.gpuSeconds).toBe(0);
    expect(r.review).toBe(0);
  });

  it('lists the prices that were never set instead of counting them as free', () => {
    const zero: CostRate[] = [
      { ...rates[0]!, electricityPerKwh: 0, reviewerHourly: 0, xApiMonthly: 0 },
    ];
    const r = computeCost(zero, [], ['2026-11-01'], 1);
    expect(r.unpriced).toEqual(['electricityPerKwh', 'xApiMonthly', 'reviewerHourly']);
  });
});

describe('evaluateHealth', () => {
  const now = new Date('2026-11-20T12:00:00Z');
  const ago = (minutes: number): Date => new Date(now.getTime() - minutes * 60_000);
  const quiet: HealthInputs = {
    workers: [{ id: 'w1', lastSeenAt: ago(1) }],
    gpuJobsQueued: 0,
    oldestGpuJobQueuedAt: null,
    deadJobsLast24h: 0,
    publicationsFailed: 0,
    publicationsUncertain: 0,
    pollersFailing: [],
    oldestReviewWaitingAt: null,
  };
  const keys = (i: HealthInputs): string[] =>
    evaluateHealth(i, now, DEFAULT_HEALTH_THRESHOLDS).map((a) => a.key);

  it('has nothing to say when everything is fine', () => {
    expect(keys(quiet)).toEqual([]);
  });

  it('flags GPU jobs that wait while no worker has been seen', () => {
    const waiting = { ...quiet, gpuJobsQueued: 2, oldestGpuJobQueuedAt: ago(30) };
    expect(keys({ ...waiting, workers: [{ id: 'w1', lastSeenAt: ago(60) }] })).toEqual([
      'worker_offline',
    ]);
    expect(keys({ ...waiting, workers: [] })).toEqual(['worker_offline']);
    expect(keys(waiting)).toEqual([]); // the worker is online and will pick them up
  });

  it('does not flag a job that has only just been queued', () => {
    expect(keys({ ...quiet, workers: [], gpuJobsQueued: 1, oldestGpuJobQueuedAt: ago(2) })).toEqual(
      [],
    );
  });

  it('flags dead jobs, failed and uncertain publications, failing pollers and old review items', () => {
    const k = keys({
      ...quiet,
      deadJobsLast24h: 1,
      publicationsFailed: 1,
      publicationsUncertain: 1,
      pollersFailing: [
        { id: 'a', consecutiveFailures: 3, lastError: null },
        { id: 'b', consecutiveFailures: 1, lastError: null },
      ],
      oldestReviewWaitingAt: ago(7 * 60),
    });
    expect(k).toEqual([
      'dead_jobs',
      'publications_uncertain',
      'publications_failed',
      'source_failing',
      'review_waiting',
    ]);
  });

  it('reports only the pollers over the threshold', () => {
    const [alert] = evaluateHealth(
      {
        ...quiet,
        pollersFailing: [
          { id: 'a', consecutiveFailures: 3, lastError: null },
          { id: 'b', consecutiveFailures: 2, lastError: null },
        ],
      },
      now,
    );
    expect(alert?.detail).toEqual({ pollers: ['a'] });
  });
});

describe('job usage', () => {
  it('adds up model calls and their tokens', async () => {
    const fake = {
      name: 'fake',
      model: 'fake-1',
      generate: async () => ({
        output: 'x',
        provider: 'fake',
        model: 'fake-1',
        settings: {},
        durationMs: 100,
        promptTokens: 40,
        completionTokens: 10,
        repaired: false,
      }),
    } as unknown as AiProvider;
    const meter = meterProvider(fake);
    const task = { name: 't', promptVersion: 'p@1#a', messages: [], schema: {} } as never;
    await meter.provider.generate(task);
    await meter.provider.generate(task);
    expect(meter.usage().llm).toEqual({
      calls: 2,
      durationMs: 200,
      promptTokens: 80,
      completionTokens: 20,
      model: 'fake-1',
    });
  });

  it('accepts what a worker sends and refuses what it should not', () => {
    expect(
      JobUsage.safeParse({
        gpuMs: 1200,
        llm: { calls: 4, durationMs: 900, promptTokens: 100, completionTokens: 50 },
      }).success,
    ).toBe(true);
    expect(JobUsage.safeParse({ prompt: 'a secret prompt' }).success).toBe(false);
    expect(JobUsage.safeParse({ gpuMs: -1 }).success).toBe(false);
  });
});
