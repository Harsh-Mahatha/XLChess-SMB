import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshDb, ID, rows } from './harness.js';

let db: pg.Client;
beforeAll(async () => {
  db = await freshDb();
});
afterAll(async () => {
  await db.end();
});

interface Provenance {
  publication_id: string;
  approval_id: string;
  reviewer_id: string;
  approved_at: Date;
  approved_hash: string;
  published_hash: string;
  revision_id: string;
  revision_no: number;
  author_kind: string;
  author_id: string;
  candidate_id: string;
  prompt_version: string;
  provider: string;
  generation_job_id: string;
  opportunity_id: string;
  dedupe_key: string;
  post_config_id: string;
  config_version: number;
  config_hash: string;
  research_package_id: string;
  claims: {
    claim_key: string;
    computed: boolean;
    computation: string | null;
    verification: string;
    sources: { url: string; source_id: string; retrieved_at: string; payload_hash: string }[];
  }[];
  assets: {
    kind: string;
    sha256: string;
    original_asset_id: string;
    original_source_url: string;
    licences: {
      decision: string;
      licence_type: string;
      evidence_asset_id: string;
      verified_at: string;
    }[];
  }[];
  history: { from: string | null; to: string; actor: string; at: string }[];
}

describe('publication_provenance', () => {
  it('traces a publication back to approval, revision, generation, config, sources and licence', async () => {
    const [p] = await rows<Provenance>(db, 'select * from smb.publication_provenance');
    expect(p).toBeDefined();

    // approval -> revision -> candidate -> opportunity
    expect(p.publication_id).toBe(ID.publication);
    expect(p.approval_id).toBe(ID.approval);
    expect(p.reviewer_id).toBe('xlchess-user-2');
    expect(p.approved_at).toBeInstanceOf(Date);
    expect(p.revision_id).toBe(ID.revision2);
    expect(p.revision_no).toBe(2);
    expect(p.author_kind).toBe('human');
    expect(p.author_id).toBe('xlchess-user-1');
    expect(p.candidate_id).toBe(ID.candidateB);
    expect(p.opportunity_id).toBe(ID.opportunity);
    expect(p.dedupe_key).toBe('1.1:wcc-2026:game-7');

    // the approved text is exactly what was published
    expect(p.approved_hash).toBe(p.published_hash);

    // generation: prompt, provider, job
    expect(p.prompt_version).toBe('game-result-prompt@1');
    expect(p.provider).toBe('stub');
    expect(p.generation_job_id).toBe(ID.job);

    // exact config version
    expect(p.post_config_id).toBe(ID.config);
    expect(p.config_version).toBe(1);
    expect(p.config_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(p.research_package_id).toBe(ID.package);

    // claims with source URL, retrieval time and hash
    expect(p.claims.map((c) => c.claim_key)).toEqual(['game7.result', 'match.score_diff']);
    const result = p.claims[0];
    expect(result.verification).toBe('verified');
    expect(result.sources.map((s) => s.url)).toEqual([
      'https://example.org/wcc/game-7',
      'https://example.org/standings',
    ]);
    for (const s of result.sources) {
      expect(s.retrieved_at).toBeTruthy();
      expect(s.payload_hash).toMatch(/^[0-9a-f]{64}$/);
    }
    const diff = p.claims[1];
    expect(diff.computed).toBe(true);
    expect(diff.computation).toBe('player_a_score - player_b_score');

    // asset -> original photo -> licence -> saved evidence
    expect(p.assets).toHaveLength(1);
    const asset = p.assets[0];
    expect(asset.kind).toBe('render');
    expect(asset.original_asset_id).toBe(ID.assetOriginal);
    expect(asset.original_source_url).toBe('https://example.org/photo.jpg');
    expect(asset.licences).toHaveLength(1);
    expect(asset.licences[0]).toMatchObject({
      decision: 'accepted',
      licence_type: 'CC BY',
      evidence_asset_id: ID.assetEvidence,
    });

    // status history, from creation to approval
    expect(p.history.map((h) => [h.from, h.to])).toEqual([
      [null, 'pending'],
      ['pending', 'researching'],
      ['researching', 'generating'],
      ['generating', 'awaiting_review'],
      ['awaiting_review', 'approved'],
    ]);
  });

  it('has exactly one provenance row per publication (no join drops a publication)', async () => {
    const [{ pubs }] = await rows<{ pubs: string }>(
      db,
      'select count(*) pubs from smb.publications',
    );
    const [{ prov }] = await rows<{ prov: string }>(
      db,
      'select count(*) prov from smb.publication_provenance',
    );
    expect(prov).toBe(pubs);
  });

  it('records the actor and reason on status changes', async () => {
    await db.query('begin');
    await db.query(
      "select set_config('smb.actor', 'xlchess-user-9', true), set_config('smb.reason', 'ready', true)",
    );
    await db.query("update smb.post_opportunities set status = 'scheduled' where id = $1", [
      ID.opportunity,
    ]);
    await db.query('commit');
    const [last] = await rows<{ actor: string; reason: string; to_status: string }>(
      db,
      'select actor, reason, to_status from smb.opportunity_events order by seq desc limit 1',
    );
    expect(last).toEqual({ actor: 'xlchess-user-9', reason: 'ready', to_status: 'scheduled' });
  });

  it('has a created_at timestamp on every history table', async () => {
    const tables = [
      'post_types',
      'post_configs',
      'data_sources',
      'source_records',
      'post_opportunities',
      'opportunity_events',
      'research_packages',
      'research_claims',
      'post_candidates',
      'post_revisions',
      'media_assets',
      'media_licenses',
      'review_actions',
      'publications',
      'jobs',
      'post_metrics',
      'audit_log',
    ];
    const cols = await rows<{ table_name: string }>(
      db,
      "select table_name from information_schema.columns where table_schema = 'smb' and column_name = 'created_at' and table_name = any($1)",
      [tables],
    );
    expect(cols.map((c) => c.table_name).sort()).toEqual([...tables].sort());
  });
});
