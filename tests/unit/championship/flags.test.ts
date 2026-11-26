import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FLAG_RULES } from '@smb/shared';

const migration = (name: string) =>
  readFileSync(resolve(import.meta.dirname, '../../../supabase/migrations', name), 'utf8');

const kindsIn = (list: string) => [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!).sort();

describe('FLAG_RULES vs SQL check constraint', () => {
  it('matches every flag kind in the latest championship_flags kind constraint (1.16)', () => {
    const sql = migration('20261103002400_event_ingestion.sql');
    const match = sql.match(
      /add\s+constraint\s+championship_flags_kind_check\s+check\s*\(kind\s+in\s*\(([\s\S]*?)\)\)/i,
    );
    expect(match).toBeTruthy();
    expect(kindsIn(match![1]!)).toEqual(Object.keys(FLAG_RULES).sort());
  });

  it('the 1.16 constraint keeps every 1.15 kind', () => {
    const sql = migration('20261103002300_championship_lifecycle.sql');
    const match = sql.match(/kind\s+text\s+not\s+null\s+check\s*\(kind\s+in\s*\(([\s\S]*?)\)\)/i);
    expect(match).toBeTruthy();
    for (const kind of kindsIn(match![1]!)) expect(Object.keys(FLAG_RULES)).toContain(kind);
  });
});
