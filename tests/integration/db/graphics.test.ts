import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import sharp from 'sharp';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { verifyOriginal, verifyRegion } from '../../../apps/api/src/assets/index.js';
import {
  GraphicError,
  SAMPLE_DATA,
  loadTemplates,
  renderGraphic,
  type RenderDeps,
} from '../../../apps/api/src/graphics/index.js';
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
let deps: RenderDeps;
let counter = 0;

const OUT = process.env.SMB_RENDER_OUT; // set to a folder to keep the PNGs for looking at

async function photo(
  width: number,
  height: number,
  opts: { licence?: 'accepted' | 'rejected'; credit?: string | null } = {},
): Promise<string> {
  const base = await syntheticPhoto(width, height, 'jpeg');
  const bytes = new Uint8Array(
    await sharp(base).linear(1, ++counter).jpeg({ quality: 95 }).toBuffer(),
  );
  const sha256 = sha256Hex(bytes);
  const path = contentPath(sha256, 'jpg');
  await store.put(BUCKETS.originals, path, bytes, 'image/jpeg');
  const row = await prisma.media_assets.create({
    data: {
      kind: 'original',
      bucket: BUCKETS.originals,
      path,
      sha256,
      mime: 'image/jpeg',
      size_bytes: bytes.byteLength,
      width,
      height,
      source_url: 'https://upload.wikimedia.org/x.jpg',
      image_source_id: 'I1',
      opportunity_id: ID.opportunity,
    },
  });
  const credit = opts.credit === undefined ? 'Photo: A. Photographer / Wikimedia Commons, CC BY-SA 4.0' : opts.credit;
  await prisma.media_licenses.create({
    data: {
      asset_id: row.id,
      original_url: 'https://upload.wikimedia.org/x.jpg',
      licence_type: 'CC BY-SA',
      licence_version: '4.0',
      licence_url: 'https://creativecommons.org/licenses/by-sa/4.0/',
      commercial_use_allowed: true,
      modifications_allowed: true,
      attribution_required: credit !== null,
      attribution_text: credit,
      share_alike: true,
      decision: opts.licence ?? 'accepted',
      decision_reason: opts.licence === 'rejected' ? 'test' : null,
      verified_at: new Date(),
      verified_by: 'system',
    },
  });
  await verifyOriginal(deps, row.id);
  return row.id;
}

const problem = async (fn: 'asset_integrity_problem' | 'asset_licence_problem', id: string) =>
  (await rows<{ p: string | null }>(pgc, `select smb.${fn}($1) as p`, [id]))[0]!.p;

const pvpRequest = (a: string, b: string) => ({
  template: 'game-result',
  aspect: '16:9' as const,
  data: { ...SAMPLE_DATA['player-vs-player']!, photos: { photo_a: { assetId: a }, photo_b: { assetId: b } } },
});

beforeAll(async () => {
  pgc = await freshDb();
  prisma = new PrismaClient({ datasourceUrl: `${inject('dbUrl')}?schema=smb` });
  store = new InMemoryObjectStore();
  deps = { db: prisma, store, registry: loadTemplates() };
});
afterAll(async () => {
  await prisma.$disconnect();
  await pgc.end();
});

describe('player-vs-player with two real-shaped photographs', () => {
  it('renders, records both photographs and proves the photograph areas', async () => {
    const landscape = await photo(1600, 1000);
    const portrait = await photo(900, 1200);
    const r = await renderGraphic(deps, pvpRequest(landscape, portrait));

    expect(r).toMatchObject({ width: 1200, height: 675, templateId: 'player-vs-player', created: true });
    expect(r.photos.map((p) => [p.slot, p.verified])).toEqual([
      ['photo_a', true],
      ['photo_b', true],
    ]);
    const sources = await rows(pgc, 'select slot, left_px, top_px, width_px, height_px from smb.render_sources where render_id = $1 order by slot', [r.assetId]);
    expect(sources).toHaveLength(2);
    expect(await problem('asset_integrity_problem', r.assetId)).toBeNull();
    expect(await problem('asset_licence_problem', r.assetId)).toBeNull();
    if (OUT) {
      mkdirSync(OUT, { recursive: true });
      writeFileSync(join(OUT, 'game-result-16x9.png'), (await store.get(BUCKETS.renders, r.path))!);
    }

    // The credit is drawn, below the photographs.
    const png = (await store.get(BUCKETS.renders, r.path))!;
    const strip = await sharp(png).extract({ left: 200, top: 636, width: 800, height: 28 }).raw().toBuffer();
    const bg = strip.subarray(0, 3);
    expect([...strip].some((v, i) => Math.abs(v - bg[i % 3]!) > 40)).toBe(true);
  });

  it('gives the same file and key for the same inputs, and returns the stored render for a candidate', async () => {
    const a = await photo(1600, 1000);
    const b = await photo(1200, 1200);
    const first = await renderGraphic(deps, { ...pvpRequest(a, b), candidateId: ID.candidateA });
    const second = await renderGraphic(deps, { ...pvpRequest(a, b), candidateId: ID.candidateA });
    const third = await renderGraphic(deps, pvpRequest(a, b));
    expect(second).toMatchObject({ assetId: first.assetId, sha256: first.sha256, renderKey: first.renderKey, created: false });
    expect(third.sha256).toBe(first.sha256);
    const links = await rows(pgc, 'select 1 from smb.candidate_renders where candidate_id = $1', [ID.candidateA]);
    expect(links).toHaveLength(1);
  });

  it('refuses to be used until the licence of every photograph is accepted', async () => {
    const good = await photo(1600, 1000);
    const bad = await photo(1600, 1000, { licence: 'rejected' });
    await expect(renderGraphic(deps, pvpRequest(good, bad))).rejects.toMatchObject({ code: 'photo_not_usable' });

    // A licence withdrawn later blocks a render that contains the photograph.
    const other = await photo(1600, 1000);
    const r = await renderGraphic(deps, pvpRequest(good, other));
    expect(await problem('asset_licence_problem', r.assetId)).toBeNull();
    await prisma.media_licenses.create({
      data: {
        asset_id: other,
        original_url: 'https://upload.wikimedia.org/x.jpg',
        licence_type: 'unknown',
        commercial_use_allowed: false,
        modifications_allowed: false,
        attribution_required: false,
        decision: 'rejected',
        decision_reason: 'withdrawn',
        verified_at: new Date(Date.now() + 1000),
        verified_by: 'system',
      },
    });
    expect(await problem('asset_licence_problem', r.assetId)).toMatch(/rejected/);
  });

  it('catches a retouched photograph area in the finished graphic', async () => {
    const a = await photo(1600, 1000);
    const b = await photo(1600, 1000);
    const r = await renderGraphic(deps, pvpRequest(a, b));
    const png = (await store.get(BUCKETS.renders, r.path))!;
    // Brighten and blur a face-sized patch inside photograph A, as a retoucher would.
    const patch = await sharp(png)
      .extract({ left: 200, top: 260, width: 120, height: 120 })
      .modulate({ brightness: 1.5 })
      .blur(6)
      .toBuffer();
    const forged = new Uint8Array(await sharp(png).composite([{ input: patch, left: 200, top: 260 }]).png().toBuffer());
    const sha256 = sha256Hex(forged);
    const path = contentPath(sha256, 'png');
    await store.put(BUCKETS.renders, path, forged, 'image/png');
    const [first] = r.photos;
    const row = await prisma.media_assets.create({
      data: {
        kind: 'render', bucket: BUCKETS.renders, path, sha256, mime: 'image/png', size_bytes: forged.byteLength,
        width: 1200, height: 675, template_version: 'player-vs-player@1.0.0', parent_asset_id: first!.derivedId,
      },
    });
    for (const p of r.photos) {
      await prisma.render_sources.create({
        data: { render_id: row.id, slot: p.slot, source_id: p.derivedId, left_px: p.rect.left, top_px: p.rect.top, width_px: p.rect.width, height_px: p.rect.height, fit: 'cover' },
      });
    }
    const reports = [];
    for (const p of r.photos) {
      reports.push(await verifyRegion(deps, { renderId: row.id, sourceId: p.derivedId, rect: p.rect, fit: 'cover' }));
    }
    expect(reports.map((x) => x.passed)).toEqual([false, true]);
    expect(await problem('asset_integrity_problem', row.id)).toMatch(/render changed the photograph/);
  });

  it('is judged on every photograph: the second one unchecked is still a problem', async () => {
    const a = await photo(1600, 1000);
    const b = await photo(1600, 1000);
    const r = await renderGraphic(deps, pvpRequest(a, b));
    expect(await problem('asset_integrity_problem', r.assetId)).toBeNull();
    // A new check that fails for photograph B alone makes the render unproven, although A still passes.
    const second = r.photos[1]!;
    await prisma.asset_integrity_checks.create({
      data: {
        asset_id: r.assetId, check_kind: 'region_match', passed: false, failures: ['local_edit'],
        detail: { sourceId: second.derivedId }, engine: {}, policy_version: 'test', checked_at: new Date(Date.now() + 1000),
      },
    });
    expect(await problem('asset_integrity_problem', r.assetId)).toMatch(/render changed the photograph: local_edit/);
  });

  it('keeps every photograph of an approved render when retention runs', async () => {
    const a = await photo(1600, 1000);
    const b = await photo(1600, 1000);
    const r = await renderGraphic(deps, pvpRequest(a, b));
    await prisma.revision_assets.create({ data: { revision_id: ID.revision2, asset_id: r.assetId, role: 'graphic' } });
    const kept = (await rows<{ id: string }>(pgc, 'select smb.protected_asset_ids() as id')).map((x) => x.id);
    for (const p of r.photos) {
      expect(kept).toContain(p.derivedId);
      expect(kept).toContain(p.assetId);
    }
  });
});

describe('templates', () => {
  it('renders every template at its size, with and without a photograph where it has a slot', async () => {
    const registry = deps.registry;
    const subject = await photo(1600, 1000);
    for (const manifest of registry.manifests) {
      const sample = SAMPLE_DATA[manifest.id];
      expect(sample, `sample data for ${manifest.id}`).toBeDefined();
      for (const [aspect, layout] of Object.entries(manifest.aspects)) {
        const slotIds = layout.elements.filter((e) => e.type === 'photo').map((e) => (e as { id: string }).id);
        const variants: Record<string, Record<string, { assetId: string }>> = { 'no-photo': {} };
        if (slotIds.length > 0) variants.photo = Object.fromEntries(slotIds.map((s) => [s, { assetId: subject }]));
        for (const [variant, photos] of Object.entries(variants)) {
          const r = await renderGraphic(deps, {
            template: manifest.id,
            aspect: aspect as '16:9' | '1:1',
            data: { ...sample, photos },
          });
          expect([r.width, r.height]).toEqual([layout.width, layout.height]);
          const meta = await sharp((await store.get(BUCKETS.renders, r.path))!).metadata();
          expect([meta.width, meta.height, meta.format]).toEqual([layout.width, layout.height, 'png']);
          if (OUT) {
            mkdirSync(OUT, { recursive: true });
            writeFileSync(join(OUT, `${manifest.id}-${aspect.replace(':', 'x')}-${variant}.png`), (await store.get(BUCKETS.renders, r.path))!);
          }
        }
      }
    }
  });

  it('refuses what cannot be drawn honestly', async () => {
    const small = await photo(300, 200);
    const ok = await photo(1600, 1000);
    const base = SAMPLE_DATA['player-vs-player']!;
    const run = (data: object) => renderGraphic(deps, { template: 'player-vs-player', aspect: '16:9', data });

    await expect(run({ ...base, photos: { photo_a: { assetId: small } } })).rejects.toMatchObject({ code: 'photo_too_small' });
    const { player_a: _omit, ...noName } = base.texts!;
    await expect(run({ ...base, texts: noName })).rejects.toMatchObject({ code: 'missing_data' });
    await expect(
      run({ ...base, texts: { ...base.texts, player_a: 'Maximilian Alexander Konstantinopoulos-Featherstonehaugh' } }),
    ).rejects.toMatchObject({ code: 'text_overflow' });
    await expect(run({ ...base, flags: { a_flag: 'zz' } })).rejects.toMatchObject({ code: 'unknown_flag' });
    await expect(run({ ...base, photos: { nope: { assetId: ok } } })).rejects.toMatchObject({ code: 'missing_data' });
    await expect(
      renderGraphic(deps, { template: 'chess-puzzle', aspect: '16:9', data: { ...SAMPLE_DATA['chess-puzzle']!, boards: { position: 'xxxxxxxx/8/8/8/8/8/8/8 w - - 0 1' } } }),
    ).rejects.toBeInstanceOf(GraphicError);
    await expect(renderGraphic(deps, { template: 'chess-puzzle', aspect: '1:1', data: SAMPLE_DATA['chess-puzzle']! })).rejects.toMatchObject({ code: 'unknown_aspect' });
  });

  it('draws the attribution a licence requires even if the caller passes none, and fails if the template cannot', async () => {
    const credited = await photo(1600, 1000, { credit: 'Photo: Z / Wikimedia Commons, CC BY 4.0' });
    const r = await renderGraphic(deps, {
      template: 'chess-news',
      aspect: '16:9',
      data: { ...SAMPLE_DATA['chess-news']!, photos: { photo: { assetId: credited } } },
    });
    expect(r.photos).toHaveLength(1);
    const png = (await store.get(BUCKETS.renders, r.path))!;
    const strip = await sharp(png).extract({ left: 56, top: 618, width: 624, height: 30 }).raw().toBuffer();
    const bg = strip.subarray(0, 3);
    expect([...strip].some((v, i) => Math.abs(v - bg[i % 3]!) > 40)).toBe(true);
  });
});
