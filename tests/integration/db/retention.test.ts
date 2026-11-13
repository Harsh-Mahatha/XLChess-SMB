import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshDb, hex, ID, rows } from './harness.js';

let db: pg.Client;
const ORPHAN_IMAGE = '00000000-0000-4000-8000-000000000f01';
const ORPHAN_RENDER = '00000000-0000-4000-8000-000000000f02';
const PINNED_IMAGE = '00000000-0000-4000-8000-000000000f03';

beforeAll(async () => {
  db = await freshDb();
  // Assets that never reached an approved revision, and one with an explicit far-future retention date.
  await db.query(
    `insert into smb.media_assets (id, kind, bucket, path, sha256, mime, source_url, image_source_id, retention_until) values
       ($1, 'original', 'originals', 'orphan.jpg', $3, 'image/jpeg', 'https://example.org/o.jpg', 'I2', null),
       ($2, 'original', 'originals', 'pinned.jpg', $3, 'image/jpeg', 'https://example.org/p.jpg', 'I2', now() + interval '2000 days')`,
    [ORPHAN_IMAGE, PINNED_IMAGE, hex('9')],
  );
  await db.query(
    `insert into smb.media_assets (id, kind, bucket, path, sha256, mime, template_version, width, height)
     values ($1, 'render', 'renders', 'orphan.png', $2, 'image/png', 'game-result@1', 1200, 675)`,
    [ORPHAN_RENDER, hex('8')],
  );
});
afterAll(async () => {
  await db.end();
});

describe('apply_retention', () => {
  it('removes expired unused data, and keeps everything that reached an approved or published post', async () => {
    const result = await rows<{ subject: string; affected: string }>(
      db,
      "select * from smb.apply_retention(now() + interval '200 days')",
    );
    const counts = Object.fromEntries(result.map((r) => [r.subject, Number(r.affected)]));
    expect(counts).toEqual({
      source_raw_payload: 2,
      unused_image: 1,
      unused_render: 1,
      job_payload: 1,
    });

    const assets = await rows<{ id: string; deleted_at: Date | null }>(
      db,
      'select id, deleted_at from smb.media_assets',
    );
    const deleted = new Set(assets.filter((a) => a.deleted_at).map((a) => a.id));
    expect(deleted).toEqual(new Set([ORPHAN_IMAGE, ORPHAN_RENDER]));
    // The original (an ancestor of the published render), its crop, the render and the licence evidence all survive.
    for (const id of [
      ID.assetOriginal,
      ID.assetDerived,
      ID.assetRender,
      ID.assetEvidence,
      PINNED_IMAGE,
    ]) {
      expect(deleted.has(id)).toBe(false);
    }
  });

  it('purges raw source payloads but keeps URL, hash and normalised record', async () => {
    const recs = await rows<{
      raw_payload: unknown;
      raw_purged_at: Date;
      payload_hash: string;
      url: string;
      normalised: unknown;
    }>(
      db,
      'select raw_payload, raw_purged_at, payload_hash, url, normalised from smb.source_records',
    );
    expect(recs).toHaveLength(2);
    for (const r of recs) {
      expect(r.raw_payload).toBeNull();
      expect(r.raw_purged_at).toBeInstanceOf(Date);
      expect(r.payload_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(r.url).toMatch(/^https:/);
      expect(r.normalised).not.toBeNull();
    }
  });

  it('trims finished job payloads but keeps the job row and its link to the candidates', async () => {
    const [job] = await rows<{
      payload: unknown;
      result: unknown;
      payload_purged_at: Date;
      kind: string;
    }>(db, 'select payload, result, payload_purged_at, kind from smb.jobs where id = $1', [ID.job]);
    expect(job.payload).toEqual({});
    expect(job.payload_purged_at).toBeInstanceOf(Date);
    const [{ n }] = await rows<{ n: string }>(
      db,
      'select count(*) n from smb.post_candidates where job_id = $1',
      [ID.job],
    );
    expect(Number(n)).toBe(3);
  });

  it('leaves provenance intact after the purge', async () => {
    const [p] = await rows<{ claims: unknown[]; assets: { licences: unknown[] }[] }>(
      db,
      'select claims, assets from smb.publication_provenance',
    );
    expect(p.claims).toHaveLength(2);
    expect(p.assets[0].licences).toHaveLength(1);
  });

  it('does nothing when nothing has expired', async () => {
    const fresh = await freshDb();
    try {
      // The day after the seed data was written, so every row is well inside its retention window.
      const result = await rows<{ affected: string }>(
        fresh,
        "select * from smb.apply_retention('2026-11-04 00:00+00')",
      );
      expect(result.every((r) => Number(r.affected) === 0)).toBe(true);
    } finally {
      await fresh.end();
    }
  });
});
