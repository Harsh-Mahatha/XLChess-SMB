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

const problem = async (asset: string) =>
  (await rows<{ p: string | null }>(db, 'select smb.asset_licence_problem($1) as p', [asset]))[0]!
    .p;

let cycle = 100;
/** A new revision on a fresh candidate, to attach assets to (the seed's revisions already have assets). */
async function newRevision(): Promise<string> {
  const candidate = randomUUID();
  const revision = randomUUID();
  await db.query(
    `insert into smb.post_candidates (id, opportunity_id, research_package_id, generation_cycle, slot, provider, prompt_version)
     values ($1, $2, $3, $4, 'A', 'stub', 'test@1')`,
    [candidate, ID.opportunity, ID.package, ++cycle],
  );
  await db.query(
    `insert into smb.post_revisions (id, candidate_id, revision_no, caption, channel_texts, content_hash, author_kind)
     values ($1, $2, 1, 'c', '{}', $3, 'ai')`,
    [revision, candidate, revision.replace(/-/g, '').repeat(2)],
  );
  return revision;
}

let counter = 0;
/** An original photo with the given licence settings; returns the asset id. */
async function photo(
  lic: {
    decision?: 'accepted' | 'rejected';
    commercial?: boolean;
    modifications?: boolean;
    attribution?: boolean;
    attributionText?: string | null;
  } = {},
): Promise<string> {
  const id = randomUUID();
  const n = ++counter;
  await db.query(
    `insert into smb.media_assets (id, kind, bucket, path, sha256, mime, source_url, image_source_id)
     values ($1, 'original', 'originals', $2, $3, 'image/jpeg', 'https://example.org/p.jpg', 'I1')`,
    [id, `t/${n}.jpg`, n.toString(16).padStart(64, '0')],
  );
  const decision = lic.decision ?? 'accepted';
  await db.query(
    `insert into smb.media_licenses (asset_id, original_url, licence_type, licence_version, licence_url,
       commercial_use_allowed, modifications_allowed, attribution_required, attribution_text,
       decision, decision_reason, verified_at, verified_by, policy_version)
     values ($1, 'https://example.org/p.jpg', 'CC BY-SA', '4.0', 'https://creativecommons.org/licenses/by-sa/4.0/',
       $2, $3, $4, $5, $6, $7, now(), 'system', 'licence-policy@1.0.0')`,
    [
      id,
      lic.commercial ?? true,
      lic.modifications ?? true,
      lic.attribution ?? true,
      lic.attributionText === undefined
        ? 'Photo: A / Wikimedia Commons, CC BY-SA 4.0'
        : lic.attributionText,
      decision,
      decision === 'rejected' ? 'non-commercial' : null,
    ],
  );
  return id;
}

async function derive(parent: string, n: number): Promise<string> {
  const id = randomUUID();
  await db.query(
    `insert into smb.media_assets (id, kind, bucket, path, sha256, mime, parent_asset_id, transform, width, height)
     values ($1, 'derived', 'derived', $2, $3, 'image/jpeg', $4,
       '{"spec":1,"crop":{"left":0,"top":0,"width":10,"height":10},"encode":{"format":"jpeg"}}', 10, 10)`,
    [id, `d/${n}-${id}.jpg`, (1000 + n).toString(16).padStart(64, '0'), parent],
  );
  return id;
}

describe('asset_licence_problem', () => {
  it('passes the seeded photo, its crop and its render', async () => {
    for (const a of [ID.assetOriginal, ID.assetDerived, ID.assetRender]) {
      expect(await problem(a)).toBeNull();
    }
  });

  it('passes an accepted CC BY-SA photo and a crop of it', async () => {
    const p = await photo();
    expect(await problem(p)).toBeNull();
    expect(await problem(await derive(p, 1))).toBeNull();
  });

  it('blocks a rejected licence, and everything cut from the photo', async () => {
    const p = await photo({ decision: 'rejected', commercial: false, modifications: false });
    expect(await problem(p)).toMatch(/licence was rejected: non-commercial/);
    expect(await problem(await derive(p, 2))).toMatch(/licence was rejected/);
  });

  it('blocks a photo without commercial use or without modification rights', async () => {
    // The accepted-licence check constraint already forbids commercial=false, so only modification can differ.
    const noMod = await photo({ modifications: false });
    expect(await problem(noMod)).toMatch(/does not allow modifications/);
  });

  it('blocks a photo with no licence record at all', async () => {
    const id = randomUUID();
    await db.query(
      `insert into smb.media_assets (id, kind, bucket, path, sha256, mime, source_url, image_source_id)
       values ($1, 'original', 'originals', 'nolicence.jpg', $2, 'image/jpeg', 'https://example.org/x.jpg', 'I1')`,
      [id, hex('e')],
    );
    expect(await problem(id)).toMatch(/no licence record/);
  });

  it('lets the newest licence row decide, so a later rejection withdraws the photo', async () => {
    const p = await photo();
    expect(await problem(p)).toBeNull();
    await db.query(
      `insert into smb.media_licenses (asset_id, original_url, licence_type, commercial_use_allowed, modifications_allowed,
         attribution_required, decision, decision_reason, verified_at, verified_by)
       values ($1, 'https://example.org/p.jpg', 'unknown', false, false, true, 'rejected', 'licence changed', now(), 'system')`,
      [p],
    );
    expect(await problem(p)).toMatch(/licence changed/);
  });

  it('blocks evidence files, deleted photos and missing assets', async () => {
    expect(await problem(ID.assetEvidence)).toMatch(/evidence/);
    expect(await problem(randomUUID())).toMatch(/does not exist/);
    const p = await photo();
    await db.query('update smb.media_assets set deleted_at = now() where id = $1', [p]);
    expect(await problem(p)).toMatch(/deleted/);
  });

  it('refuses an accepted licence that lacks the credit it requires', async () => {
    await expect(photo({ attributionText: null })).rejects.toThrow(/check constraint/);
  });
});

describe('revision_assets licence guard', () => {
  it('lets a licensed photo into a revision', async () => {
    const rev = await newRevision();
    const p = await photo();
    await db.query(
      'insert into smb.revision_assets (revision_id, asset_id, role) values ($1, $2, $3)',
      [rev, p, 'photo'],
    );
    const n = await rows(db, 'select 1 from smb.revision_assets where revision_id = $1', [rev]);
    expect(n).toHaveLength(1);
  });

  it('refuses an unlicensed photo and a crop of one', async () => {
    const rev = await newRevision();
    const bad = await photo({ decision: 'rejected', commercial: false, modifications: false });
    const crop = await derive(bad, 3);
    for (const a of [bad, crop]) {
      await expect(
        db.query(
          'insert into smb.revision_assets (revision_id, asset_id, role) values ($1, $2, $3)',
          [rev, a, 'photo'],
        ),
      ).rejects.toThrow(/cannot be used in a revision: the licence was rejected/);
    }
  });

  it('refuses licence evidence as a post asset', async () => {
    const rev = await newRevision();
    await expect(
      db.query(
        'insert into smb.revision_assets (revision_id, asset_id, role) values ($1, $2, $3)',
        [rev, ID.assetEvidence, 'image'],
      ),
    ).rejects.toThrow(/licence evidence/);
  });
});

describe('image_candidates', () => {
  const insert = (over: Record<string, unknown> = {}) => {
    const v = {
      opportunity_id: ID.opportunity,
      image_source_id: 'I1',
      external_id: `File:${randomUUID()}.jpg`,
      decision: 'accepted',
      decision_reason: null,
      eligible: true,
      chosen: false,
      asset_id: null,
      license_id: null,
      ...over,
    };
    return db.query(
      `insert into smb.image_candidates (opportunity_id, image_source_id, external_id, title, page_url, image_url, mime,
         width, height, subject, match_kind, decision, rejection_codes, decision_reason, eligible, score, score_detail,
         chosen, evidence, policy_version, scorer_version, asset_id, license_id)
       values ($1, $2, $3, 't', 'https://commons.wikimedia.org/wiki/File:t.jpg', 'https://upload.wikimedia.org/t.jpg', 'image/jpeg',
         3000, 2000, '{"role":"venue","name":"Singapore"}', 'search', $4, '{}', $5, $6, 0.8, '{}', $7, '{}', 'p@1', 's@1', $8, $9)`,
      [
        v.opportunity_id,
        v.image_source_id,
        v.external_id,
        v.decision,
        v.decision_reason,
        v.eligible,
        v.chosen,
        v.asset_id,
        v.license_id,
      ],
    );
  };

  it('logs a rejected photo without any stored file', async () => {
    await insert({ decision: 'rejected', decision_reason: 'non-commercial', eligible: true });
  });

  it('requires a reason for a rejection', async () => {
    await expect(insert({ decision: 'rejected' })).rejects.toThrow(/check constraint/);
  });

  it('only lets a licence-approved, stored photo be chosen', async () => {
    await expect(insert({ chosen: true })).rejects.toThrow(/check constraint/);
    await expect(
      insert({
        chosen: true,
        decision: 'rejected',
        decision_reason: 'x',
        asset_id: ID.assetOriginal,
        license_id: ID.licence,
      }),
    ).rejects.toThrow(/check constraint/);
    await insert({ chosen: true, asset_id: ID.assetOriginal, license_id: ID.licence });
  });

  it('keeps one row per opportunity, source and file, and is append-only', async () => {
    const id = 'File:dup.jpg';
    await insert({ external_id: id });
    await expect(insert({ external_id: id })).rejects.toThrow(/duplicate key/);
    await expect(db.query("update smb.image_candidates set decision = 'accepted'")).rejects.toThrow(
      /append-only/,
    );
    await expect(db.query('delete from smb.image_candidates')).rejects.toThrow(/append-only/);
  });
});
