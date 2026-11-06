import { createApp } from './app.js';
import { loadConfigSet, syncConfigs, syncSources } from './config/index.js';
import { getDb } from './db/client.js';
import { loadEnv } from './env.js';
import { createLogger } from './logger.js';

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

const app = createApp({ env, logger });

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
