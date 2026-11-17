import { pino, type DestinationStream, type Logger } from 'pino';
import type { Env } from './env.js';

/** Paths that must never reach logs. Extended as more secrets are introduced. */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-device-token"]',
  '*.password',
  '*.token',
  '*.accessToken',
  '*.secret',
  '*.apiKey',
  'SUPABASE_SERVICE_ROLE_KEY',
  'XLCHESS_JWT_SECRET',
  'X_API_KEY',
  'X_API_SECRET',
  'X_ACCESS_TOKEN',
  'X_ACCESS_TOKEN_SECRET',
  '*.apiSecret',
  '*.accessTokenSecret',
  '*.consumerSecret',
  '*.oauth_signature',
  'headers.authorization',
  'headers.Authorization',
  '*.headers.authorization',
  '*.headers.Authorization',
];

export function createLogger(env: Pick<Env, 'LOG_LEVEL'>, destination?: DestinationStream): Logger {
  return pino(
    { level: env.LOG_LEVEL, redact: { paths: REDACT_PATHS, censor: '[REDACTED]' } },
    destination,
  );
}
