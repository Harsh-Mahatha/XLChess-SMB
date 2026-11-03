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
  SMB_PUBLISH_MODE: z.enum(['dry_run', 'sandbox', 'live']).default('dry_run'),
  SMB_ALLOW_LIVE_PUBLISH: bool.default('false'),
  SMB_AI_PROVIDER: z.enum(['stub', 'worker']).default('stub'),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  // Treat empty strings (as left by .env.example) as unset.
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== ''));
  const env = EnvSchema.parse(cleaned);
  if (env.SMB_PUBLISH_MODE === 'live' && !env.SMB_ALLOW_LIVE_PUBLISH) {
    throw new Error('SMB_PUBLISH_MODE=live requires SMB_ALLOW_LIVE_PUBLISH=true');
  }
  return env;
}
