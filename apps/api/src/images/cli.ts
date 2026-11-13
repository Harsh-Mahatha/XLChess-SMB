import { parseArgs } from 'node:util';
import { loadConfigSet } from '../config/index.js';
import { getDb } from '../db/client.js';
import { loadEnv } from '../env.js';
import { USER_AGENT } from '../sources/index.js';
import { InMemoryObjectStore, SupabaseObjectStore, type ObjectStore } from '../storage/index.js';
import { HttpImageDownloader } from './download.js';
import { discoverImages } from './discover.js';
import { createImageRuntimes } from './registry.js';

/**
 * Developer tool: find and licence photos for an opportunity that is generating.
 *   npm run images:discover -- --opportunity <id> [--store supabase|memory] [--reject-share-alike]
 * Needs DATABASE_URL. The default store is Supabase Storage (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY).
 * `--store memory` keeps files in memory only: the database rows then point at files that do not exist,
 * so use it against a throwaway database.
 */
const { values } = parseArgs({
  options: {
    opportunity: { type: 'string' },
    store: { type: 'string', default: 'supabase' },
    'reject-share-alike': { type: 'boolean', default: false },
  },
});

if (!values.opportunity) {
  process.stderr.write(
    'usage: images:discover --opportunity <id> [--store supabase|memory] [--reject-share-alike]\n',
  );
  process.exit(2);
}
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

const userAgent = env.SMB_CONTACT ? `${USER_AGENT} ${env.SMB_CONTACT}` : USER_AGENT;
const runtimes = createImageRuntimes(loadConfigSet().sources, { userAgent });
const db = await getDb();
const out = await discoverImages(
  {
    db,
    runtimes,
    store,
    downloader: new HttpImageDownloader({ userAgent }),
    allowShareAlike: values['reject-share-alike'] ? false : env.IMAGE_ALLOW_SHARE_ALIKE,
  },
  values.opportunity,
);

process.stdout.write(
  `${out.created ? 'stored' : 'already stored'}: ${out.status}; ${out.considered} considered, ${out.rejected} rejected on licence\n`,
);
for (const c of out.chosen) {
  process.stdout.write(
    `\n[${c.subject.role}] ${c.title} (${c.width}x${c.height}, score ${c.score})\n  ${c.licence}${c.shareAlike ? ' (share-alike)' : ''}\n  ${c.attributionText}\n  ${c.sourcePageUrl}\n`,
  );
}
if (out.needsHuman)
  process.stdout.write('\nA photo is required and none could be licensed: needs a person.\n');
for (const s of out.skipped) process.stdout.write(`- skipped: ${s}\n`);
for (const e of out.errors) process.stdout.write(`! ${e}\n`);
const rejected = await db.image_candidates.findMany({
  where: { opportunity_id: values.opportunity, decision: 'rejected' },
  select: { title: true, rejection_codes: true },
  take: 20,
});
for (const r of rejected) process.stdout.write(`x ${r.title}: ${r.rejection_codes.join(', ')}\n`);
await db.$disconnect();
