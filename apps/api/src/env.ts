import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');
const Deployment = z.enum(['development', 'staging', 'production']);

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  SMB_DEPLOYMENT: Deployment.default('development'),
  X_CREDENTIALS_DEPLOYMENT: Deployment.default('development'),
  SMB_TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(0),
  SMB_REQUIRE_HTTPS: bool.optional(),
  DATABASE_URL: z.string().optional(),
  DIRECT_URL: z.string().optional(),
  SUPABASE_URL: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  XLCHESS_JWT_ALG: z.enum(['HS256', 'RS256']).default('HS256'),
  XLCHESS_JWT_SECRET: z.string().optional(),
  XLCHESS_JWKS_URL: z.string().optional(),
  XLCHESS_JWT_ISSUER: z.string().optional(),
  XLCHESS_JWT_AUDIENCE: z.string().optional(),
  XLCHESS_JWT_USER_ID_CLAIM: z.string().default('sub'),
  /** How long an image link given to a reviewer works. */
  SMB_SIGNED_URL_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
  SMB_PUBLISH_MODE: z.enum(['dry_run', 'sandbox', 'live']).default('dry_run'),
  SMB_ALLOW_LIVE_PUBLISH: bool.default('false'),
  SMB_AI_PROVIDER: z.enum(['stub', 'worker']).default('stub'),
  SMB_WORKER_LEASE_SECONDS: z.coerce.number().int().min(60).max(3600).default(600),
  SMB_WORKER_POLL_SECONDS: z.coerce.number().int().min(2).max(300).default(10),
  SMB_WORKER_TARGET_VERSION: z.string().optional(),
  SMB_WORKER_LLM_MODEL: z.string().default('qwen3.5:9b'),
  SMB_WORKER_IMAGE_MODEL: z.string().default('z-image-turbo'),
  /** Appended to the User-Agent so providers such as Wikimedia can contact the operator. A URL or an address. */
  SMB_CONTACT: z.string().optional(),
  /** Accept CC BY-SA photos (decision of 2026-11-13). Set to false to reject them. */
  IMAGE_ALLOW_SHARE_ALIKE: bool.default('true'),
  /** Runs the orchestrator tick and the job runner (1.17): moves opportunities from research to review. Off by default. */
  SMB_WORKFLOW_ENABLED: bool.default('false'),
  SMB_WORKFLOW_TICK_SECONDS: z.coerce.number().int().min(5).max(600).default(15),
  /** Server-lane jobs run at once. The gpu lane is claimed by workers, or runs here with SMB_AI_PROVIDER=stub. */
  SMB_RUNNER_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
  /** Sends approved posts that are due (publishDue). Off by default. */
  SMB_PUBLISHER_ENABLED: bool.default('false'),
  SMB_PUBLISH_INTERVAL_SECONDS: z.coerce.number().int().min(10).max(3600).default(30),
  SMB_SCHEDULER_ENABLED: bool.default('false'),
  SMB_SCHEDULER_INTERVAL_SECONDS: z.coerce.number().int().min(10).max(3600).default(60),
  /** Runs the event detectors (1.16), including the World Championship feed sync. Off by default. */
  SMB_EVENTS_ENABLED: bool.optional(),
  /** How often the events loop checks which detectors are due. Each detector keeps its own cadence. */
  SMB_EVENTS_TICK_SECONDS: z.coerce.number().int().min(10).max(600).optional(),
  /** Two sources must agree on a game result for this long before it is corroborated (1.16 D7c). */
  SMB_EVENTS_STABILITY_SECONDS: z.coerce.number().int().min(0).max(3600).default(120),
  /** Deprecated in 1.16: use SMB_EVENTS_ENABLED. Still honoured when SMB_EVENTS_ENABLED is unset. */
  SMB_CHAMPIONSHIP_SYNC_ENABLED: bool.optional(),
  /** Deprecated in 1.16: use SMB_EVENTS_TICK_SECONDS. */
  SMB_CHAMPIONSHIP_SYNC_SECONDS: z.coerce.number().int().min(10).max(600).optional(),
  X_API_BASE_URL: z.string().url().default('https://api.x.com'),
  X_API_KEY: z.string().optional(), // OAuth 1.0a consumer key
  X_API_SECRET: z.string().optional(), // consumer secret
  X_ACCESS_TOKEN: z.string().optional(), // bot account's access token
  X_ACCESS_TOKEN_SECRET: z.string().optional(),
  X_USER_ID: z.string().regex(/^\d+$/).optional(), // numeric id of the bot account, for lookups
  X_USERNAME: z.string().optional(), // for building the post URL; falls back to /i/web/status/<id>
  X_HTTP_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(15000),
  X_RECONCILE_DELAY_SECONDS: z.coerce.number().int().min(5).max(3600).default(60),
  X_RECONCILE_MAX_LOOKUPS: z.coerce.number().int().min(1).max(50).default(5),
});

export type Env = Omit<z.infer<typeof EnvSchema>, 'SMB_REQUIRE_HTTPS'> & {
  SMB_REQUIRE_HTTPS: boolean;
};

export interface XCredentials {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessTokenSecret: string;
}

export function xCredentialsFromEnv(env: Env): XCredentials | undefined {
  if (!env.X_API_KEY || !env.X_API_SECRET || !env.X_ACCESS_TOKEN || !env.X_ACCESS_TOKEN_SECRET) {
    return undefined;
  }
  return {
    apiKey: env.X_API_KEY,
    apiSecret: env.X_API_SECRET,
    accessToken: env.X_ACCESS_TOKEN,
    accessTokenSecret: env.X_ACCESS_TOKEN_SECRET,
  };
}

function hasAnyXCredentials(
  env: Pick<Env, 'X_API_KEY' | 'X_API_SECRET' | 'X_ACCESS_TOKEN' | 'X_ACCESS_TOKEN_SECRET'>,
): boolean {
  return Boolean(
    env.X_API_KEY || env.X_API_SECRET || env.X_ACCESS_TOKEN || env.X_ACCESS_TOKEN_SECRET,
  );
}

function hasCompleteJwtSettings(env: Env): boolean {
  if (!env.XLCHESS_JWT_ISSUER || !env.XLCHESS_JWT_AUDIENCE) return false;
  if (env.XLCHESS_JWT_ALG === 'HS256') {
    return Boolean(env.XLCHESS_JWT_SECRET && env.XLCHESS_JWT_SECRET.length >= 32);
  }
  return Boolean(env.XLCHESS_JWKS_URL);
}

export interface EventsLoopSettings {
  enabled: boolean;
  tickSeconds: number;
  /** Deprecated variables that were used, for a startup warning. */
  deprecated: string[];
}

/** Events loop settings, honouring the 1.15 variable names when the 1.16 ones are unset. */
export function eventsLoopSettings(env: Env): EventsLoopSettings {
  const deprecated: string[] = [];
  let enabled = env.SMB_EVENTS_ENABLED;
  if (enabled === undefined && env.SMB_CHAMPIONSHIP_SYNC_ENABLED !== undefined) {
    enabled = env.SMB_CHAMPIONSHIP_SYNC_ENABLED;
    deprecated.push('SMB_CHAMPIONSHIP_SYNC_ENABLED');
  }
  let tickSeconds = env.SMB_EVENTS_TICK_SECONDS;
  if (tickSeconds === undefined && env.SMB_CHAMPIONSHIP_SYNC_SECONDS !== undefined) {
    tickSeconds = env.SMB_CHAMPIONSHIP_SYNC_SECONDS;
    deprecated.push('SMB_CHAMPIONSHIP_SYNC_SECONDS');
  }
  return { enabled: enabled ?? false, tickSeconds: tickSeconds ?? 30, deprecated };
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  // Treat empty strings (as left by .env.example) as unset.
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== ''));
  const parsed = EnvSchema.parse(cleaned);
  const env: Env = {
    ...parsed,
    SMB_REQUIRE_HTTPS: parsed.SMB_REQUIRE_HTTPS ?? parsed.SMB_DEPLOYMENT === 'production',
  };

  if (hasAnyXCredentials(env) && env.X_CREDENTIALS_DEPLOYMENT !== env.SMB_DEPLOYMENT) {
    throw new Error(
      `X credentials are labelled for ${env.X_CREDENTIALS_DEPLOYMENT} but this is ${env.SMB_DEPLOYMENT}`,
    );
  }
  if (env.SMB_DEPLOYMENT === 'production') {
    if (env.NODE_ENV !== 'production') {
      throw new Error('SMB_DEPLOYMENT=production requires NODE_ENV=production');
    }
    if (!hasCompleteJwtSettings(env)) {
      throw new Error(
        'SMB_DEPLOYMENT=production requires XLCHESS_JWT_ISSUER, XLCHESS_JWT_AUDIENCE, and either XLCHESS_JWT_SECRET (at least 32 characters) for HS256 or XLCHESS_JWKS_URL for RS256',
      );
    }
    if (env.SMB_AI_PROVIDER !== 'worker') {
      throw new Error('SMB_DEPLOYMENT=production requires SMB_AI_PROVIDER=worker');
    }
    if (!env.DATABASE_URL || !env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error(
        'SMB_DEPLOYMENT=production requires DATABASE_URL, SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY',
      );
    }
  }
  if (env.SMB_PUBLISH_MODE === 'live' && !env.SMB_ALLOW_LIVE_PUBLISH) {
    throw new Error('SMB_PUBLISH_MODE=live requires SMB_ALLOW_LIVE_PUBLISH=true');
  }
  if (env.SMB_PUBLISH_MODE === 'sandbox' || env.SMB_PUBLISH_MODE === 'live') {
    if (
      !env.X_API_KEY ||
      !env.X_API_SECRET ||
      !env.X_ACCESS_TOKEN ||
      !env.X_ACCESS_TOKEN_SECRET ||
      !env.X_USER_ID
    ) {
      throw new Error(
        `SMB_PUBLISH_MODE=${env.SMB_PUBLISH_MODE} needs X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET and X_USER_ID`,
      );
    }
  }
  return env;
}
