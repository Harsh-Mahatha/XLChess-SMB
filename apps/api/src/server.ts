import { createApp } from './app.js';
import { verifierFromEnv } from './auth/index.js';
import { loadConfigSet, syncConfigs, syncSources } from './config/index.js';
import { getDb } from './db/client.js';
import { eventsLoopSettings, loadEnv, xCredentialsFromEnv } from './env.js';
import { createLogger } from './logger.js';
import { SupabaseObjectStore } from './storage/index.js';
import { XClient, XPublisher, effectivePublishMode, type PublishDeps } from './publishing/index.js';
import { ContextResolvers, runSchedulerTick, startLoop } from './scheduling/index.js';
import { championshipDetector, championshipResolver } from './championship/index.js';
import { DetectorRegistry, runEventPoll } from './events/index.js';
import { PrismaSourceRecordStore, createSourceGateway } from './sources/index.js';
import {
  createWorkflowDeps,
  renderForRevision,
  runAvailableJobs,
  runWorkflowTick,
} from './workflow/index.js';
import { publishDue } from './publishing/index.js';
import { createAlertWatcher, runAlertCheck, type MetricsConfig } from './metrics/index.js';
import type { MetricsRouteDeps } from './http/routes/metrics.js';
import type { AdminRouteDeps } from './http/routes/admin.js';
import type { WorkflowRouteDeps } from './http/routes/workflow.js';
import type { WorkerRouteDeps } from './http/routes/worker.js';
import type { ChampionshipRouteDeps } from './http/routes/championships.js';
import type { EventsRouteDeps } from './http/routes/events.js';

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
let scheduling;
let championships: ChampionshipRouteDeps | undefined;
let events: EventsRouteDeps | undefined;
let schedulerLoop: { stop(): void } | undefined;
let eventsLoop: { stop(): void } | undefined;
let workflowRoutes: WorkflowRouteDeps | undefined;
let metricsRoutes: MetricsRouteDeps | undefined;
let workerRoutes: WorkerRouteDeps | undefined;
let adminRoutes: AdminRouteDeps | undefined;
let startupEffectiveMode = env.SMB_PUBLISH_MODE;
const stoppers: { stop(): void }[] = [];
if (env.DATABASE_URL && env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
  const db = await getDb();
  const modeOf = () => effectivePublishMode(db, env);
  startupEffectiveMode = await modeOf();
  const store = new SupabaseObjectStore({
    url: env.SUPABASE_URL,
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
  });
  const verifier = verifierFromEnv(env);
  if (!verifier) logger.warn('XLChess token settings are incomplete: reviewer routes answer 503');

  const sourceGateway = createSourceGateway(configSet.sources, new PrismaSourceRecordStore(db));
  // The workflow (1.17). With SMB_AI_PROVIDER=stub the gpu lane runs here; with `worker` it waits for paired PCs (1.18).
  const workflowDeps = createWorkflowDeps({
    db,
    store,
    configSet,
    env,
    logger,
    gateway: sourceGateway,
  });
  workflowRoutes = { verifier, db };
  const metricsConfig: MetricsConfig = {
    timezone: env.SMB_KPI_TIMEZONE,
    requiredDailyVolume: env.SMB_KPI_REQUIRED_DAILY_VOLUME,
    thresholds: {
      workerOfflineMinutes: env.SMB_ALERT_WORKER_OFFLINE_MINUTES,
      pollerFailures: env.SMB_ALERT_POLLER_FAILURES,
      reviewWaitHours: env.SMB_ALERT_REVIEW_WAIT_HOURS,
    },
  };
  metricsRoutes = { verifier, db, config: metricsConfig };
  workerRoutes = { db, workflow: workflowDeps, env, logger };
  adminRoutes = { verifier, db, configSet, env };
  review = {
    verifier,
    read: { db, store, channels: configSet.channels, signedUrlSeconds: env.SMB_SIGNED_URL_SECONDS },
    act: {
      db,
      store,
      channels: configSet.channels,
      publishMode: env.SMB_PUBLISH_MODE,
      publishModeOf: modeOf,
      // An edit that changes a graphic's words gets a new graphic straight away (1.17).
      rerender: async (candidateId: string, revisionId: string) => {
        const r = await renderForRevision(workflowDeps, candidateId, revisionId);
        if (!r.rendered) throw new Error(r.reason ?? 'the graphic could not be made');
      },
    },
  };
  publishing = {
    db,
    store,
    channels: configSet.channels,
    env,
    modeOf,
    publishers: { x: xPublisher },
    logger,
  };
  // 1.17: the orchestrator tick, the job runner and the publisher. Every pass is safe to repeat and to run from
  // two instances at once (advisory lock, SKIP LOCKED claims), and a crashed pass is simply run again.
  if (env.SMB_WORKFLOW_ENABLED) {
    stoppers.push(
      startLoop({
        name: 'workflow',
        intervalMs: env.SMB_WORKFLOW_TICK_SECONDS * 1000,
        run: () => runWorkflowTick(workflowDeps),
        logger,
      }),
      startLoop({
        name: 'job-runner',
        intervalMs: 5000,
        run: () => runAvailableJobs(workflowDeps, { concurrency: env.SMB_RUNNER_CONCURRENCY }),
        logger,
      }),
    );
  }
  // 1.19: log a line when a problem opens and when it clears (a worker gone, dead jobs, an uncertain post, ...).
  if (env.SMB_WORKFLOW_ENABLED) {
    const watch = createAlertWatcher(logger);
    stoppers.push(
      startLoop({
        name: 'alerts',
        intervalMs: env.SMB_ALERT_INTERVAL_SECONDS * 1000,
        run: async () => {
          await runAlertCheck(db, metricsConfig.thresholds, watch);
        },
        logger,
      }),
    );
  }
  if (env.SMB_PUBLISHER_ENABLED) {
    stoppers.push(
      startLoop({
        name: 'publisher',
        intervalMs: env.SMB_PUBLISH_INTERVAL_SECONDS * 1000,
        run: () => publishDue(publishing!, { limit: 10 }),
        logger,
      }),
    );
  }

  const resolvers = new ContextResolvers();
  resolvers.register('1.1', championshipResolver(db));

  if (env.SMB_SCHEDULER_ENABLED) {
    schedulerLoop = startLoop({
      name: 'scheduler',
      intervalMs: env.SMB_SCHEDULER_INTERVAL_SECONDS * 1000,
      run: () => runSchedulerTick({ db, resolvers, logger }),
      logger,
    });
  }
  // 1.16: every event detector runs from one loop; each keeps its own cadence and backoff.
  const detectors = new DetectorRegistry().register(
    championshipDetector({
      db,
      gateway: sourceGateway,
      registry: configSet.sources,
      resolvers,
      logger,
      stabilitySeconds: env.SMB_EVENTS_STABILITY_SECONDS,
    }),
  );
  const eventsSettings = eventsLoopSettings(env);
  if (eventsSettings.deprecated.length > 0) {
    logger.warn(
      { deprecated: eventsSettings.deprecated },
      'Deprecated environment variables in use: rename to SMB_EVENTS_ENABLED / SMB_EVENTS_TICK_SECONDS',
    );
  }
  if (eventsSettings.enabled) {
    eventsLoop = startLoop({
      name: 'events',
      intervalMs: eventsSettings.tickSeconds * 1000,
      run: () => runEventPoll({ db, detectors, logger }),
      logger,
    });
  }
  scheduling = {
    verifier,
    db,
    resolvers,
    logger,
  };
  championships = {
    verifier,
    db,
    gateway: sourceGateway,
    registry: configSet.sources,
    resolvers,
    detectors,
    logger,
  };
  events = { verifier, db, detectors, logger };
} else {
  logger.warn(
    'DATABASE_URL or Supabase settings missing: reviewer and publishing routes are not mounted',
  );
}

const app = createApp({
  env,
  logger,
  review,
  publishing,
  scheduling,
  championships,
  events,
  workflow: workflowRoutes,
  metrics: metricsRoutes,
  worker: workerRoutes,
  admin: adminRoutes,
});

const server = app.listen(env.PORT, () => {
  logger.info(
    {
      port: env.PORT,
      deployment: env.SMB_DEPLOYMENT,
      publishModeCeiling: env.SMB_PUBLISH_MODE,
      effectivePublishMode: startupEffectiveMode,
      xCredentialsConfigured: Boolean(xCreds),
      xApiBaseHost: xBaseUrl.hostname,
    },
    'smb-api listening',
  );
});

function shutdown(signal: string): void {
  logger.info({ signal }, 'shutting down');
  if (schedulerLoop) {
    schedulerLoop.stop();
  }
  if (eventsLoop) {
    eventsLoop.stop();
  }
  for (const s of stoppers) s.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
