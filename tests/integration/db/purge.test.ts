import { PrismaClient } from '@prisma/client';
import sharp from 'sharp';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import {
  deriveAsset,
  purgeExpiredAssets,
  registerGeneratedAsset,
  GeneratedAssetError,
  type AssetDeps,
} from '../../../apps/api/src/assets/index.js';
import {
  BUCKETS,
  InMemoryObjectStore,
  contentPath,
  sha256Hex,
  type ObjectStore,
} from '../../../apps/api/src/storage/index.js';
import { syntheticPhoto } from '../../unit/images/pictures.js';
import { freshDb, ID, rows } from './harness.js';

let pgc: pg.Client;
let prisma: PrismaClient;
let store: InMemoryObjectStore;
let deps: AssetDeps;

async function original(n: number) {
  const bytes = new Uint8Array(
    await sharp(await syntheticPhoto(800, 600))
      .linear(1, n)
      .jpeg({ quality: 95 })
      .toBuffer(),
  );
  const sha256 = sha256Hex(bytes);
  const path = contentPath(sha256, 'jpg');
  await store.put(BUCKETS.originals, path, bytes, 'image/jpeg');
  return prisma.media_assets.create({
    data: {
      kind: 'original',
      bucket: BUCKETS.originals,
      path,
      sha256,
      mime: 'image/jpeg',
      width: 800,
      height: 600,
      source_url: 'https://upload.wikimedia.org/x.jpg',
      image_source_id: 'I1',
      opportunity_id: ID.opportunity,
    },
  });
}

const png = async () =>
  new Uint8Array(
    await sharp({ create: { width: 512, height: 288, channels: 3, background: '#808080' } })
      .png()
      .toBuffer(),
  );

beforeAll(async () => {
  pgc = await freshDb();
  prisma = new PrismaClient({ datasourceUrl: `${inject('dbUrl')}?schema=smb` });
  store = new InMemoryObjectStore();
  deps = { db: prisma, store };
});
afterAll(async () => {
  await prisma.$disconnect();
  await pgc.end();
});

describe('registerGeneratedAsset', () => {
  const base = {
    model: 'z-image-turbo',
    prompt: 'grey studio backdrop',
    seed: 7,
    workflowSha256: 'a'.repeat(64),
  };

  it('stores an AI-made background with a text-only record', async () => {
    const bytes = await png();
    const g = await registerGeneratedAsset(deps, { ...base, bytes });
    expect(g).toMatchObject({ created: true, width: 512, height: 288 });
    const row = await prisma.media_assets.findUniqueOrThrow({ where: { id: g.assetId } });
    expect(row).toMatchObject({
      kind: 'generated',
      bucket: 'generated',
      parent_asset_id: null,
      source_url: null,
    });
    expect(row.generation).toMatchObject({ input: 'text_only', model: 'z-image-turbo', seed: 7 });
    expect(await store.get('generated', g.path)).toEqual(bytes);
    expect(await registerGeneratedAsset(deps, { ...base, bytes })).toMatchObject({
      assetId: g.assetId,
      created: false,
    });
  });

  it('refuses an empty prompt and a file that is not an image', async () => {
    await expect(
      registerGeneratedAsset(deps, { ...base, prompt: ' ', bytes: await png() }),
    ).rejects.toBeInstanceOf(GeneratedAssetError);
    await expect(
      registerGeneratedAsset(deps, { ...base, bytes: new Uint8Array([1, 2, 3]) }),
    ).rejects.toBeInstanceOf(GeneratedAssetError);
  });

  it('can never be the source of a photo derivative', async () => {
    const g = await registerGeneratedAsset(deps, { ...base, bytes: await png() });
    await expect(
      deriveAsset(deps, { parentId: g.assetId, transform: { spec: 1, encode: { format: 'png' } } }),
    ).rejects.toMatchObject({ code: 'parent_not_usable' });
  });
});

describe('purgeExpiredAssets', () => {
  const later = () => new Date(Date.now() + 200 * 24 * 3600 * 1000);

  it('removes the files of expired unused assets, keeps the rows, and is safe to repeat', async () => {
    const o = await original(1);
    const d = await deriveAsset(deps, {
      parentId: o.id,
      transform: {
        spec: 1,
        resize: { width: 200, height: 200, fit: 'inside' },
        encode: { format: 'jpeg' },
      },
    });
    const g = await registerGeneratedAsset(deps, {
      model: 'm',
      prompt: 'p',
      seed: 1,
      workflowSha256: 'b'.repeat(64),
      bytes: await png(),
    });
    expect(await store.get('originals', o.path)).toBeDefined();

    const first = await purgeExpiredAssets(deps, later());
    expect(first.failed).toEqual([]);
    expect(
      first.retention.find((r) => r.subject === 'unused_image')!.affected,
    ).toBeGreaterThanOrEqual(3);
    expect(first.removed).toBeGreaterThanOrEqual(3);

    expect(await store.get('originals', o.path)).toBeUndefined();
    expect(await store.get('derived', d.path)).toBeUndefined();
    expect(await store.get('generated', g.path)).toBeUndefined();
    const left = await prisma.media_assets.findMany({
      where: { id: { in: [o.id, d.assetId, g.assetId] } },
    });
    expect(left).toHaveLength(3); // provenance rows stay
    expect(left.every((r) => r.deleted_at && r.purged_at)).toBe(true);

    const again = await purgeExpiredAssets(deps, later());
    expect(again).toMatchObject({ removed: 0, alreadyGone: 0, failed: [] });
  });

  it('leaves what a published post used, and its licence evidence, untouched', async () => {
    const seeded = await rows<{ id: string; deleted_at: string | null }>(
      pgc,
      'select id, deleted_at from smb.media_assets where id = any($1)',
      [[ID.assetEvidence, ID.assetOriginal, ID.assetDerived, ID.assetRender]],
    );
    expect(seeded).toHaveLength(4);
    expect(seeded.every((r) => r.deleted_at === null)).toBe(true);
  });

  it('reports a protected asset that somehow carries deleted_at, and does not remove its file', async () => {
    await store.put(BUCKETS.originals, 'seed/photo.jpg', new Uint8Array([1]), 'image/jpeg');
    await pgc.query('update smb.media_assets set deleted_at = now() where id = $1', [
      ID.assetOriginal,
    ]);
    const r = await purgeExpiredAssets(deps, later());
    expect(r.skippedProtected).toContain(ID.assetOriginal);
    expect(await store.get('originals', 'seed/photo.jpg')).toBeDefined();
    const [row] = await rows<{ purged_at: string | null }>(
      pgc,
      'select purged_at from smb.media_assets where id = $1',
      [ID.assetOriginal],
    );
    expect(row!.purged_at).toBeNull();
  });

  it('retries a failed removal on the next run', async () => {
    const o = await original(2);
    let fail = true;
    const flaky: ObjectStore = {
      put: (b, p, x, c) => store.put(b, p, x, c),
      get: (b, p) => store.get(b, p),
      remove: async (b, p) => {
        if (fail) throw new Error('storage unavailable');
        return store.remove(b, p);
      },
    };
    const first = await purgeExpiredAssets({ db: prisma, store: flaky }, later());
    expect(first.failed.map((f) => f.assetId)).toContain(o.id);
    expect(first.failed[0]!.error).toMatch(/storage unavailable/);
    expect(
      (await prisma.media_assets.findUniqueOrThrow({ where: { id: o.id } })).purged_at,
    ).toBeNull();

    fail = false;
    const second = await purgeExpiredAssets({ db: prisma, store: flaky }, later());
    expect(second.failed).toEqual([]);
    expect(await store.get('originals', o.path)).toBeUndefined();
    expect(
      (await prisma.media_assets.findUniqueOrThrow({ where: { id: o.id } })).purged_at,
    ).not.toBeNull();
  });
});
