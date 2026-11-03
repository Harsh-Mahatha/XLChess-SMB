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
];

export function createLogger(env: Pick<Env, 'LOG_LEVEL'>, destination?: DestinationStream): Logger {
  return pino(
    { level: env.LOG_LEVEL, redact: { paths: REDACT_PATHS, censor: '[REDACTED]' } },
    destination,
  );
}
