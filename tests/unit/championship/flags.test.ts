import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FLAG_RULES } from '@smb/shared';

describe('FLAG_RULES vs SQL check constraint', () => {
  it('matches every flag kind in 20261103002300_championship_lifecycle.sql', () => {
    const sqlPath = resolve(
      import.meta.dirname,
      '../../../supabase/migrations/20261103002300_championship_lifecycle.sql',
    );
    const sql = readFileSync(sqlPath, 'utf8');
    const match = sql.match(/kind\s+text\s+not\s+null\s+check\s*\(kind\s+in\s*\(([\s\S]*?)\)\)/i);
    expect(match).toBeTruthy();

    const sqlKinds = [...match![1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!).sort();
    expect(sqlKinds).toEqual(Object.keys(FLAG_RULES).sort());
  });
});
