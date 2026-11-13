import { parseArgs } from 'node:util';
import { getDb } from '../db/client.js';
import { loadEnv } from '../env.js';
import { InMemoryObjectStore, SupabaseObjectStore, type ObjectStore } from '../storage/index.js';
import { purgeExpiredAssets } from './purge.js';
import { verifyAsset } from './verify.js';

/**
 * Developer and operations tool for stored media (module 1.9).
 *   npm run assets:verify -- --asset <id>        check one original or derived image
 *   npm run assets:verify -- --opportunity <id>  check every original and derived image of an opportunity
 *   npm run assets:verify -- --all               check everything not deleted
 *   npm run assets:purge [-- --dry-run]          apply retention and remove expired files from Storage
 * Needs DATABASE_URL, and SUPABASE_URL plus SUPABASE_SERVICE_ROLE_KEY for the default Supabase store.
 * Exit code 1 means a check failed (verify) or a removal failed (purge).
 */
const [command, ...rest] = process.argv.slice(2);
const { values } = parseArgs({
  args: rest,
  options: {
    asset: { type: 'string' },
    opportunity: { type: 'string' },
    all: { type: 'boolean', default: false },
    store: { type: 'string', default: 'supabase' },
    'dry-run': { type: 'boolean', default: false },
  },
});

const usage = (): never => {
  process.stderr.write(
    'usage: assets verify (--asset <id> | --opportunity <id> | --all) [--store supabase|memory]\n' +
      '       assets purge [--dry-run] [--store supabase|memory]\n',
  );
  process.exit(2);
};

if (command !== 'verify' && command !== 'purge') usage();
if (!process.env.DATABASE_URL) {
  process.stderr.write('DATABASE_URL is not set\n');
  process.exit(2);
}

const env = loadEnv();
let store: ObjectStore;
if (values.store === 'memory') {
  store = new InMemoryObjectStore();
} else if (values.store === 'supabase') {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    process.stderr.write(
      'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are needed for --store supabase\n',
    );
    process.exit(2);
  }
  store = new SupabaseObjectStore({
    url: env.SUPABASE_URL,
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
  });
} else {
  process.stderr.write(`unknown store "${values.store}" (use supabase or memory)\n`);
  process.exit(2);
}

const db = await getDb();
const deps = { db, store };
let failed = false;

if (command === 'verify') {
  if (!values.asset && !values.opportunity && !values.all) usage();
  const assets = await db.media_assets.findMany({
    where: {
      kind: { in: ['original', 'derived'] },
      deleted_at: null,
      ...(values.asset ? { id: values.asset } : {}),
      ...(values.opportunity ? { opportunity_id: values.opportunity } : {}),
    },
    // Originals first, so a derived image is judged against an already-checked parent.
    orderBy: [{ kind: 'asc' }, { created_at: 'asc' }],
  });
  if (assets.length === 0) process.stdout.write('no matching assets\n');
  for (const a of assets) {
    const r = await verifyAsset(deps, a.id);
    if (!r.passed) failed = true;
    process.stdout.write(
      `${r.passed ? 'ok  ' : 'FAIL'} ${a.kind.padEnd(8)} ${a.bucket}/${a.path}` +
        `${r.passed ? '' : `  ${r.failures.join(', ')}`}\n`,
    );
  }
} else if (values['dry-run']) {
  const pending = await db.media_assets.count({
    where: { deleted_at: { not: null }, purged_at: null },
  });
  process.stdout.write(
    `${pending} deleted asset(s) still have files; run without --dry-run to apply retention and remove them\n`,
  );
} else {
  const r = await purgeExpiredAssets(deps);
  process.stdout.write(
    `retention: ${r.retention.map((x) => `${x.subject}=${x.affected}`).join(' ')}\n` +
      `files removed: ${r.removed}, already gone: ${r.alreadyGone}, protected and skipped: ${r.skippedProtected.length}\n`,
  );
  for (const f of r.failed) process.stderr.write(`could not remove ${f.assetId}: ${f.error}\n`);
  failed = r.failed.length > 0;
}

await db.$disconnect();
process.exit(failed ? 1 : 0);
