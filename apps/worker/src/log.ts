/** One JSON object per line on stdout; the Windows service wrapper writes it to the rotating log file. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export function log(level: LogLevel, msg: string, extra?: Record<string, unknown>): void {
  process.stdout.write(
    `${JSON.stringify({ time: new Date().toISOString(), level, msg, ...extra })}\n`,
  );
}
