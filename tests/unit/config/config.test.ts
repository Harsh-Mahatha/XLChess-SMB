import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  applyOverride,
  configHash,
  resolvePhase,
  type PostTypeConfig,
} from '../../../packages/shared/src/index.js';
import {
  DEFAULT_CONFIG_DIR,
  buildConfigSet,
  loadConfigSet,
  readConfigDir,
  type RawConfigFiles,
} from '../../../apps/api/src/config/loader.js';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(import.meta.dirname, '../../fixtures/config', name), 'utf8'));

/** A fresh copy of the real config files that a test can break. */
type Mutable = RawConfigFiles & { postTypes: { file: string; json: Record<string, any> }[] }; // eslint-disable-line @typescript-eslint/no-explicit-any
const raw = (): Mutable => structuredClone(readConfigDir()) as Mutable;
const wcc = (r: Mutable) => r.postTypes[0]!.json;

function issuesOf(r: RawConfigFiles): string {
  try {
    buildConfigSet(r);
  } catch (err) {
    if (err instanceof ConfigError) return err.issues.join('\n');
    throw err;
  }
  return '';
}

function loaded(): PostTypeConfig {
  return loadConfigSet().configs[0]!.config;
}

describe('taxonomy', () => {
  const { taxonomy } = loadConfigSet();
  it('has the 18 categories with unique subtype ids', () => {
    expect(taxonomy.categories).toHaveLength(18);
    const ids = taxonomy.categories.flatMap((c) => c.subtypes.map((s) => s.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(134);
  });
  it('numbers World Championship as 1.1', () => {
    const wc = taxonomy.categories[0]!.subtypes[0]!;
    expect(wc).toEqual({ id: '1.1', name: 'World Championship' });
  });
});

describe('PT 1.1 World Championship config', () => {
  it('loads and validates from the repository files', () => {
    const cfg = loaded();
    expect(cfg.id).toBe('1.1');
    expect(cfg.sources).toEqual(['D1', 'D2', 'D3', 'D4', 'D5']);
    expect(cfg.imageSources).toEqual(['I1', 'I2', 'I3', 'I4']);
    expect(cfg.channels).toEqual(['x', 'facebook', 'instagram', 'discord']);
    expect(cfg.schedule).toEqual([{ kind: 'weekly', day: 'fri', time: '09:00' }]);
    expect(cfg.timezone).toBe('UTC');
    expect(cfg.contentRules.candidateCount).toBe(3);
    expect(cfg.approvalRequired).toBe(true);
    expect(cfg.phases.map((p) => p.id)).toEqual([
      'pre_tournament',
      'tournament',
      'post_tournament',
    ]);
  });

  it('switches schedule by phase: Friday weekly, then per completed game, then Friday weekly again', () => {
    const cfg = loaded();
    expect(resolvePhase(cfg, 'pre_tournament').schedule).toEqual([
      { kind: 'weekly', day: 'fri', time: '09:00' },
    ]);
    expect(resolvePhase(cfg, 'tournament').schedule).toEqual([
      { kind: 'event', event: 'game_completed' },
    ]);
    expect(resolvePhase(cfg, 'post_tournament').schedule).toEqual([
      { kind: 'weekly', day: 'fri', time: '09:00' },
    ]);
  });

  it('keeps base restrictions and prefers the phase facts while a phase is active', () => {
    const cfg = loaded();
    const t = resolvePhase(cfg, 'tournament');
    expect(t.contentRules.restrictions).toEqual(cfg.contentRules.restrictions);
    expect(t.contentRules.requiredFacts).toContain('game.result');
    expect(t.contentRules.candidateCount).toBe(3);
    expect(t.priority).toBe(5);
    expect(t.staleAfterMinutes).toBe(360);
    expect(resolvePhase(cfg, null).staleAfterMinutes).toBe(1440);
  });

  it('rejects an unknown phase', () => {
    expect(() => resolvePhase(loaded(), 'nope')).toThrow(/no phase "nope"/);
  });
});

describe('validation rejects bad configuration', () => {
  const cases: [string, (r: Mutable) => void, RegExp][] = [
    ['unknown data source', (r) => (wcc(r).sources = ['D1', 'D9']), /unknown data source D9/],
    ['unknown image source', (r) => (wcc(r).imageSources = ['I9']), /unknown image source I9/],
    [
      'image id used as data source',
      (r) => (wcc(r).sources = ['I1']),
      /data source ids look like D1/,
    ],
    ['unknown channel', (r) => (wcc(r).channels = ['x', 'mastodon']), /channels/],
    ['no enabled channel', (r) => (wcc(r).channels = ['facebook']), /no enabled channel/],
    [
      'bad timezone',
      (r) => (wcc(r).timezone = 'Mars/Phobos'),
      /timezone: not a valid IANA timezone/,
    ],
    [
      'bad time of day',
      (r) => (wcc(r).schedule = [{ kind: 'weekly', day: 'fri', time: '25:00' }]),
      /HH:MM/,
    ],
    [
      'unknown event trigger',
      (r) => (wcc(r).schedule = [{ kind: 'event', event: 'full_moon' }]),
      /schedule/,
    ],
    ['empty schedule', (r) => (wcc(r).schedule = []), /schedule/],
    ['approval switched off', (r) => (wcc(r).approvalRequired = false), /approvalRequired/],
    ['not three candidates', (r) => (wcc(r).contentRules.candidateCount = 5), /candidateCount/],
    [
      'bad dedupe placeholder',
      (r) => (wcc(r).deduplication.keyTemplate = '{postType}:{nope}'),
      /unknown placeholder \{nope\}/,
    ],
    [
      'dedupe without placeholder',
      (r) => (wcc(r).deduplication.keyTemplate = 'static'),
      /needs at least one/,
    ],
    ['priority out of range', (r) => (wcc(r).priority = 0), /priority/],
    ['unknown top-level field', (r) => (wcc(r).extra = true), /Unrecognized key/],
    [
      'required images without sources',
      (r) => ((wcc(r).imageRules.need = 'required'), (wcc(r).imageSources = [])),
      /no image sources/,
    ],
    ['phase widening channels', (r) => (wcc(r).phases[1].channels = ['x']), /Unrecognized key/],
    [
      'phase switching off approval',
      (r) => (wcc(r).phases[1].approvalRequired = false),
      /Unrecognized key/,
    ],
    [
      'phase changing candidate count',
      (r) => (wcc(r).phases[1].contentRules.candidateCount = 1),
      /Unrecognized key/,
    ],
    [
      'duplicate phase ids',
      (r) => (wcc(r).phases[2].id = 'tournament'),
      /phase ids must be unique/,
    ],
    [
      'id not in the taxonomy',
      (r) => ((wcc(r).id = '99.9'), (r.postTypes[0]!.file = '99.9-x.json')),
      /not in the taxonomy/,
    ],
    [
      'file name does not start with the id',
      (r) => (r.postTypes[0]!.file = 'wcc.json'),
      /file name must start with "1.1-"/,
    ],
    [
      'duplicate id across files',
      (r) => r.postTypes.push({ file: '1.1-copy.json', json: structuredClone(wcc(r)) }),
      /already used by/,
    ],
    [
      'disabled data source on an enabled post type',
      (r) => ((r.sources as any).sources.find((s: any) => s.id === 'D2').enabled = false), // eslint-disable-line @typescript-eslint/no-explicit-any
      /data source D2 is disabled/,
    ],
  ];

  it('accepts the unmodified files', () => {
    expect(issuesOf(raw())).toBe('');
  });

  it.each(cases)('%s', (_name, mutate, expected) => {
    const r = raw();
    mutate(r);
    expect(issuesOf(r)).toMatch(expected);
  });

  it('reports every problem in one pass', () => {
    const r = raw();
    wcc(r).timezone = 'Mars/Phobos';
    wcc(r).approvalRequired = false;
    const issues = issuesOf(r);
    expect(issues).toMatch(/timezone/);
    expect(issues).toMatch(/approvalRequired/);
  });

  it('allows a disabled post type to reference a disabled source', () => {
    const r = raw();
    wcc(r).enabled = false;
    (r.sources as any).sources.find((s: any) => s.id === 'D2').enabled = false; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(issuesOf(r)).toBe('');
  });

  it('reports unreadable JSON with the file name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'smb-config-'));
    cpSync(DEFAULT_CONFIG_DIR, dir, { recursive: true });
    writeFileSync(join(dir, 'post-types', '1.1-world-championship.json'), '{ not json');
    expect(() => readConfigDir(dir)).toThrow(/1\.1-world-championship\.json/);
  });
});

describe('content hash', () => {
  it('ignores key order and formatting', () => {
    expect(configHash({ a: 1, b: { c: [1, 2], d: 'x' } })).toBe(
      configHash(JSON.parse('{"b":{"d":"x","c":[1,2]},"a":1}')),
    );
  });
  it('changes when a value changes', () => {
    const cfg = loaded();
    expect(configHash(cfg)).not.toBe(configHash({ ...cfg, priority: 11 }));
  });
  it('is stable for the same file', () => {
    expect(configHash(loaded())).toBe(configHash(loaded()));
  });
});

describe('runtime overrides', () => {
  it('can disable a post type, change priority, and add restrictions', () => {
    const base = loaded();
    const merged = applyOverride(base, {
      enabled: false,
      priority: 50,
      contentRules: { restrictions: ['No mention of sponsors.'] },
    });
    expect(merged.enabled).toBe(false);
    expect(merged.priority).toBe(50);
    expect(merged.contentRules.restrictions).toEqual([
      ...base.contentRules.restrictions,
      'No mention of sponsors.',
    ]);
    expect(merged.approvalRequired).toBe(true);
  });

  it('can narrow channels and replace the schedule', () => {
    const merged = applyOverride(loaded(), { channels: ['x'], schedule: [{ kind: 'manual' }] });
    expect(merged.channels).toEqual(['x']);
    expect(merged.schedule).toEqual([{ kind: 'manual' }]);
  });

  it.each([
    ['a channel outside the file config', { channels: ['x', 'mastodon'] }],
    ['approvalRequired', { approvalRequired: false }],
    ['candidateCount', { contentRules: { candidateCount: 1 } }],
    ['sources', { sources: ['D1'] }],
    ['an empty override', {}],
    ['an out-of-range priority', { priority: 0 }],
    ['an invalid schedule', { schedule: [{ kind: 'weekly', day: 'fri', time: '99:00' }] }],
  ])('rejects %s', (_n, patch) => {
    expect(() => applyOverride(loaded(), patch)).toThrow(ConfigError);
  });

  it('rejects widening channels beyond the file config', () => {
    const narrow = { ...loaded(), channels: ['x' as const] };
    expect(() => applyOverride(narrow, { channels: ['x', 'discord'] })).toThrow(/subset/);
  });
});

describe('adding a subtype needs configuration only', () => {
  it('loads a second post type (11.1 On This Day) by adding one JSON file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'smb-config-'));
    cpSync(DEFAULT_CONFIG_DIR, dir, { recursive: true });
    writeFileSync(
      join(dir, 'post-types', '11.1-on-this-day.json'),
      JSON.stringify(fixture('11.1-on-this-day.json')),
    );
    const set = loadConfigSet(dir);
    expect(set.configs.map((c) => c.config.id)).toEqual(['1.1', '11.1']);
    // Different schedule, timezone, channels and phases than 1.1, same schema and same loader.
    const otd = set.configs[1]!.config;
    expect(otd.schedule).toEqual([{ kind: 'daily', time: '08:00' }]);
    expect(otd.timezone).toBe('Europe/London');
    expect(resolvePhase(otd, null).schedule).toEqual(otd.schedule);
  });
});
