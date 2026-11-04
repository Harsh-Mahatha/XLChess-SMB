import type pg from 'pg';
import type { ZodEnum } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AssetKind,
  Channel,
  ClaimVerification,
  JobLane,
  JobStatus,
  LicenceDecision,
  OpportunityStatus,
  PublicationStatus,
  PublishMode,
  ReviewActionType,
} from '../../../packages/shared/src/index.js';
import { freshDb, rows } from './harness.js';

let db: pg.Client;
beforeAll(async () => {
  db = await freshDb();
});
afterAll(async () => {
  await db.end();
});

const PAIRS: [string, ZodEnum<[string, ...string[]]>][] = [
  ['opportunity_status', OpportunityStatus],
  ['job_status', JobStatus],
  ['job_lane', JobLane],
  ['channel', Channel],
  ['publish_mode', PublishMode],
  ['publication_status', PublicationStatus],
  ['review_action_type', ReviewActionType],
  ['claim_verification', ClaimVerification],
  ['asset_kind', AssetKind],
  ['licence_decision', LicenceDecision],
];

describe('database enums match @smb/shared', () => {
  it.each(PAIRS)('smb.%s', async (name, zod) => {
    const labels = await rows<{ enumlabel: string }>(
      db,
      `select e.enumlabel from pg_enum e
         join pg_type t on t.oid = e.enumtypid
         join pg_namespace n on n.oid = t.typnamespace
        where n.nspname = 'smb' and t.typname = $1
        order by e.enumsortorder`,
      [name],
    );
    expect(labels.map((l) => l.enumlabel)).toEqual([...zod.options]);
  });

  it('covers every enum in the schema', async () => {
    const all = await rows<{ typname: string }>(
      db,
      "select t.typname from pg_type t join pg_namespace n on n.oid = t.typnamespace where n.nspname = 'smb' and t.typtype = 'e'",
    );
    expect(all.map((t) => t.typname).sort()).toEqual(PAIRS.map(([n]) => n).sort());
  });
});
