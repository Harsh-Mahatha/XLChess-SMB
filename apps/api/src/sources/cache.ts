import { configHash } from '@smb/shared';

interface Entry<T> {
  value: T;
  expiresAt: number;
}

/** In-memory TTL cache (no Redis, per the guide). A TTL of 0 means "do not cache". */
export class TtlCache<T> {
  private readonly entries = new Map<string, Entry<T>>();
  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxEntries = 500,
  ) {}

  static key(sourceId: string, capability: string, query: unknown): string {
    return `${sourceId}:${capability}:${configHash(query)}`;
  }

  get(key: string): T | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: T, ttlSeconds: number): void {
    if (ttlSeconds <= 0) return;
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expiresAt: this.now() + ttlSeconds * 1000 });
  }

  clear(): void {
    this.entries.clear();
  }
}
