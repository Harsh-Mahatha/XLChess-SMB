import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import sharp from 'sharp';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import {
  AssetIntegrityError,
  assertAssetsIntact,
  ensureAssetsIntact,
  DeriveError,
  deriveAsset,
  verifyAsset,
  verifyDerived,
  verifyOriginal,
  verifyRegion,
  type AssetDeps,
} from '../../../apps/api/src/assets/index.js';
import {
  BUCKETS,
  InMemoryObjectStore,
  contentPath,
  sha256Hex,
} from '../../../apps/api/src/storage/index.js';
import { syntheticPhoto } from '../../unit/images/pictures.js';
import { freshDb, ID, rows } from './harness.js';

let pgc: pg.Client;
let prisma: PrismaClient;
let store: InMemoryObjectStore;
let deps: AssetDeps;

const CROP = {
  spec: 1 as const,
  crop: { left: 100, top: 50, width: 1200, height: 800 },
  resize: { width: 900, height: 600, fit: 'inside' as const },
  encode: { format: 'jpeg' as const, quality: 92 },
};

let counter = 0;

async function original(): Promise<{ id: string; bytes: Uint8Array; path: string }> {
  const bytes = await syntheticPhoto(1600, 1000, 'jpeg');
  // A different picture each time so every test gets its own file.
  const unique = new Uint8Array(
    await sharp(bytes).linear(1, ++counter).jpeg({ quality: 95 }).toBuffer(),
  );
  const sha256 = sha256Hex(unique);
  const path = contentPath(sha256, 'jpg');
  await store.put(BUCKETS.originals, path, unique, 'image/jpeg');
  const row = await prisma.media_assets.create({
    data: {
      kind: 'original',
      bucket: BUCKETS.originals,
      path,
      sha256,
      mime: 'image/jpeg',
      size_bytes: unique.byteLength,
      width: 1600,
      height: 1000,
      source_url: 'https://upload.wikimedia.org/x.jpg',
      image_source_id: 'I1',
      opportunity_id: ID.opportunity,
    },
  });
  return { id: row.id, bytes: unique, path };
}

const problem = async (assetId: string) =>
  (
    await rows<{ p: string | null }>(pgc, 'select smb.asset_integrity_problem($1) as p', [assetId])
  )[0]!.p;

beforeAll(async () => {
  pgc = await freshDb();
  prisma = new PrismaClient({ datasourceUrl: `${inject('dbUrl')}?schema=smb` });
});
beforeAll(() => {
  store = new InMemoryObjectStore();
  deps = { db: prisma, store };
});
afterAll(async () => {
  await prisma.$disconnect();
  await pgc.end();
});

describe('deriveAsset', () => {
  it('stores a derived image with its transform, and the originals check passes', async () => {
    const o = await original();
    const d = await deriveAsset(deps, { parentId: o.id, transform: CROP });
    expect(d).toMatchObject({
      created: true,
      parentId: o.id,
      width: 900,
      height: 600,
      mime: 'image/jpeg',
    });
    const row = await prisma.media_assets.findUniqueOrThrow({ where: { id: d.assetId } });
    expect(row).toMatchObject({
      kind: 'derived',
      bucket: 'derived',
      path: d.path,
      parent_asset_id: o.id,
    });
    expect(row.transform).toMatchObject({ spec: 1, crop: CROP.crop });
    expect(await store.get('derived', d.path)).toBeDefined();
    expect(sha256Hex((await store.get('derived', d.path))!)).toBe(d.sha256);
    // derive proved the parent's hash and the output it just made, so the database accepts it.
    expect(await problem(d.assetId)).toBeNull();
    const checks = await prisma.asset_integrity_checks.findMany({
      where: { asset_id: { in: [o.id, d.assetId] } },
    });
    expect(checks.map((c) => c.check_kind).sort()).toEqual(['derived_rebuild', 'original_hash']);
  });

  it('returns the same asset for the same parent and transform', async () => {
    const o = await original();
    const first = await deriveAsset(deps, { parentId: o.id, transform: CROP });
    const second = await deriveAsset(deps, { parentId: o.id, transform: { ...CROP } });
    expect(second).toMatchObject({ assetId: first.assetId, created: false });
  });

  it('can chain from a derived image', async () => {
    const o = await original();
    const first = await deriveAsset(deps, { parentId: o.id, transform: CROP });
    const second = await deriveAsset(deps, {
      parentId: first.assetId,
      transform: { spec: 1, rotate: { degrees: 90 }, encode: { format: 'webp', quality: 90 } },
    });
    expect(second).toMatchObject({ width: 600, height: 900, mime: 'image/webp' });
    expect((await verifyDerived(deps, second.assetId)).passed).toBe(true);
  });

  it('refuses a transform that is not permitted', async () => {
    const o = await original();
    await expect(
      deriveAsset(deps, {
        parentId: o.id,
        transform: { ...CROP, recolour: { saturation: 2 } } as never,
      }),
    ).rejects.toMatchObject({ code: 'bad_transform' });
    await expect(
      deriveAsset(deps, {
        parentId: o.id,
        transform: { spec: 1, encode: { format: 'gif' } } as never,
      }),
    ).rejects.toBeInstanceOf(DeriveError);
  });

  it('refuses when the stored original is damaged, missing or not a photo source', async () => {
    const damaged = await original();
    store.objects.set(`originals/${damaged.path}`, {
      bytes: new Uint8Array([...damaged.bytes.slice(0, 100), 1, 2, 3]),
      contentType: 'image/jpeg',
    });
    await expect(
      deriveAsset(deps, { parentId: damaged.id, transform: CROP }),
    ).rejects.toMatchObject({
      code: 'parent_file',
    });
    const missing = await original();
    store.objects.delete(`originals/${missing.path}`);
    await expect(
      deriveAsset(deps, { parentId: missing.id, transform: CROP }),
    ).rejects.toMatchObject({
      code: 'parent_file',
    });
    await expect(
      deriveAsset(deps, { parentId: ID.assetRender, transform: CROP }),
    ).rejects.toMatchObject({
      code: 'parent_not_usable',
    });
    await expect(
      deriveAsset(deps, { parentId: randomUUID(), transform: CROP }),
    ).rejects.toMatchObject({
      code: 'parent_not_found',
    });
  });

  it('refuses a crop outside the photograph', async () => {
    const o = await original();
    await expect(
      deriveAsset(deps, {
        parentId: o.id,
        transform: {
          spec: 1,
          crop: { left: 1500, top: 0, width: 500, height: 100 },
          encode: { format: 'png' },
        },
      }),
    ).rejects.toMatchObject({ code: 'transform_failed' });
  });
});

describe('verifyOriginal', () => {
  it('passes an intact file and records the check', async () => {
    const o = await original();
    const r = await verifyOriginal(deps, o.id);
    expect(r).toMatchObject({ passed: true, kind: 'original_hash', failures: [] });
    expect(await problem(o.id)).toBeNull();
  });

  it('fails a changed, missing or wrongly sized file, and the database then refuses it', async () => {
    const changed = await original();
    store.objects.set(`originals/${changed.path}`, {
      bytes: await syntheticPhoto(1600, 1000, 'jpeg'),
      contentType: 'image/jpeg',
    });
    expect(await verifyOriginal(deps, changed.id)).toMatchObject({
      passed: false,
      failures: ['hash_mismatch'],
    });
    expect(await problem(changed.id)).toMatch(/failed its hash check: hash_mismatch/);

    const missing = await original();
    store.objects.delete(`originals/${missing.path}`);
    expect(await verifyOriginal(deps, missing.id)).toMatchObject({ failures: ['file_missing'] });

    // A recorded size that does not match the picture.
    const wrongSize = await original();
    await pgc.query('alter table smb.media_assets disable trigger media_assets_guard');
    await pgc.query('update smb.media_assets set width = 800 where id = $1', [wrongSize.id]);
    await pgc.query('alter table smb.media_assets enable trigger media_assets_guard');
    expect(await verifyOriginal(deps, wrongSize.id)).toMatchObject({
      failures: ['dimension_mismatch'],
    });
  });

  it('a later passing check clears an earlier failure (the newest decides)', async () => {
    const o = await original();
    const good = store.objects.get(`originals/${o.path}`)!;
    store.objects.set(`originals/${o.path}`, {
      bytes: new Uint8Array([0xff, 0xd8, 0xff, 9]),
      contentType: 'image/jpeg',
    });
    expect((await verifyOriginal(deps, o.id)).passed).toBe(false);
    expect(await problem(o.id)).not.toBeNull();
    store.objects.set(`originals/${o.path}`, good);
    expect((await verifyOriginal(deps, o.id)).passed).toBe(true);
    expect(await problem(o.id)).toBeNull();
  });
});

describe('verifyDerived', () => {
  it('passes a derived image rebuilt bit for bit', async () => {
    const o = await original();
    const d = await deriveAsset(deps, { parentId: o.id, transform: CROP });
    const r = await verifyDerived(deps, d.assetId);
    expect(r).toMatchObject({ passed: true, detail: { exact: true } });
  });

  it('fails when the parent photograph changed', async () => {
    const o = await original();
    const d = await deriveAsset(deps, { parentId: o.id, transform: CROP });
    store.objects.set(`originals/${o.path}`, {
      bytes: await syntheticPhoto(1600, 1000, 'png'),
      contentType: 'image/jpeg',
    });
    expect(await verifyDerived(deps, d.assetId)).toMatchObject({
      passed: false,
      failures: ['parent_changed'],
    });
    expect(await problem(d.assetId)).toMatch(/original photograph failed|derived image failed/);
  });

  it('fails when the derived file was swapped', async () => {
    const o = await original();
    const d = await deriveAsset(deps, { parentId: o.id, transform: CROP });
    store.objects.set(`derived/${d.path}`, {
      bytes: await syntheticPhoto(900, 600),
      contentType: 'image/jpeg',
    });
    expect(await verifyDerived(deps, d.assetId)).toMatchObject({ failures: ['hash_mismatch'] });
  });

  /** A writer that stores an edited picture and records it as an ordinary crop of the photograph. */
  async function claimed(parent: string, bytes: Uint8Array, transform: object = CROP) {
    const sha256 = sha256Hex(bytes);
    const path = contentPath(sha256, 'jpg');
    await store.put(BUCKETS.derived, path, bytes, 'image/jpeg');
    return prisma.media_assets.create({
      data: {
        kind: 'derived',
        bucket: BUCKETS.derived,
        path,
        sha256,
        mime: 'image/jpeg',
        width: 900,
        height: 600,
        parent_asset_id: parent,
        transform: transform as never,
        opportunity_id: ID.opportunity,
      },
    });
  }

  it('accepts the same picture encoded differently, as another library version might', async () => {
    const o = await original();
    const honest = await deriveAsset(deps, { parentId: o.id, transform: CROP });
    const other = new Uint8Array(
      await sharp((await store.get('derived', honest.path))!)
        .jpeg({ quality: 88 })
        .toBuffer(),
    );
    const row = await claimed(o.id, other);
    const r = await verifyDerived(deps, row.id);
    expect(r).toMatchObject({ passed: true, detail: { exact: false } });
    expect(await problem(row.id)).toBeNull();
  });

  it('catches a retouched face, a recolour and a wrong crop, each recorded against the asset', async () => {
    const o = await original();
    const honest = await deriveAsset(deps, { parentId: o.id, transform: CROP });
    const clean = (await store.get('derived', honest.path))!;
    const { data, info } = await sharp(clean).raw().toBuffer({ resolveWithObject: true });

    const patch = Buffer.from(data);
    for (let y = 150; y < 260; y++)
      for (let x = 380; x < 520; x++)
        for (let c = 0; c < 3; c++)
          patch[(y * info.width + x) * 3 + c] = Math.min(
            255,
            patch[(y * info.width + x) * 3 + c]! + 35,
          );
    const retouched = await claimed(
      o.id,
      new Uint8Array(
        await sharp(patch, { raw: { width: info.width, height: info.height, channels: 3 } })
          .jpeg({ quality: 92 })
          .toBuffer(),
      ),
    );
    expect(await verifyDerived(deps, retouched.id)).toMatchObject({
      passed: false,
      failures: expect.arrayContaining(['local_edit']),
    });
    expect(await problem(retouched.id)).toMatch(/derived image failed its check/);

    const tinted = Buffer.from(data);
    for (let i = 0; i < tinted.length; i += 3) tinted[i] = Math.min(255, tinted[i]! + 45);
    const recoloured = await claimed(
      o.id,
      new Uint8Array(
        await sharp(tinted, { raw: { width: info.width, height: info.height, channels: 3 } })
          .jpeg({ quality: 92 })
          .toBuffer(),
      ),
    );
    expect((await verifyDerived(deps, recoloured.id)).failures).toContain('pixel_mismatch');

    // Same size, but cut from somewhere else in the photograph than the transform says.
    const elsewhere = new Uint8Array(
      await sharp(o.bytes)
        .extract({ left: 300, top: 150, width: 1200, height: 800 })
        .resize(900, 600)
        .jpeg({ quality: 92 })
        .toBuffer(),
    );
    const moved = await claimed(o.id, elsewhere);
    expect((await verifyDerived(deps, moved.id)).passed).toBe(false);

    const history = await prisma.asset_integrity_checks.findMany({
      where: { asset_id: retouched.id },
    });
    expect(history).toHaveLength(1);
    expect(history[0]!.detail).toMatchObject({
      comparison: { worstBlockAt: expect.any(Object) },
    });
  });

  it('fails a record whose transform is not permitted', async () => {
    const o = await original();
    // The database refuses such a row, so lift the guard for this one write, as a buggy migration might.
    await pgc.query(
      'alter table smb.media_assets drop constraint media_assets_transform_permitted',
    );
    try {
      const row = await claimed(o.id, await syntheticPhoto(900, 600), {
        spec: 1,
        retouch: true,
        encode: { format: 'jpeg' },
      });
      expect(await verifyDerived(deps, row.id)).toMatchObject({
        failures: ['transform_not_permitted'],
      });
    } finally {
      // Put the rule back; it only has to ignore the one row written while it was off.
      await pgc.query(
        `alter table smb.media_assets add constraint media_assets_transform_permitted
         check (kind <> 'derived' or smb.transform_is_permitted(transform)) not valid`,
      );
    }
  });
});

describe('verifyRegion', () => {
  const RECT = { left: 40, top: 60, width: 450, height: 300 };

  async function render(parent: string, photo: Uint8Array, edit?: (b: Buffer, w: number) => void) {
    const placed = await sharp(photo)
      .resize(RECT.width, RECT.height, { fit: 'cover', kernel: 'lanczos3' })
      .toBuffer();
    const canvas = sharp({
      create: { width: 1000, height: 500, channels: 3, background: '#808080' },
    }).composite([{ input: placed, left: RECT.left, top: RECT.top }]);
    let png = await canvas.png().toBuffer();
    if (edit) {
      const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
      edit(data, info.width);
      png = await sharp(data, { raw: { width: info.width, height: info.height, channels: 3 } })
        .png()
        .toBuffer();
    }
    const bytes = new Uint8Array(png);
    const sha256 = sha256Hex(bytes);
    const path = contentPath(sha256, 'png');
    await store.put(BUCKETS.renders, path, bytes, 'image/png');
    return prisma.media_assets.create({
      data: {
        kind: 'render',
        bucket: BUCKETS.renders,
        path,
        sha256,
        mime: 'image/png',
        width: 1000,
        height: 500,
        parent_asset_id: parent,
        template_version: 'test@1',
        opportunity_id: ID.opportunity,
      },
    });
  }

  it('passes a photo placed in a template unchanged, and the database then accepts the render', async () => {
    const o = await original();
    const d = await deriveAsset(deps, { parentId: o.id, transform: CROP });
    const photo = (await store.get('derived', d.path))!;
    const r = await render(d.assetId, photo);
    expect(await problem(r.id)).toMatch(/photograph area of the render has not been checked/);
    const report = await verifyRegion(deps, {
      renderId: r.id,
      sourceId: d.assetId,
      rect: RECT,
      fit: 'cover',
    });
    expect(report).toMatchObject({ passed: true, kind: 'region_match' });
    expect(await problem(r.id)).toBeNull();
  });

  it('catches retouching of the photograph inside the finished graphic', async () => {
    const o = await original();
    const d = await deriveAsset(deps, { parentId: o.id, transform: CROP });
    const photo = (await store.get('derived', d.path))!;
    const r = await render(d.assetId, photo, (buf, w) => {
      for (let y = 120; y < 200; y++)
        for (let x = 200; x < 300; x++)
          for (let c = 0; c < 3; c++)
            buf[(y * w + x) * 3 + c] = Math.min(255, buf[(y * w + x) * 3 + c]! + 40);
    });
    const report = await verifyRegion(deps, {
      renderId: r.id,
      sourceId: d.assetId,
      rect: RECT,
      fit: 'cover',
    });
    expect(report).toMatchObject({
      passed: false,
      failures: expect.arrayContaining(['local_edit']),
    });
    expect(await problem(r.id)).toMatch(/render changed the photograph/);
  });

  it('fails when the render was not composed from the named photograph', async () => {
    const a = await original();
    const b = await original();
    const da = await deriveAsset(deps, { parentId: a.id, transform: CROP });
    const db = await deriveAsset(deps, { parentId: b.id, transform: CROP });
    const r = await render(da.assetId, (await store.get('derived', da.path))!);
    expect(
      await verifyRegion(deps, { renderId: r.id, sourceId: db.assetId, rect: RECT, fit: 'cover' }),
    ).toMatchObject({
      failures: ['parent_changed'],
    });
    expect(
      await verifyRegion(deps, {
        renderId: r.id,
        sourceId: da.assetId,
        rect: { ...RECT, left: 900 },
        fit: 'cover',
      }),
    ).toMatchObject({ failures: ['dimension_mismatch'] });
  });
});

describe('verifyAsset', () => {
  it('dispatches by kind and refuses kinds that have no standalone check', async () => {
    const o = await original();
    const d = await deriveAsset(deps, { parentId: o.id, transform: CROP });
    expect((await verifyAsset(deps, o.id)).kind).toBe('original_hash');
    expect((await verifyAsset(deps, d.assetId)).kind).toBe('derived_rebuild');
    await expect(verifyAsset(deps, ID.assetRender)).rejects.toThrow(
      /no standalone integrity check/,
    );
  });
});

describe('publish-time guard', () => {
  it('passes intact assets, and stops the post when a file changed after it was checked', async () => {
    const o = await original();
    const d = await deriveAsset(deps, { parentId: o.id, transform: CROP });
    await expect(ensureAssetsIntact(deps, [d.assetId])).resolves.toBeUndefined();
    await expect(assertAssetsIntact(prisma, [o.id, d.assetId])).resolves.toBeUndefined();

    // The photograph is swapped in Storage after it was approved.
    store.objects.set(`originals/${o.path}`, {
      bytes: await syntheticPhoto(1600, 1000, 'png'),
      contentType: 'image/jpeg',
    });
    // The recorded checks still say "fine" until someone looks again...
    await expect(assertAssetsIntact(prisma, [d.assetId])).resolves.toBeUndefined();
    // ...which is why publishing re-checks against the files as they are now.
    await expect(ensureAssetsIntact(deps, [d.assetId])).rejects.toBeInstanceOf(AssetIntegrityError);
    await expect(assertAssetsIntact(prisma, [d.assetId])).rejects.toThrow(/failed/);
  });

  it('stops an asset that was never checked', async () => {
    await expect(assertAssetsIntact(prisma, [ID.assetDerived])).rejects.toThrow(/not been/);
  });
});
