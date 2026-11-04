import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigError, configHash, type ConfigSet } from '@smb/shared';
import { DEFAULT_CONFIG_DIR, loadConfigSet } from '../../../apps/api/src/config/loader.js';
import {
  clearOverride,
  getActiveConfig,
  setOverride,
  syncConfigs,
} from '../../../apps/api/src/config/sync.js';
import { freshDb, ID, rows } from './harness.js';
import { inject } from 'vitest';

let pgc: pg.Client;
let prisma: PrismaClient;
let real: ConfigSet;

beforeAll(async () => {
  pgc = await freshDb(); // includes a seed config v1 for 1.1 and an opportunity that uses it
  prisma = new PrismaClient({ datasourceUrl: `${inject('dbUrl')}?schema=smb` });
  real = loadConfigSet();
});
afterAll(async () => {
  await prisma.$disconnect();
  await pgc.end();
});

const versions = (id: string) =>
  rows<{ version: number; origin: string; is_active: boolean }>(
    pgc,
    'select version, origin, is_active from smb.post_configs where post_type_id = $1 order by version',
    [id],
  );

/** The real config set with a change applied to 1.1, as if the file had been edited. */
const edited = (change: Record<string, unknown>): ConfigSet => ({
  ...real,
  configs: real.configs.map((c) => ({
    file: c.file,
    config: { ...c.config, ...change } as typeof c.config,
  })),
});

describe('config sync', () => {
  it('stores the file config as a new active version and leaves earlier opportunities on their version', async () => {
    const results = await syncConfigs(prisma, real);
    expect(results).toEqual([
      { postTypeId: '1.1', action: 'updated', version: 2, droppedOverride: false },
    ]);

    const active = await getActiveConfig(prisma, '1.1');
    expect(active).toMatchObject({ version: 2, origin: 'file' });
    expect(active.config).toEqual(real.configs[0]!.config);

    const [row] = await rows<{ content_hash: string; file_hash: string }>(
      pgc,
      'select content_hash, file_hash from smb.post_configs where post_type_id = $1 and version = 2',
      ['1.1'],
    );
    expect(row.content_hash).toBe(configHash(real.configs[0]!.config));
    expect(row.file_hash).toBe(row.content_hash);

    // The opportunity created before the change still points at version 1.
    const [opp] = await rows<{ version: number }>(
      pgc,
      'select c.version from smb.post_opportunities o join smb.post_configs c on c.id = o.post_config_id where o.id = $1',
      [ID.opportunity],
    );
    expect(opp.version).toBe(1);
    expect((await versions('1.1')).filter((v) => v.is_active)).toHaveLength(1);
  });

  it('does nothing when the files have not changed', async () => {
    const results = await syncConfigs(prisma, real);
    expect(results.map((r) => r.action)).toEqual(['unchanged']);
    expect(await versions('1.1')).toHaveLength(2);
  });

  it('adds a new post type by configuration only (no code change)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'smb-config-'));
    cpSync(DEFAULT_CONFIG_DIR, dir, { recursive: true });
    writeFileSync(
      join(dir, 'post-types', '11.1-on-this-day.json'),
      readFileSync(join(import.meta.dirname, '../../fixtures/config/11.1-on-this-day.json')),
    );
    const results = await syncConfigs(prisma, loadConfigSet(dir));
    expect(results).toEqual([
      { postTypeId: '1.1', action: 'unchanged', version: 2, droppedOverride: false },
      { postTypeId: '11.1', action: 'created', version: 1, droppedOverride: false },
    ]);
    const active = await getActiveConfig(prisma, '11.1');
    expect(active.config.schedule).toEqual([{ kind: 'daily', time: '08:00' }]);
    const [pt] = await rows<{ name: string }>(
      pgc,
      "select name from smb.post_types where id = '11.1'",
    );
    expect(pt.name).toBe('On This Day');
  });

  it('creates exactly one new version when two instances sync a changed file at once', async () => {
    const changed = edited({ priority: 12 });
    const [a, b] = await Promise.all([syncConfigs(prisma, changed), syncConfigs(prisma, changed)]);
    expect([a[0]!.action, b[0]!.action].sort()).toEqual(['unchanged', 'updated']);
    const v = await versions('1.1');
    expect(v.map((x) => x.version)).toEqual([1, 2, 3]);
    expect(v.filter((x) => x.is_active)).toHaveLength(1);
    // Put the real file back for the following tests.
    expect((await syncConfigs(prisma, real))[0]).toMatchObject({ action: 'updated', version: 4 });
  });
});

describe('runtime overrides', () => {
  it('stores an override as a new version and records who did it', async () => {
    const { version } = await setOverride(
      prisma,
      real,
      '1.1',
      { enabled: false, priority: 50 },
      'xlchess-user-3',
    );
    expect(version).toBe(5);

    const active = await getActiveConfig(prisma, '1.1');
    expect(active.origin).toBe('override');
    expect(active.config).toMatchObject({ enabled: false, priority: 50, approvalRequired: true });

    const [row] = await rows<{ override: unknown; file_hash: string; created_by: string }>(
      pgc,
      "select override, file_hash, created_by from smb.post_configs where post_type_id = '1.1' and is_active",
    );
    expect(row.override).toEqual({ enabled: false, priority: 50 });
    expect(row.file_hash).toBe(configHash(real.configs[0]!.config));
    expect(row.created_by).toBe('xlchess-user-3');

    const [pt] = await rows<{ enabled: boolean }>(
      pgc,
      "select enabled from smb.post_types where id = '1.1'",
    );
    expect(pt.enabled).toBe(false);

    const audit = await rows<{ actor: string; details: { override: unknown } }>(
      pgc,
      "select actor, details from smb.audit_log where action = 'config.override'",
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actor).toBe('xlchess-user-3');
    expect(audit[0]!.details.override).toEqual({ enabled: false, priority: 50 });
  });

  it('keeps the override when the file has not changed', async () => {
    const results = await syncConfigs(prisma, real);
    expect(results[0]).toMatchObject({ action: 'unchanged', version: 5 });
  });

  it('carries the override over when the file changes and the override still fits', async () => {
    const results = await syncConfigs(prisma, edited({ timezone: 'Europe/Paris' }));
    expect(results[0]).toMatchObject({ action: 'updated', version: 6, droppedOverride: false });
    const active = await getActiveConfig(prisma, '1.1');
    expect(active.origin).toBe('override');
    expect(active.config).toMatchObject({ timezone: 'Europe/Paris', enabled: false, priority: 50 });
  });

  it('drops an override that no longer fits the new file, and says so', async () => {
    await setOverride(prisma, real, '1.1', { channels: ['x', 'facebook'] }, 'xlchess-user-3'); // v7
    const narrowed = edited({ channels: ['x'] });
    const results = await syncConfigs(prisma, narrowed);
    expect(results[0]).toMatchObject({ action: 'updated', version: 8, droppedOverride: true });
    const active = await getActiveConfig(prisma, '1.1');
    expect(active.origin).toBe('file');
    expect(active.config.channels).toEqual(['x']);
  });

  it('returns to the plain file config when the override is cleared', async () => {
    await setOverride(prisma, real, '1.1', { priority: 20 }, 'xlchess-user-3'); // v9
    const { version } = await clearOverride(prisma, real, '1.1', 'xlchess-user-3');
    expect(version).toBe(10);
    const active = await getActiveConfig(prisma, '1.1');
    expect(active).toMatchObject({ origin: 'file' });
    expect(active.config).toEqual(real.configs[0]!.config);
  });

  it('refuses forbidden overrides and stores nothing', async () => {
    const before = (await versions('1.1')).length;
    await expect(
      setOverride(prisma, real, '1.1', { approvalRequired: false }, 'u'),
    ).rejects.toThrow(ConfigError);
    await expect(
      setOverride(prisma, real, '1.1', { channels: ['mastodon'] }, 'u'),
    ).rejects.toThrow();
    await expect(setOverride(prisma, real, '99.9', { priority: 5 }, 'u')).rejects.toThrow(
      /no config file/,
    );
    expect((await versions('1.1')).length).toBe(before);
  });

  it('always has exactly one active version', async () => {
    expect((await versions('1.1')).filter((v) => v.is_active)).toHaveLength(1);
  });
});
