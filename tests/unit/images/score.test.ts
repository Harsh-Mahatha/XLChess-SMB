import { describe, expect, it } from 'vitest';
import { identityAllowed, scoreCandidate } from '@smb/shared';
import { candidate } from './helpers.js';

const NOW = new Date('2026-11-13T00:00:00Z');

describe('scoreCandidate', () => {
  it('rates a large, identity-matched, recent photo highly', () => {
    const s = scoreCandidate(candidate({ takenAt: '2026-06-01' }), undefined, NOW);
    expect(s.eligible).toBe(true);
    expect(s.score).toBeGreaterThan(0.85);
  });

  it('rejects small images and unsupported types', () => {
    expect(
      scoreCandidate(candidate({ width: 800, height: 600 }), undefined, NOW).rejections,
    ).toEqual(['too_small']);
    expect(scoreCandidate(candidate({ mime: 'image/tiff' }), undefined, NOW).rejections).toEqual([
      'unsupported_type',
    ]);
  });

  it('never shows a person found only by keyword search', () => {
    const c = candidate({ match: 'search' });
    expect(identityAllowed(c)).toBe(false);
    expect(scoreCandidate(c, undefined, NOW).rejections).toEqual(['weak_identity']);
  });

  it('allows keyword search for venues', () => {
    const c = candidate({ match: 'search', subject: { role: 'venue', name: 'Singapore' } });
    expect(scoreCandidate(c, undefined, NOW).eligible).toBe(true);
  });

  it('ranks a category match below an exact Wikidata match, deterministically', () => {
    const exact = scoreCandidate(candidate(), undefined, NOW);
    const cat = scoreCandidate(candidate({ match: 'category' }), undefined, NOW);
    expect(exact.score).toBeGreaterThan(cat.score);
    expect(scoreCandidate(candidate(), undefined, NOW)).toEqual(
      scoreCandidate(candidate(), undefined, NOW),
    );
  });

  it('prefers newer photos', () => {
    const old = scoreCandidate(candidate({ takenAt: '2010-01-01' }), undefined, NOW);
    const recent = scoreCandidate(candidate({ takenAt: '2026-01-01' }), undefined, NOW);
    expect(recent.score).toBeGreaterThan(old.score);
  });
});
