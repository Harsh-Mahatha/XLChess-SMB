import { describe, expect, it } from 'vitest';
import { assess, type Observation } from '../../../apps/api/src/research/verify.js';
import { PlayerDirectory, normaliseName } from '../../../apps/api/src/research/identity.js';
import { confidenceFor, meetsMinimum, weakestVerification, FACT_CATALOGUE } from '@smb/shared';

const o = (
  sourceId: string,
  reliability: Observation['reliability'],
  value: unknown,
  n = 1,
): Observation => ({
  sourceId,
  reliability,
  value,
  recordId: `rec-${sourceId}-${n}`,
  payloadHash: `${sourceId}${n}`.padEnd(64, '0'),
});

describe('assess', () => {
  it('no observations: unverified', () => {
    expect(assess([])).toMatchObject({ verification: 'unverified', confidence: 0, recordIds: [] });
  });

  it('one structured feed: single_source', () => {
    const a = assess([o('D3', 'structured_feed', '1-0')]);
    expect(a).toMatchObject({ value: '1-0', verification: 'single_source', confidence: 0.8 });
  });

  it('one official source: verified', () => {
    expect(assess([o('D1', 'official', '1-0')])).toMatchObject({
      verification: 'verified',
      confidence: 0.95,
    });
  });

  it('two independent sources that agree: verified, with a confidence bonus', () => {
    const a = assess([o('D3', 'structured_feed', '1-0'), o('D4', 'publication', '1-0')]);
    expect(a.verification).toBe('verified');
    expect(a.confidence).toBe(0.9);
    expect(a.recordIds).toHaveLength(2);
  });

  it('two records from the same source are not independent', () => {
    const a = assess([o('D3', 'structured_feed', '1-0', 1), o('D3', 'structured_feed', '1-0', 2)]);
    expect(a.verification).toBe('single_source');
  });

  it('disagreement with no official source: conflicting, both values kept', () => {
    const a = assess([o('D3', 'structured_feed', '1-0'), o('D4', 'publication', '0-1')]);
    expect(a.verification).toBe('conflicting');
    expect(a.confidence).toBe(0.3);
    expect(a.conflict).toMatchObject({ resolved: false });
    expect(a.conflict?.candidates.map((c) => c.value).sort()).toEqual(['0-1', '1-0']);
    expect(a.value).toEqual({ conflict: expect.any(Array) });
  });

  it('an official source settles a disagreement, and the conflict stays on record', () => {
    const a = assess([o('D3', 'structured_feed', '1-0'), o('D1', 'official', '1/2-1/2')]);
    expect(a).toMatchObject({ value: '1/2-1/2', verification: 'verified' });
    expect(a.conflict).toMatchObject({ resolved: true, resolvedAgainst: 'D1' });
    expect(a.recordIds).toHaveLength(2);
  });

  it('officials that disagree with each other stay conflicting', () => {
    const a = assess([o('D1', 'official', 'a'), o('D9', 'official', 'b')]);
    expect(a.verification).toBe('conflicting');
  });

  it('compares with a custom canonical form', () => {
    const a = assess(
      [
        o('D3', 'structured_feed', 'World  Championship'),
        o('D4', 'publication', 'world championship'),
      ],
      (v) => String(v).toLowerCase().replace(/\s+/g, ' '),
    );
    expect(a.verification).toBe('verified');
  });
});

describe('verification rules', () => {
  it('meetsMinimum', () => {
    expect(meetsMinimum('verified', 'verified')).toBe(true);
    expect(meetsMinimum('verified', 'single_source')).toBe(true);
    expect(meetsMinimum('single_source', 'single_source')).toBe(true);
    expect(meetsMinimum('single_source', 'verified')).toBe(false);
    expect(meetsMinimum('conflicting', 'single_source')).toBe(false);
    expect(meetsMinimum('unverified', 'single_source')).toBe(false);
  });

  it('weakestVerification', () => {
    expect(weakestVerification(['verified', 'single_source'])).toBe('single_source');
    expect(weakestVerification(['verified', 'conflicting', 'single_source'])).toBe('conflicting');
    expect(weakestVerification(['verified', 'unverified'])).toBe('unverified');
    expect(weakestVerification([])).toBe('unverified');
  });

  it('confidence is capped below 1', () => {
    expect(confidenceFor('official', 3)).toBe(0.99);
  });

  it('results, scores and standings need verified; descriptive facts accept a single feed', () => {
    for (const k of ['game.result', 'match.score', 'match.situation', 'event.outcome'] as const) {
      expect(FACT_CATALOGUE[k].minVerification).toBe('verified');
    }
    for (const k of ['event.name', 'event.dates', 'event.venue', 'next_game'] as const) {
      expect(FACT_CATALOGUE[k].minVerification).toBe('single_source');
    }
  });
});

describe('player identity', () => {
  it('normalises accents, case, punctuation and word order', () => {
    expect(normaliseName('Carlsen, Magnus')).toBe(normaliseName('magnus CARLSEN'));
    expect(normaliseName('Nepomniachtchi, Ian')).toBe(normaliseName('Ian Nepomniachtchi'));
    expect(normaliseName('Šimić, Ana')).toBe(normaliseName('Ana Simic'));
  });

  it('merges records of one player by FIDE id and by name, and keeps the best rating', () => {
    const dir = new PlayerDirectory([
      { name: 'Magnus Carlsen', fideId: '1503014', rating: 2830 },
      { name: 'Carlsen, Magnus', rating: 2834 },
      { name: 'Hikaru Nakamura', fideId: '2016192' },
    ]);
    expect(dir.all()).toHaveLength(2);
    const key = dir.keyOf({ name: 'Carlsen, Magnus' });
    expect(key).toBe('fide:1503014');
    expect(dir.person(key)).toMatchObject({ name: 'Magnus Carlsen', rating: 2834 });
  });

  it('never merges two different FIDE ids that share a name', () => {
    const dir = new PlayerDirectory([
      { name: 'Wei Yi', fideId: '1' },
      { name: 'Wei Yi', fideId: '2' },
    ]);
    expect(dir.keyOf({ name: 'Wei Yi', fideId: '1' })).not.toBe(
      dir.keyOf({ name: 'Wei Yi', fideId: '2' }),
    );
  });
});
