import { createApp } from './app.js';
import { verifierFromEnv } from './auth/index.js';
import { loadConfigSet, syncConfigs, syncSources } from './config/index.js';
import { getDb } from './db/client.js';
import { loadEnv } from './env.js';
import { createLogger } from './logger.js';
import { SupabaseObjectStore } from './storage/index.js';

const env = loadEnv();
const logger = createLogger(env);

// Refuse to start on invalid configuration; keep the database in step with the config files.
let configSet;
try {
  configSet = loadConfigSet();
} catch (err) {
  logger.fatal({ err }, err instanceof Error ? err.message : 'invalid configuration');
  process.exit(1);
}
if (env.DATABASE_URL) {
  const results = await syncConfigs(await getDb(), configSet);
  logger.info({ results }, 'post-type configs synced');
  const sourceResults = await syncSources(await getDb(), configSet.sources);
  logger.info({ sourceResults }, 'source registry synced');
}

// The reviewer API needs the database and Storage. Without them the server still starts (health only).
let review;
if (env.DATABASE_URL && env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
  const db = await getDb();
  const store = new SupabaseObjectStore({
    url: env.SUPABASE_URL,
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
  });
  const verifier = verifierFromEnv(env);
  if (!verifier) logger.warn('XLChess token settings are incomplete: reviewer routes answer 503');
  review = {
    verifier,
    read: { db, store, channels: configSet.channels, signedUrlSeconds: env.SMB_SIGNED_URL_SECONDS },
    act: { db, store, channels: configSet.channels, publishMode: env.SMB_PUBLISH_MODE },
  };
} else {
  logger.warn('DATABASE_URL or Supabase settings missing: reviewer routes are not mounted');
}

const app = createApp({ env, logger, review });

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, publishMode: env.SMB_PUBLISH_MODE }, 'smb-api listening');
});

function shutdown(signal: string): void {
  logger.info({ signal }, 'shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
