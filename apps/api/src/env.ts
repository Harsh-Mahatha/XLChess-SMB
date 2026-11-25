import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
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
  /** Appended to the User-Agent so providers such as Wikimedia can contact the operator. A URL or an address. */
  SMB_CONTACT: z.string().optional(),
  /** Accept CC BY-SA photos (decision of 2026-11-13). Set to false to reject them. */
  IMAGE_ALLOW_SHARE_ALIKE: bool.default('true'),
  SMB_SCHEDULER_ENABLED: bool.default('false'),
  SMB_SCHEDULER_INTERVAL_SECONDS: z.coerce.number().int().min(10).max(3600).default(60),
  SMB_CHAMPIONSHIP_SYNC_ENABLED: bool.default('false'),
  SMB_CHAMPIONSHIP_SYNC_SECONDS: z.coerce.number().int().min(15).max(600).default(60),
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

export type Env = z.infer<typeof EnvSchema>;

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

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  // Treat empty strings (as left by .env.example) as unset.
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== ''));
  const env = EnvSchema.parse(cleaned);
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
