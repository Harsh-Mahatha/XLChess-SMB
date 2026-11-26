import { describe, expect, it } from 'vitest';
import {
  DetectedEventPayload,
  GameCompletedEvent,
  MAX_BACKOFF_MS,
  backoffDelayMs,
  gameIdentityKey,
  materialHash,
  type GameCompletedEvent as GameCompletedEventT,
} from '@smb/shared';

const base: GameCompletedEventT = {
  kind: 'game_completed',
  identityKey: 'world-championship-2026:game-7:result',
  championship: { postTypeId: '1.1', cycleKey: 'world-championship-2026', title: 'WCC 2026' },
  game: { kind: 'classical', number: 7, roundLabel: '7' },
  players: { white: { name: 'Gukesh D', fideId: '46616543' }, black: { name: 'Ding Liren' } },
  result: '1-0',
  scoreAfter: { a: 4, b: 3, basis: 'classical' },
  completedAt: '2026-11-27T18:00:00.000Z',
  confirmedAt: '2026-11-27T18:10:00.000Z',
  verification: 'official_entry',
  sources: [
    { sourceId: 'D1', externalId: 'world-championship-2026:game-7' },
    { sourceId: 'D3', externalId: 'abc123', url: 'https://lichess.org/broadcast/x/y/abc123' },
  ],
};

describe('GameCompletedEvent', () => {
  it('accepts a complete payload through the discriminated union', () => {
    expect(DetectedEventPayload.parse(base)).toEqual(base);
  });

  it.each([
    'identityKey',
    'championship',
    'game',
    'players',
    'result',
    'scoreAfter',
    'completedAt',
    'verification',
    'sources',
  ])('requires %s', (field) => {
    const copy: Record<string, unknown> = { ...base };
    delete copy[field];
    expect(GameCompletedEvent.safeParse(copy).success).toBe(false);
  });

  it("rejects an unfinished result ('*'), empty sources and unknown fields", () => {
    expect(GameCompletedEvent.safeParse({ ...base, result: '*' }).success).toBe(false);
    expect(GameCompletedEvent.safeParse({ ...base, sources: [] }).success).toBe(false);
    expect(GameCompletedEvent.safeParse({ ...base, extra: 1 }).success).toBe(false);
  });
});

describe('identity and material hash', () => {
  it('builds the same keys as the 1.15 championship record', () => {
    expect(gameIdentityKey('wcc-test-1', 'classical', 14)).toBe('wcc-test-1:game-14:result');
    expect(gameIdentityKey('wcc-test-1', 'tiebreak', 2)).toBe('wcc-test-1:tiebreak-2:result');
  });

  it('ignores key order and volatile fields', () => {
    const reordered = Object.fromEntries(
      Object.entries(base).reverse(),
    ) as unknown as GameCompletedEventT;
    expect(materialHash(reordered)).toBe(materialHash(base));
    const volatile: GameCompletedEventT = {
      ...base,
      completedAt: '2026-11-27T18:05:00.000Z',
      confirmedAt: '2026-11-27T19:00:00.000Z',
      sources: [{ sourceId: 'D1', externalId: 'world-championship-2026:game-7' }],
    };
    expect(materialHash(volatile)).toBe(materialHash(base));
  });

  it('changes when a material field changes', () => {
    const h = materialHash(base);
    expect(materialHash({ ...base, result: '1/2-1/2' })).not.toBe(h);
    expect(materialHash({ ...base, scoreAfter: { a: 3.5, b: 3.5, basis: 'classical' } })).not.toBe(
      h,
    );
    expect(materialHash({ ...base, verification: 'corroborated' })).not.toBe(h);
  });
});

describe('backoffDelayMs', () => {
  const mid = () => 0.5; // no jitter

  it('doubles per failure and caps at 10 minutes', () => {
    expect(backoffDelayMs(60_000, 1, mid)).toBe(120_000);
    expect(backoffDelayMs(60_000, 2, mid)).toBe(240_000);
    expect(backoffDelayMs(60_000, 3, mid)).toBe(480_000);
    expect(backoffDelayMs(60_000, 4, mid)).toBe(MAX_BACKOFF_MS);
    expect(backoffDelayMs(60_000, 50, mid)).toBe(MAX_BACKOFF_MS);
  });

  it('keeps jitter within ±10% and never above the cap', () => {
    expect(backoffDelayMs(60_000, 1, () => 0)).toBe(108_000);
    expect(backoffDelayMs(60_000, 1, () => 0.999999)).toBeLessThanOrEqual(132_000);
    expect(backoffDelayMs(60_000, 1, () => 0.999999)).toBeGreaterThan(131_000);
    expect(backoffDelayMs(600_000, 1, () => 0.999999)).toBe(MAX_BACKOFF_MS);
  });
});
