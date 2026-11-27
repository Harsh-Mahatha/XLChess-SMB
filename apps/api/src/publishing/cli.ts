/* eslint-disable no-console -- command-line tool */
import { parseArgs } from 'node:util';
import { getDb } from '../db/client.js';
import { loadEnv, xCredentialsFromEnv } from '../env.js';
import { createLogger } from '../logger.js';
import { loadConfigSet } from '../config/loader.js';
import { InMemoryObjectStore, SupabaseObjectStore, type ObjectStore } from '../storage/index.js';
import { XClient } from './x/client.js';
import { XPublisher } from './x/adapter.js';
import { effectivePublishMode } from './mode.js';
import { publishDue, publishPublication, reconcilePublication } from './service.js';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    limit: { type: 'string', default: '10' },
    publication: { type: 'string' },
    reconcile: { type: 'boolean', default: false },
  },
});

const command = positionals[0] ?? 'due';
const env = loadEnv();
console.log(`Mode: ${env.SMB_PUBLISH_MODE}`);

const db = await getDb();
const configSet = await loadConfigSet();
const logger = createLogger(env);

const store: ObjectStore =
  env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY
    ? new SupabaseObjectStore({
        url: env.SUPABASE_URL,
        serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
      })
    : new InMemoryObjectStore();

const creds = xCredentialsFromEnv(env);
let xPublisher: XPublisher | undefined;
if (creds && env.X_USER_ID) {
  const client = new XClient({
    baseUrl: env.X_API_BASE_URL,
    creds,
    timeoutMs: env.X_HTTP_TIMEOUT_MS,
  });
  xPublisher = new XPublisher({
    client,
    userId: env.X_USER_ID,
    username: env.X_USERNAME,
  });
}

const deps = {
  db,
  store,
  channels: configSet.channels,
  env,
  modeOf: () => effectivePublishMode(db, env),
  publishers: { x: xPublisher },
  logger,
};

if (command === 'due') {
  const limit = parseInt(values.limit ?? '10', 10);
  const outcomes = await publishDue(deps, { limit });
  if (outcomes.length === 0) {
    console.log('No publications were due.');
  } else {
    console.table(
      outcomes.map((o) => ({
        id: o.publicationId,
        channel: o.channel ?? '-',
        mode: o.mode ?? env.SMB_PUBLISH_MODE,
        status: o.status,
        outcome: o.outcome ?? o.skipped ?? '-',
        info: o.url ?? o.error ?? '-',
      })),
    );
  }
} else if (command === 'one') {
  const pubId = values.publication;
  if (!pubId) {
    console.error('--publication <id> is required');
    process.exit(1);
  }

  const outcome = values.reconcile
    ? await reconcilePublication(deps, pubId)
    : await publishPublication(deps, pubId);

  console.table([
    {
      id: outcome.publicationId,
      channel: outcome.channel ?? '-',
      mode: outcome.mode ?? env.SMB_PUBLISH_MODE,
      status: outcome.status,
      outcome: outcome.outcome ?? outcome.skipped ?? '-',
      info: outcome.url ?? outcome.error ?? '-',
    },
  ]);
} else {
  console.error(`Unknown command: ${command}. Use 'due' or 'one'`);
  process.exit(1);
}
