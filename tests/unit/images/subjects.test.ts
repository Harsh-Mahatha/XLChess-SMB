import { describe, expect, it } from 'vitest';
import { loadConfigSet } from '../../../apps/api/src/config/loader.js';
import {
  IMAGE_ADAPTERS,
  createImageRuntimes,
  subjectsFromClaims,
} from '../../../apps/api/src/images/index.js';

const claims = (extra: { claim_key: string; value: unknown }[] = []) => [
  {
    claim_key: 'participants',
    value: [
      { name: 'Ding L', fideId: '8603677' },
      { name: 'Gukesh D', fideId: '46616543' },
      { name: 'Sindarov J', fideId: '14204118' },
      { name: 'No Id' },
    ],
  },
  { claim_key: 'game.result', value: { result: '1-0', white: 'Gukesh D', black: 'Sindarov J' } },
  { claim_key: 'event.name', value: 'World Championship 2026' },
  { claim_key: 'event.venue', value: 'Singapore' },
  ...extra,
];

describe('subjectsFromClaims', () => {
  it('takes the players of the game first, found by FIDE id, then the event and venue', () => {
    const plan = subjectsFromClaims(claims());
    expect(plan.subjects).toEqual([
      { role: 'player', name: 'Gukesh D', fideId: '46616543' },
      { role: 'player', name: 'Sindarov J', fideId: '14204118' },
      { role: 'event', name: 'World Championship 2026' },
      { role: 'venue', name: 'Singapore' },
    ]);
  });

  it('skips a player with no FIDE id and says why', () => {
    const plan = subjectsFromClaims(
      [{ claim_key: 'participants', value: [{ name: 'No Id' }, { name: 'Bad', fideId: 'abc' }] }],
      { maxPlayers: 2 },
    );
    expect(plan.subjects).toEqual([]);
    expect(plan.skipped).toHaveLength(2);
    expect(plan.skipped[0]).toMatch(/No Id: no FIDE id/);
  });

  it('copes with missing or odd claims', () => {
    expect(subjectsFromClaims([]).subjects).toEqual([]);
    expect(
      subjectsFromClaims([
        { claim_key: 'participants', value: 'nope' },
        { claim_key: 'event.name', value: 42 },
        { claim_key: 'event.venue', value: '  ' },
      ]).subjects,
    ).toEqual([]);
  });

  it('limits the number of players', () => {
    expect(
      subjectsFromClaims(claims(), { maxPlayers: 1 }).subjects.filter((s) => s.role === 'player'),
    ).toHaveLength(1);
  });
});

describe('createImageRuntimes', () => {
  it('builds a runtime only for Wikimedia Commons; the other image sources fail closed', () => {
    const rt = createImageRuntimes(loadConfigSet().sources, { userAgent: 'ua' });
    expect([...rt.keys()]).toEqual(['I1']);
    expect(rt.get('I1')!.adapter.downloadHosts).toEqual(['upload.wikimedia.org']);
  });

  it('refuses to start when an approved source has no adapter', () => {
    expect(() =>
      createImageRuntimes(loadConfigSet().sources, { userAgent: 'ua', adapters: [] }),
    ).toThrow(/I1 declares roles .* no adapter/);
  });

  it('leaves out a disabled source', () => {
    const reg = structuredClone(loadConfigSet().sources);
    reg.sources.find((s) => s.id === 'I1')!.enabled = false;
    expect(createImageRuntimes(reg, { userAgent: 'ua' }).size).toBe(0);
  });

  it('has an adapter for every image source the registry approves', () => {
    expect(IMAGE_ADAPTERS.map((a) => a.id)).toEqual(['I1']);
  });
});
