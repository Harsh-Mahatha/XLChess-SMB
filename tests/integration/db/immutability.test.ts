import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshDb, ID } from './harness.js';

let db: pg.Client;
beforeAll(async () => {
  db = await freshDb();
  await db.query(
    "insert into smb.post_metrics (subject_type, metric, value) values ('system', 'seed_metric', 1)",
  );
});
afterAll(async () => {
  await db.end();
});

const q = (sql: string) => db.query(sql);

// [table, a statement that changes protected data, a DELETE]
const PROTECTED: [string, string, string][] = [
  [
    'post_revisions',
    `update smb.post_revisions set caption = 'x' where id = '${ID.revision2}'`,
    `delete from smb.post_revisions where id = '${ID.revision2}'`,
  ],
  [
    'review_actions',
    `update smb.review_actions set reviewer_id = 'x' where id = '${ID.approval}'`,
    `delete from smb.review_actions where id = '${ID.approval}'`,
  ],
  [
    'research_claims',
    `update smb.research_claims set value = '9' where id = '${ID.claimDiff}'`,
    `delete from smb.research_claims where id = '${ID.claimDiff}'`,
  ],
  [
    'research_claim_sources',
    `update smb.research_claim_sources set claim_id = '${ID.claimDiff}' where claim_id = '${ID.claimResult}'`,
    `delete from smb.research_claim_sources`,
  ],
  [
    'media_licenses',
    `update smb.media_licenses set decision = 'rejected', decision_reason = 'x' where id = '${ID.licence}'`,
    `delete from smb.media_licenses where id = '${ID.licence}'`,
  ],
  [
    'opportunity_events',
    `update smb.opportunity_events set actor = 'x'`,
    `delete from smb.opportunity_events`,
  ],
  [
    'post_candidates',
    `update smb.post_candidates set prompt_version = 'x' where id = '${ID.candidateA}'`,
    `delete from smb.post_candidates where id = '${ID.candidateA}'`,
  ],
  [
    'revision_claims',
    `update smb.revision_claims set claim_id = '${ID.claimDiff}' where claim_id = '${ID.claimResult}'`,
    `delete from smb.revision_claims`,
  ],
  [
    'revision_assets',
    `update smb.revision_assets set role = 'x'`,
    `delete from smb.revision_assets`,
  ],
  [
    'publication_attempts',
    `update smb.publication_attempts set outcome = 'success'`,
    `delete from smb.publication_attempts`,
  ],
  ['post_metrics', `update smb.post_metrics set value = 2`, `delete from smb.post_metrics`],
  ['audit_log', `update smb.audit_log set actor = 'x'`, `delete from smb.audit_log`],
  [
    'post_configs',
    `update smb.post_configs set config_json = '{}' where id = '${ID.config}'`,
    `delete from smb.post_configs where id = '${ID.config}'`,
  ],
  [
    'source_records',
    `update smb.source_records set url = 'x' where id = '${ID.sourceRecord1}'`,
    `delete from smb.source_records where id = '${ID.sourceRecord1}'`,
  ],
  [
    'media_assets',
    `update smb.media_assets set sha256 = repeat('0', 64) where id = '${ID.assetOriginal}'`,
    `delete from smb.media_assets where id = '${ID.assetOriginal}'`,
  ],
  [
    'publications',
    `update smb.publications set content_hash = repeat('0', 64) where id = '${ID.publication}'`,
    `delete from smb.publications where id = '${ID.publication}'`,
  ],
];

describe('append-only history', () => {
  it.each(PROTECTED)('%s: protected data cannot be changed', async (_t, update) => {
    await expect(q(update)).rejects.toThrow(/append-only/);
  });

  it.each(PROTECTED)('%s: rows cannot be deleted', async (_t, _u, del) => {
    await expect(q(del)).rejects.toThrow(/append-only/);
  });
});

describe('the small set of allowed updates', () => {
  it('lets retention purge a raw source payload but keeps the hash', async () => {
    await q(
      `update smb.source_records set raw_payload = null, raw_purged_at = now() where id = '${ID.sourceRecord1}'`,
    );
    const { rows } = await q(
      `select payload_hash, raw_payload from smb.source_records where id = '${ID.sourceRecord1}'`,
    );
    expect(rows[0].raw_payload).toBeNull();
    expect(rows[0].payload_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('lets an asset be soft-deleted', async () => {
    await q(`update smb.media_assets set deleted_at = now() where id = '${ID.assetEvidence}'`);
  });

  it('lets a publication move through its status but not change identity', async () => {
    await q(`update smb.publications set last_error = 'timeout' where id = '${ID.publication}'`);
    await expect(
      q(`update smb.publications set channel = 'discord' where id = '${ID.publication}'`),
    ).rejects.toThrow(/append-only/);
  });

  it('lets the active config flag move', async () => {
    await q(`update smb.post_configs set is_active = false where id = '${ID.config}'`);
  });
});
