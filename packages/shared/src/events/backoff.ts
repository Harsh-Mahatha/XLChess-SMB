/** Longest wait between runs of a failing detector, so detection latency stays bounded during an outage. */
export const MAX_BACKOFF_MS = 10 * 60_000;
export const BACKOFF_JITTER = 0.1;

/**
 * Wait before the next run after `failures` consecutive failed runs (failures >= 1):
 * cadence × 2^failures, capped at MAX_BACKOFF_MS, ±10% jitter. `rand` returns [0, 1).
 */
export function backoffDelayMs(
  cadenceMs: number,
  failures: number,
  rand: () => number = Math.random,
): number {
  const exp = Math.min(Math.max(failures, 1), 20);
  const base = Math.min(Math.max(cadenceMs, 1_000) * 2 ** exp, MAX_BACKOFF_MS);
  const jitter = 1 + (rand() * 2 - 1) * BACKOFF_JITTER;
  return Math.round(Math.min(base * jitter, MAX_BACKOFF_MS));
}
