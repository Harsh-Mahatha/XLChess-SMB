import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshDb, hex, ID } from './harness.js';

let db: pg.Client;
beforeAll(async () => {
  db = await freshDb();
});
afterAll(async () => {
  await db.end();
});

const q = (sql: string, params: unknown[] = []) => db.query(sql, params);

describe('opportunities and candidates', () => {
  it('rejects a duplicate dedupe_key', async () => {
    await expect(
      q(`insert into smb.post_opportunities (post_type_id, post_config_id, dedupe_key, trigger_kind)
         values ('1.1', '${ID.config}', '1.1:wcc-2026:game-7', 'event')`),
    ).rejects.toThrow(/duplicate key/);
  });

  it('allows only three candidate slots per generation cycle', async () => {
    const insert = (slot: string, cycle: number) =>
      q(
        `insert into smb.post_candidates (opportunity_id, research_package_id, generation_cycle, slot, provider, prompt_version)
         values ($1, $2, $3, $4, 'stub', 'p@1')`,
        [ID.opportunity, ID.package, cycle, slot],
      );
    await expect(insert('D', 1)).rejects.toThrow(/check constraint/);
    await expect(insert('A', 1)).rejects.toThrow(/duplicate key/);
    await insert('A', 2); // a new cycle starts again at A
  });

  it('allows only one active config per post type', async () => {
    await expect(
      q(
        `insert into smb.post_configs (post_type_id, version, config_json, content_hash, file_hash, origin, override, is_active)
         values ('1.1', 2, '{}', $1, $1, 'override', '{}', true)`,
        [hex('b')],
      ),
    ).rejects.toThrow(/post_configs_one_active/);
  });
});

describe('claims and revisions', () => {
  it('requires computed claims to say how they were computed', async () => {
    await expect(
      q(`insert into smb.research_claims (package_id, claim_key, description, value, computed)
         values ('${ID.package}', 'k', 'd', '1', true)`),
    ).rejects.toThrow(/check constraint/);
  });

  it('requires a human revision to name its author, and a parent for every revision after the first', async () => {
    const insert = (no: number, parent: string | null, kind: string, author: string | null) =>
      q(
        `insert into smb.post_revisions (candidate_id, revision_no, parent_revision_id, caption, content_hash, author_kind, author_id)
         values ('${ID.candidateA}', $1, $2, 'c', $3, $4, $5)`,
        [no, parent, hex('c'), kind, author],
      );
    await expect(insert(1, null, 'human', null)).rejects.toThrow(/check constraint/);
    await expect(insert(2, null, 'ai', null)).rejects.toThrow(/check constraint/);
    await expect(insert(1, ID.revision1, 'ai', null)).rejects.toThrow(/check constraint/);
    await insert(1, null, 'ai', null);
  });
});

describe('assets and licences', () => {
  it('rejects an original without a source URL and a derived asset without a parent', async () => {
    await expect(
      q(
        `insert into smb.media_assets (kind, bucket, path, sha256, mime) values ('original', 'originals', 'a1', '${hex('d')}', 'image/jpeg')`,
      ),
    ).rejects.toThrow(/check constraint/);
    await expect(
      q(`insert into smb.media_assets (kind, bucket, path, sha256, mime, transform)
         values ('derived', 'renders', 'a2', '${hex('d')}', 'image/jpeg', '{}')`),
    ).rejects.toThrow(/check constraint/);
    await expect(
      q(
        `insert into smb.media_assets (kind, bucket, path, sha256, mime) values ('render', 'renders', 'a3', '${hex('d')}', 'image/png')`,
      ),
    ).rejects.toThrow(/check constraint/);
  });

  it('only accepts a licence that allows commercial use and has evidence', async () => {
    const licence = (commercial: boolean, url: string | null, evidence: string | null) =>
      q(
        `insert into smb.media_licenses (asset_id, original_url, licence_type, licence_url, evidence_asset_id,
           commercial_use_allowed, modifications_allowed, attribution_required, decision, verified_at, verified_by)
         values ($1, 'https://example.org/p.jpg', 'CC BY-NC', $2, $3, $4, true, false, 'accepted', now(), 'system')`,
        [ID.assetOriginal, url, evidence, commercial],
      );
    await expect(licence(false, 'https://example.org/l', null)).rejects.toThrow(/check constraint/); // non-commercial
    await expect(licence(true, null, null)).rejects.toThrow(/check constraint/); // no evidence
    await licence(true, 'https://example.org/l', null);
  });

  it('requires a reason when a licence is rejected', async () => {
    await expect(
      q(`insert into smb.media_licenses (asset_id, original_url, licence_type, commercial_use_allowed, modifications_allowed,
           attribution_required, decision, verified_at, verified_by)
         values ('${ID.assetOriginal}', 'u', 'unknown', false, false, false, 'rejected', now(), 'system')`),
    ).rejects.toThrow(/check constraint/);
  });
});

describe('approval and publication binding', () => {
  const approve = (hash: string, channels: string) =>
    q(
      `insert into smb.review_actions (opportunity_id, candidate_id, revision_id, action, content_hash, reviewer_id, channels)
       values ('${ID.opportunity}', '${ID.candidateB}', '${ID.revision1}', 'approve', $1, 'xlchess-user-2', '${channels}')`,
      [hash],
    );
  const revision1Hash = () =>
    q(`select content_hash from smb.post_revisions where id = '${ID.revision1}'`).then(
      (r) => r.rows[0].content_hash as string,
    );

  it('refuses an approval whose hash differs from the revision (content changed after review)', async () => {
    await expect(approve(hex('e'), '{x}')).rejects.toThrow(/does not match revision/);
  });

  it('refuses an approval with no channels', async () => {
    await expect(approve(await revision1Hash(), '{}')).rejects.toThrow(/check constraint/);
  });

  it('refuses a reject without any feedback', async () => {
    await expect(
      q(
        `insert into smb.review_actions (opportunity_id, action, reviewer_id) values ('${ID.opportunity}', 'reject', 'xlchess-user-2')`,
      ),
    ).rejects.toThrow(/check constraint/);
  });

  it('does not allow publishing to a channel that was not approved', async () => {
    await expect(
      q(
        `insert into smb.publications (approval_id, revision_id, channel, mode, content_hash, idempotency_key)
         values ('${ID.approval}', '${ID.revision2}', 'facebook', 'dry_run', $1, 'k-fb')`,
        [
          (await q(`select content_hash from smb.post_revisions where id = '${ID.revision2}'`))
            .rows[0].content_hash,
        ],
      ),
    ).rejects.toThrow(/was not approved/);
  });

  it('does not allow a publication whose hash differs from the approval', async () => {
    await expect(
      q(
        `insert into smb.publications (approval_id, revision_id, channel, mode, content_hash, idempotency_key)
         values ('${ID.approval}', '${ID.revision2}', 'x', 'dry_run', $1, 'k-other')`,
        [hex('f')],
      ),
    ).rejects.toThrow(/does not match the approval/);
  });

  it('keeps one publication per approval and channel, and a unique idempotency key', async () => {
    const hash = (
      await q(`select content_hash from smb.post_revisions where id = '${ID.revision2}'`)
    ).rows[0].content_hash;
    await expect(
      q(
        `insert into smb.publications (approval_id, revision_id, channel, mode, content_hash, idempotency_key)
         values ('${ID.approval}', '${ID.revision2}', 'x', 'dry_run', $1, 'another-key')`,
        [hash],
      ),
    ).rejects.toThrow(/duplicate key/);
  });

  it('enforces publication status transition rules', async () => {
    await expect(
      q(`update smb.publications set status = 'published' where id = '${ID.publication}'`),
    ).rejects.toThrow(/invalid publication status transition from dry_run_recorded to published/);
  });

  it('requires an external id, published_at and url before a publication can be marked published', async () => {
    const opp = (
      await q(
        `insert into smb.post_opportunities (post_type_id, post_config_id, dedupe_key, trigger_kind)
         values ('1.1', '${ID.config}', '1.1:wcc-2026:game-7-constraint-test', 'event')
         returning id`,
      )
    ).rows[0].id;
    const cand = (
      await q(
        `insert into smb.post_candidates (opportunity_id, research_package_id, generation_cycle, slot, provider, prompt_version)
         values ($1, '${ID.package}', 1, 'A', 'stub', 'p@1')
         returning id`,
        [opp],
      )
    ).rows[0].id;
    const rev = (
      await q(
        `insert into smb.post_revisions (candidate_id, revision_no, caption, content_hash, author_kind)
         values ($1, 1, 'cap', '${hex('a')}', 'ai')
         returning id`,
        [cand],
      )
    ).rows[0].id;
    const app = (
      await q(
        `insert into smb.review_actions (opportunity_id, candidate_id, revision_id, action, content_hash, reviewer_id, channels)
         values ($1, $2, $3, 'approve', '${hex('a')}', 'user-1', '{x}')
         returning id`,
        [opp, cand, rev],
      )
    ).rows[0].id;
    const pub = (
      await q(
        `insert into smb.publications (approval_id, revision_id, channel, mode, status, content_hash, idempotency_key)
         values ($1, $2, 'x', 'live', 'pending', '${hex('a')}', 'pub-live-constraints')
         returning id`,
        [app, rev],
      )
    ).rows[0].id;

    await q(`update smb.publications set status = 'publishing' where id = $1`, [pub]);

    // Missing external_id and published_at
    await expect(
      q(`update smb.publications set status = 'published' where id = $1`, [pub]),
    ).rejects.toThrow(/check constraint/);

    // Missing url even if external_id and published_at are provided
    await expect(
      q(
        `update smb.publications set status = 'published', external_id = '123', published_at = now() where id = $1`,
        [pub],
      ),
    ).rejects.toThrow(/publications_published_url_check/);
  });

  it('enforces mode consistency with status on publications', async () => {
    const opp = (
      await q(
        `insert into smb.post_opportunities (post_type_id, post_config_id, dedupe_key, trigger_kind)
         values ('1.1', '${ID.config}', '1.1:wcc-2026:game-7-mode-test', 'event')
         returning id`,
      )
    ).rows[0].id;
    const cand = (
      await q(
        `insert into smb.post_candidates (opportunity_id, research_package_id, generation_cycle, slot, provider, prompt_version)
         values ($1, '${ID.package}', 1, 'A', 'stub', 'p@1')
         returning id`,
        [opp],
      )
    ).rows[0].id;
    const rev = (
      await q(
        `insert into smb.post_revisions (candidate_id, revision_no, caption, content_hash, author_kind)
         values ($1, 1, 'cap', '${hex('b')}', 'ai')
         returning id`,
        [cand],
      )
    ).rows[0].id;
    const app = (
      await q(
        `insert into smb.review_actions (opportunity_id, candidate_id, revision_id, action, content_hash, reviewer_id, channels)
         values ($1, $2, $3, 'approve', '${hex('b')}', 'user-1', '{x}')
         returning id`,
        [opp, cand, rev],
      )
    ).rows[0].id;

    // dry_run_recorded requires mode = 'dry_run'
    await expect(
      q(
        `insert into smb.publications (approval_id, revision_id, channel, mode, status, content_hash, idempotency_key)
         values ($1, $2, 'x', 'live', 'dry_run_recorded', '${hex('b')}', 'pub-mode-err-1')`,
        [app, rev],
      ),
    ).rejects.toThrow(/publications_dry_run_recorded_check/);
  });
});

describe('jobs', () => {
  it('requires a lease for a leased job and no lease otherwise', async () => {
    await expect(
      q(`insert into smb.jobs (lane, kind, status) values ('gpu', 'story_select', 'leased')`),
    ).rejects.toThrow(/check constraint/);
    await expect(
      q(
        `insert into smb.jobs (lane, kind, status, lease_id) values ('gpu', 'story_select', 'queued', gen_random_uuid())`,
      ),
    ).rejects.toThrow(/check constraint/);
  });

  it('rejects a duplicate idempotency key', async () => {
    await q(
      `insert into smb.jobs (lane, kind, idempotency_key) values ('server', 'research', 'once')`,
    );
    await expect(
      q(`insert into smb.jobs (lane, kind, idempotency_key) values ('server', 'research', 'once')`),
    ).rejects.toThrow(/duplicate key/);
  });
});

describe('schedules and triggers', () => {
  it('requires an inactive_reason iff state is inactive', async () => {
    const insert = (state: string, reason: string | null) =>
      q(
        `insert into smb.schedules (post_type_id, rule_key, rule, timezone, anchor_at, cursor_at, state, inactive_reason)
         values ('1.1', $1, '{"kind":"weekly","day":"fri","time":"09:00"}', 'UTC', now(), now(), $2, $3)`,
        [`rk-${state}-${reason ?? 'null'}`, state, reason],
      );
    await expect(insert('inactive', null)).rejects.toThrow(/check constraint/);
    await expect(insert('active', 'suspended')).rejects.toThrow(/check constraint/);
    await expect(insert('unknown_state', null)).rejects.toThrow(/check constraint/);
    await expect(insert('inactive', 'unknown_reason')).rejects.toThrow(/check constraint/);
    await insert('active', null);
    await insert('inactive', 'suspended');
  });

  it('rejects duplicate schedule rule_key per post type', async () => {
    await expect(
      q(
        `insert into smb.schedules (post_type_id, rule_key, rule, timezone, anchor_at, cursor_at, state)
         values ('1.1', 'rk-active-null', '{"kind":"weekly","day":"fri","time":"09:00"}', 'UTC', now(), now(), 'active')`,
      ),
    ).rejects.toThrow(/duplicate key/);
  });

  it('validates trigger_log outcome and trigger_kind', async () => {
    await expect(
      q(
        `insert into smb.trigger_log (post_type_id, trigger_kind, outcome, reason)
         values ('1.1', 'invalid_kind', 'created', 'test')`,
      ),
    ).rejects.toThrow(/check constraint/);
    await expect(
      q(
        `insert into smb.trigger_log (post_type_id, trigger_kind, outcome, reason)
         values ('1.1', 'schedule', 'invalid_outcome', 'test')`,
      ),
    ).rejects.toThrow(/check constraint/);
  });
});

describe('access', () => {
  it.each(['anon', 'authenticated'])('%s cannot read the smb schema', async (role) => {
    await q('begin');
    try {
      await q(`set local role ${role}`);
      await expect(q('select 1 from smb.jobs')).rejects.toThrow(/permission denied/);
    } finally {
      await q('rollback');
    }
  });
});
