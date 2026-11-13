import { describe, expect, it } from 'vitest';
import { SourcesRegistry } from '@smb/shared';
import { loadConfigSet } from '../../../apps/api/src/config/loader.js';

const base = () => structuredClone(loadConfigSet().sources) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
const d = (r: any, id: string) => r.sources.find((s: any) => s.id === id); // eslint-disable-line @typescript-eslint/no-explicit-any

describe('source registry (config/sources.json)', () => {
  it('approves Lichess only; the other data sources fail closed', () => {
    const { sources } = loadConfigSet().sources;
    const data = sources.filter((s) => s.kind === 'data');
    expect(data.map((s) => s.id)).toEqual(['D1', 'D2', 'D3', 'D4', 'D5']);
    for (const s of data) {
      if (s.kind !== 'data') continue;
      if (s.id === 'D3') {
        expect(s.policy.status).toBe('approved');
        expect(s.capabilities).toEqual(['events', 'games']);
        expect(s.reliability).toBe('structured_feed');
      } else {
        expect(s.policy.status).toBe('pending_verification');
        expect(s.policy.automatedRetrieval).toBe(false);
        expect(s.capabilities).toEqual([]);
      }
    }
  });

  it('approves Wikimedia Commons only; the other image sources fail closed', () => {
    const images = loadConfigSet().sources.sources.filter((s) => s.kind === 'image');
    expect(images.map((s) => s.id)).toEqual(['I1', 'I2', 'I3', 'I4']);
    for (const s of images) {
      if (s.kind !== 'image') continue;
      if (s.id === 'I1') {
        expect(s.policy.status).toBe('approved');
        expect(s.roles).toEqual(['player', 'event', 'venue', 'generic']);
      } else {
        expect(s.policy.status).toBe('pending_verification');
        expect(s.policy.automatedRetrieval).toBe(false);
        expect(s.roles).toEqual([]);
      }
    }
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bad: [string, (r: any) => void, RegExp][] = [
    [
      'capabilities on an unapproved source',
      (r) => (d(r, 'D1').capabilities = ['players']),
      /capabilities require policy.status/,
    ],
    [
      'automated retrieval without approval',
      (r) => (d(r, 'D2').policy.automatedRetrieval = true),
      /automatedRetrieval requires policy.status/,
    ],
    [
      'approved without verification date',
      (r) => delete d(r, 'D3').policy.verifiedAt,
      /needs policy.verifiedAt/,
    ],
    [
      'approved without terms URL',
      (r) => delete d(r, 'D3').access.termsUrl,
      /needs access.termsUrl/,
    ],
    [
      'approved but unverified reliability',
      (r) => (d(r, 'D3').reliability = 'unverified'),
      /unverified source cannot be approved/,
    ],
    [
      'capabilities with no access method',
      (r) => (d(r, 'D3').access.method = 'none'),
      /require an access method/,
    ],
    [
      'duplicate capability',
      (r) => (d(r, 'D3').capabilities = ['games', 'games']),
      /duplicate capability/,
    ],
    ['unknown capability', (r) => (d(r, 'D3').capabilities = ['tweets']), /Invalid enum value/],
    ['limits missing', (r) => delete d(r, 'D3').limits, /Required/],
    [
      'duplicate id',
      (r) => r.sources.push(structuredClone(d(r, 'D3'))),
      /source ids must be unique/,
    ],
    [
      'roles on an unapproved image source',
      (r) => (d(r, 'I2').roles = ['generic']),
      /roles require/,
    ],
    ['duplicate image role', (r) => (d(r, 'I1').roles = ['player', 'player']), /duplicate role/],
    ['approved image source without terms', (r) => delete d(r, 'I1').access.termsUrl, /termsUrl/],
    ['unknown image role', (r) => (d(r, 'I1').roles = ['portrait']), /Invalid enum value/],
    ['data id on image kind', (r) => (d(r, 'I1').id = 'D9'), /./],
  ];
  it.each(bad)('rejects %s', (_name, mutate, pattern) => {
    const r = base();
    mutate(r);
    const parsed = SourcesRegistry.safeParse(r);
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(JSON.stringify(parsed.error.issues)).toMatch(pattern);
  });
});
