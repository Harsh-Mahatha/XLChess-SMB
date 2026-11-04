export interface LimiterOptions {
  maxConcurrent: number;
  minIntervalMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Per-source limiter: at most N requests in flight, at least `minIntervalMs` between request starts,
 * and a shared pause (`blockFor`) after a 429 that holds back every waiting request.
 */
export class RateLimiter {
  private active = 0;
  private lastStart = Number.NEGATIVE_INFINITY;
  private blockedUntil = Number.NEGATIVE_INFINITY;
  private readonly waiters: (() => void)[] = [];
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: LimiterOptions) {
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Holds new requests back for `ms` (called after HTTP 429). */
  blockFor(ms: number): void {
    this.blockedUntil = Math.max(this.blockedUntil, this.now() + ms);
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }

  private async acquire(): Promise<void> {
    while (this.active >= this.opts.maxConcurrent) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    // Reserve the slot before waiting so concurrent callers cannot all pass the check together.
    this.active++;
    try {
      for (;;) {
        const readyAt = Math.max(this.lastStart + this.opts.minIntervalMs, this.blockedUntil);
        const wait = readyAt - this.now();
        if (wait <= 0) break;
        await this.sleep(wait);
      }
    } catch (err) {
      this.active--;
      this.waiters.shift()?.();
      throw err;
    }
    this.lastStart = this.now();
  }
}
