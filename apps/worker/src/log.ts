/** One JSON object per line on stdout; the Windows service wrapper writes it to the rotating log file. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const SENSITIVE_KEY = /(token|secret|password|api_?key|pairing_?code|authorization|cookie)/i;
const DEVICE_TOKEN_PATTERN = /smbw_[A-Za-z0-9_-]{20,}/g;

export function maskSecrets(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(DEVICE_TOKEN_PATTERN, '[REDACTED]');
  }
  if (value === null || value === undefined || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => maskSecrets(item));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY.test(k) ? '[REDACTED]' : maskSecrets(v);
  }
  return out;
}

export function formatLogLine(
  level: LogLevel,
  msg: string,
  extra?: Record<string, unknown>,
): string {
  const maskedMsg = msg.replace(DEVICE_TOKEN_PATTERN, '[REDACTED]');
  const maskedExtra = extra ? (maskSecrets(extra) as Record<string, unknown>) : undefined;
  return JSON.stringify({
    time: new Date().toISOString(),
    level,
    msg: maskedMsg,
    ...maskedExtra,
  });
}

export function log(level: LogLevel, msg: string, extra?: Record<string, unknown>): void {
  process.stdout.write(`${formatLogLine(level, msg, extra)}\n`);
}
