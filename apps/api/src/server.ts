import { createApp } from './app.js';
import { verifierFromEnv } from './auth/index.js';
import { loadConfigSet, syncConfigs, syncSources } from './config/index.js';
import { getDb } from './db/client.js';
import { loadEnv, xCredentialsFromEnv } from './env.js';
import { createLogger } from './logger.js';
import { SupabaseObjectStore } from './storage/index.js';
import { XClient, XPublisher, type PublishDeps } from './publishing/index.js';

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

// Check host and initialize X publisher if configured
const xCreds = xCredentialsFromEnv(env);
const xBaseUrl = new URL(env.X_API_BASE_URL);
if (
  (env.SMB_PUBLISH_MODE === 'sandbox' || env.SMB_PUBLISH_MODE === 'live') &&
  env.NODE_ENV === 'production' &&
  xBaseUrl.hostname !== 'api.x.com'
) {
  logger.fatal(
    { host: xBaseUrl.hostname },
    'X_API_BASE_URL host must be api.x.com in production for sandbox or live mode',
  );
  process.exit(1);
}

let xPublisher: XPublisher | undefined;
if (xCreds && env.X_USER_ID) {
  const xClient = new XClient({
    baseUrl: env.X_API_BASE_URL,
    creds: xCreds,
    timeoutMs: env.X_HTTP_TIMEOUT_MS,
  });
  xPublisher = new XPublisher({
    client: xClient,
    userId: env.X_USER_ID,
    username: env.X_USERNAME,
  });
}

// The reviewer and publishing APIs need the database and Storage. Without them the server still starts (health only).
let review;
let publishing: PublishDeps | undefined;
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
  publishing = {
    db,
    store,
    channels: configSet.channels,
    env,
    publishers: { x: xPublisher },
    logger,
  };
  // 1.17: schedule publishDue(publishing, { limit: 10 });
} else {
  logger.warn(
    'DATABASE_URL or Supabase settings missing: reviewer and publishing routes are not mounted',
  );
}

const app = createApp({ env, logger, review, publishing });

const server = app.listen(env.PORT, () => {
  logger.info(
    {
      port: env.PORT,
      publishMode: env.SMB_PUBLISH_MODE,
      xCredentialsConfigured: Boolean(xCreds),
      xApiBaseHost: xBaseUrl.hostname,
    },
    'smb-api listening',
  );
});

function shutdown(signal: string): void {
  logger.info({ signal }, 'shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
