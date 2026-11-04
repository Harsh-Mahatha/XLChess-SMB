import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { inject } from 'vitest';

const root = join(import.meta.dirname, '../../..');
const migrationsDir = join(root, 'supabase', 'migrations');

/** Fixed ids from supabase/seed.sql. */
export const ID = {
  postType: '1.1',
  config: '00000000-0000-4000-8000-000000000101',
  sourceRecord1: '00000000-0000-4000-8000-000000000201',
  job: '00000000-0000-4000-8000-000000000301',
  opportunity: '00000000-0000-4000-8000-000000000401',
  package: '00000000-0000-4000-8000-000000000501',
  claimResult: '00000000-0000-4000-8000-000000000601',
  claimDiff: '00000000-0000-4000-8000-000000000602',
  assetEvidence: '00000000-0000-4000-8000-000000000701',
  assetOriginal: '00000000-0000-4000-8000-000000000702',
  assetDerived: '00000000-0000-4000-8000-000000000703',
  assetRender: '00000000-0000-4000-8000-000000000704',
  licence: '00000000-0000-4000-8000-000000000801',
  candidateA: '00000000-0000-4000-8000-000000000901',
  candidateB: '00000000-0000-4000-8000-000000000902',
  revision1: '00000000-0000-4000-8000-000000000a01',
  revision2: '00000000-0000-4000-8000-000000000a02',
  approval: '00000000-0000-4000-8000-000000000b01',
  publication: '00000000-0000-4000-8000-000000000c01',
} as const;

export const hex = (c: string) => c.repeat(64);

/** Connects, rebuilds the `smb` schema from the migrations, and loads the seed. */
export async function freshDb(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: inject('dbUrl') });
  await client.connect();
  await client.query('drop schema if exists smb cascade');
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const f of files) {
    await client.query(readFileSync(join(migrationsDir, f), 'utf8'));
  }
  await client.query(readFileSync(join(root, 'supabase', 'seed.sql'), 'utf8'));
  return client;
}

export async function rows<T = Record<string, unknown>>(
  client: pg.Client,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  return (await client.query(sql, params)).rows as T[];
}
