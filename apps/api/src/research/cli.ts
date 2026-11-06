import { parseArgs } from 'node:util';
import { loadConfigSet, syncConfigs, syncSources } from '../config/index.js';
import { getDb } from '../db/client.js';
import { PrismaSourceRecordStore, createSourceGateway } from '../sources/index.js';
import { notReadyReasons } from './assemble.js';
import { buildResearchPackage } from './package.js';
import type { PackageSummary } from '@smb/shared';

/**
 * Developer tool: build a research package by hand until the event monitor (1.16) creates opportunities.
 *   npm run research:build -w @smb/api -- --event <provider event id> [--game <provider game id>]
 *        [--source D3] [--phase tournament] [--post-type 1.1]
 * Needs DATABASE_URL (the SMB Supabase project). It creates a manual opportunity and prints the result.
 */
const { values } = parseArgs({
  options: {
    event: { type: 'string' },
    game: { type: 'string' },
    source: { type: 'string', default: 'D3' },
    phase: { type: 'string' },
    'post-type': { type: 'string', default: '1.1' },
  },
});

if (!values.event) {
  process.stderr.write(
    'usage: research:build --event <id> [--game <id>] [--source D3] [--phase <id>] [--post-type 1.1]\n',
  );
  process.exit(2);
}
if (!process.env.DATABASE_URL) {
  process.stderr.write('DATABASE_URL is not set\n');
  process.exit(2);
}

const set = loadConfigSet();
const db = await getDb();
await syncSources(db, set.sources, 'research-cli');
await syncConfigs(db, set, 'research-cli');

const postType = values['post-type']!;
const config = await db.post_configs.findFirstOrThrow({
  where: { post_type_id: postType, is_active: true },
});
const source = values.source!;
const trigger = {
  eventRefs: { [source]: values.event },
  ...(values.game ? { gameRef: { sourceId: source, externalId: values.game } } : {}),
};
const opportunity = await db.post_opportunities.create({
  data: {
    post_type_id: postType,
    post_config_id: config.id,
    dedupe_key: `manual:${postType}:${source}:${values.event}:${values.game ?? 'event'}:${Date.now()}`,
    trigger_kind: 'manual',
    trigger_ref: trigger,
    phase: values.phase ?? null,
  },
});

const gateway = createSourceGateway(set.sources, new PrismaSourceRecordStore(db));
const built = await buildResearchPackage({ db, gateway, registry: set.sources }, opportunity.id);
const pkg = await db.research_packages.findUniqueOrThrow({ where: { id: built.packageId } });
const claims = await db.research_claims.findMany({
  where: { package_id: built.packageId },
  orderBy: { claim_key: 'asc' },
});

process.stdout.write(
  `opportunity ${opportunity.id}\npackage ${built.packageId} v${built.version}: ${built.status}\n`,
);
for (const c of claims) {
  process.stdout.write(
    `  ${c.claim_key.padEnd(18)} ${c.verification.padEnd(14)} conf ${String(c.confidence)}\n`,
  );
}
const reasons = notReadyReasons(pkg.status, pkg.summary as unknown as PackageSummary);
process.stdout.write(
  reasons.length
    ? `NOT ready for generation:\n${reasons.map((r) => `  - ${r}`).join('\n')}\n`
    : 'Ready for generation.\n',
);
await db.$disconnect();
