import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshDb, hex, ID, rows } from './harness.js';

let db: pg.Client;
beforeAll(async () => {
  db = await freshDb();
});
afterAll(async () => {
  await db.end();
});

const CROP =
  '{"spec":1,"crop":{"left":0,"top":0,"width":10,"height":10},"encode":{"format":"jpeg"}}';

async function derived(
  parent: string,
  transform: string,
  over: { bucket?: string; width?: number | null } = {},
) {
  const id = randomUUID();
  await db.query(
    `insert into smb.media_assets (id, kind, bucket, path, sha256, mime, parent_asset_id, transform, width, height)
     values ($1, 'derived', $2, $3, $4, 'image/jpeg', $5, $6, $7, 10)`,
    [
      id,
      over.bucket ?? 'derived',
      `d/${id}.jpg`,
      hex('a'),
      parent,
      transform,
      over.width === undefined ? 10 : over.width,
    ],
  );
  return id;
}

describe('permitted transforms', () => {
  it('stores a permitted transform', async () => {
    await derived(ID.assetOriginal, CROP);
    await derived(
      ID.assetOriginal,
      '{"spec":1,"rotate":{"degrees":90},"resize":{"width":5,"height":5,"fit":"cover"},"encode":{"format":"webp","quality":80}}',
    );
  });

  it.each([
    ['a recolour step', '{"spec":1,"colour":{"saturation":2},"encode":{"format":"jpeg"}}'],
    ['a retouch step', '{"spec":1,"retouch":true,"encode":{"format":"jpeg"}}'],
    [
      'a stretch fit',
      '{"spec":1,"resize":{"width":5,"height":5,"fit":"fill"},"encode":{"format":"jpeg"}}',
    ],
    [
      'an extra crop field',
      '{"spec":1,"crop":{"left":0,"top":0,"width":1,"height":1,"mask":"x"},"encode":{"format":"jpeg"}}',
    ],
    ['the old format', '{"crop":{"x":0,"y":0,"w":10,"h":10}}'],
    ['no encode step', '{"spec":1,"crop":{"left":0,"top":0,"width":1,"height":1}}'],
    ['an empty object', '{}'],
  ])('refuses %s', async (_n, t) => {
    await expect(derived(ID.assetOriginal, t)).rejects.toThrow(/media_assets_transform_permitted/);
  });

  it('needs a known size and the right bucket', async () => {
    await expect(derived(ID.assetOriginal, CROP, { width: null })).rejects.toThrow(
      /media_assets_size_known/,
    );
    await expect(derived(ID.assetOriginal, CROP, { bucket: 'renders' })).rejects.toThrow(
      /media_assets_bucket_kind/,
    );
  });
});

describe('what an asset may be made from', () => {
  it('can be made from an original or another derived image', async () => {
    const first = await derived(ID.assetOriginal, CROP);
    await derived(first, CROP);
  });

  it('cannot be made from a render or from licence evidence', async () => {
    await expect(derived(ID.assetRender, CROP)).rejects.toThrow(/cannot be made from a render/);
    await expect(derived(ID.assetEvidence, CROP)).rejects.toThrow(/cannot be made from a evidence/);
  });

  it('keeps originals parentless', async () => {
    await expect(
      db.query(
        `insert into smb.media_assets (kind, bucket, path, sha256, mime, source_url, image_source_id, parent_asset_id)
         values ('original', 'originals', 'x.jpg', $1, 'image/jpeg', 'https://example.org/x', 'I1', $2)`,
        [hex('b'), ID.assetOriginal],
      ),
    ).rejects.toThrow(/media_assets_parent_kind/);
  });
});

describe('generated (AI-made) images', () => {
  const generation = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      input: 'text_only',
      model: 'z-image-turbo',
      prompt: 'grey studio backdrop',
      seed: 7,
      ...over,
    });
  const insert = (
    generationJson: string | null,
    over: { parent?: string | null; sourceUrl?: string | null } = {},
  ) =>
    db.query(
      `insert into smb.media_assets (kind, bucket, path, sha256, mime, width, height, parent_asset_id, source_url, generation)
       values ('generated', 'generated', $1, $2, 'image/png', 1024, 576, $3, $4, $5)`,
      [
        `g/${randomUUID()}.png`,
        hex('c'),
        over.parent ?? null,
        over.sourceUrl ?? null,
        generationJson,
      ],
    );

  it('is stored with a text-only generation record', async () => {
    await insert(generation());
  });

  it('is refused without a record, with image input, with a parent photo, or with a source URL', async () => {
    await expect(insert(null)).rejects.toThrow(/media_assets_generated_rules/);
    await expect(insert(generation({ input: 'image' }))).rejects.toThrow(
      /media_assets_generated_rules/,
    );
    await expect(insert(generation({ seed: undefined }))).rejects.toThrow(
      /media_assets_generated_rules/,
    );
    await expect(insert(generation(), { parent: ID.assetOriginal })).rejects.toThrow(
      /media_assets_(generated_rules|parent_kind)/,
    );
    await expect(insert(generation(), { sourceUrl: 'https://example.org/p.jpg' })).rejects.toThrow(
      /media_assets_generated_rules/,
    );
  });

  it('is not allowed on any other kind of asset', async () => {
    await expect(
      db.query(
        `insert into smb.media_assets (kind, bucket, path, sha256, mime, source_url, image_source_id, generation)
         values ('original', 'originals', 'y.jpg', $1, 'image/jpeg', 'https://example.org/y', 'I1', $2)`,
        [hex('d'), generation()],
      ),
    ).rejects.toThrow(/media_assets_generation_only_generated/);
  });

  it('has no licence to check, but nothing can be cut from it', async () => {
    await insert(generation());
    const [g] = await rows<{ id: string }>(
      db,
      "select id from smb.media_assets where kind = 'generated' limit 1",
    );
    const [p] = await rows<{ p: string | null }>(db, 'select smb.asset_licence_problem($1) as p', [
      g!.id,
    ]);
    expect(p!.p).toBeNull();
    await expect(derived(g!.id, CROP)).rejects.toThrow(/cannot be made from a generated/);
  });
});

describe('purged files', () => {
  it('can only be recorded for a deleted asset, and nothing else can change', async () => {
    const id = await derived(ID.assetOriginal, CROP);
    await expect(
      db.query('update smb.media_assets set purged_at = now() where id = $1', [id]),
    ).rejects.toThrow(/media_assets_purge_needs_delete/);
    await db.query('update smb.media_assets set deleted_at = now() where id = $1', [id]);
    await db.query('update smb.media_assets set purged_at = now() where id = $1', [id]);
    await expect(
      db.query('update smb.media_assets set sha256 = $2 where id = $1', [id, hex('e')]),
    ).rejects.toThrow(/append-only/);
  });
});

describe('integrity checks', () => {
  const check = (asset: string, kind: string, failures: string[] = []) =>
    db.query(
      `insert into smb.asset_integrity_checks (asset_id, check_kind, passed, failures, policy_version)
       values ($1, $2, $3, $4, 'integrity@1.0.0')`,
      [asset, kind, failures.length === 0, failures],
    );
  const problem = async (a: string) =>
    (await rows<{ p: string | null }>(db, 'select smb.asset_integrity_problem($1) as p', [a]))[0]!
      .p;

  it('is append-only and keeps passed consistent with the failure list', async () => {
    await check(ID.assetOriginal, 'original_hash');
    await expect(db.query('update smb.asset_integrity_checks set passed = false')).rejects.toThrow(
      /append-only/,
    );
    await expect(db.query('delete from smb.asset_integrity_checks')).rejects.toThrow(/append-only/);
    await expect(
      db.query(
        `insert into smb.asset_integrity_checks (asset_id, check_kind, passed, failures, policy_version)
         values ($1, 'original_hash', true, '{hash_mismatch}', 'x')`,
        [ID.assetOriginal],
      ),
    ).rejects.toThrow(/check constraint/);
  });

  it('needs the original hash-checked and the derived image rebuilt, with the newest check deciding', async () => {
    const d = await derived(ID.assetOriginal, CROP);
    expect(await problem(ID.assetOriginal)).toBeNull(); // checked in the previous test
    expect(await problem(d)).toMatch(/not been checked against its original/);

    await check(d, 'derived_rebuild', ['pixel_mismatch']);
    expect(await problem(d)).toMatch(/failed its check: pixel_mismatch/);
    await check(d, 'derived_rebuild');
    expect(await problem(d)).toBeNull();

    await check(ID.assetOriginal, 'original_hash', ['hash_mismatch']);
    expect(await problem(d)).toMatch(/original photograph failed its hash check/);
    expect(await problem(ID.assetOriginal)).toMatch(/failed its hash check/);
    await check(ID.assetOriginal, 'original_hash');
    expect(await problem(d)).toBeNull();
  });

  it('judges a render that contains a photograph by its region check', async () => {
    // The seeded render is cut from the seeded derived image, whose original is the seeded photo.
    expect(await problem(ID.assetRender)).toMatch(
      /photograph area of the render has not been checked/,
    );
    await check(ID.assetRender, 'region_match', ['local_edit']);
    expect(await problem(ID.assetRender)).toMatch(/render changed the photograph: local_edit/);
    await check(ID.assetRender, 'region_match');
    expect(await problem(ID.assetRender)).toBeNull();
  });
});
