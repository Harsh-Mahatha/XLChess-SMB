import type { Logger } from 'pino';

export interface StartLoopOptions {
  name: string;
  intervalMs: number;
  run: () => Promise<unknown>;
  logger: Logger;
  initialDelayMs?: number;
}

/**
 * Runs a periodic async task with no overlapping executions.
 * If the previous execution is still running when the interval fires,
 * it skips the beat and logs at debug level. Catches and logs all errors.
 * Unrefs the timer so it does not keep the event loop alive by itself.
 */
export function startLoop(o: StartLoopOptions): { stop(): void } {
  let running = false;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  async function beat() {
    if (stopped) return;
    if (running) {
      o.logger.debug({ loop: o.name }, 'Previous loop iteration still running; skipping beat');
      scheduleNext();
      return;
    }
    running = true;
    try {
      await o.run();
    } catch (err) {
      o.logger.error({ err, loop: o.name }, 'Unhandled error in loop');
    } finally {
      running = false;
      if (!stopped) {
        scheduleNext();
      }
    }
  }

  function scheduleNext() {
    if (stopped) return;
    timer = setTimeout(beat, o.intervalMs);
    timer.unref();
  }

  const initialDelay = o.initialDelayMs ?? 5000;
  timer = setTimeout(beat, initialDelay);
  timer.unref();

  return {
    stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
