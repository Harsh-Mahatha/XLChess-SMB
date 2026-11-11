import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { GpuMonitor } from './gpu.js';
import type { GpuStageRunner } from './stages.js';

export interface HealthSnapshot {
  pid: number;
  version: string;
  /** ISO time of this write. The watchdog treats a file older than 3 minutes as "worker hung". */
  at: string;
  startedAt: string;
  ollamaUp: boolean;
  models: { llm: string; image: string };
  gpu: { name: string; usedMiB: number; totalMiB: number } | null;
}

export interface HealthSources {
  version: string;
  startedAt: string;
  runner: GpuStageRunner;
  gpu: GpuMonitor;
  ollamaUp: () => Promise<boolean>;
}

export async function collectHealth(src: HealthSources): Promise<HealthSnapshot> {
  const g = await src.gpu.sample();
  return {
    pid: process.pid,
    version: src.version,
    at: new Date().toISOString(),
    startedAt: src.startedAt,
    ollamaUp: await src.ollamaUp().catch(() => false),
    models: { llm: src.runner.state.llm, image: src.runner.state.image },
    gpu: g ? { name: g.name, usedMiB: g.usedMiB, totalMiB: g.totalMiB } : null,
  };
}

/** Atomic write: the watchdog must never read a half-written file. */
export function writeHealthFile(path: string, snapshot: HealthSnapshot): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(snapshot));
  renameSync(tmp, path);
}

export function startHealthLoop(path: string, src: HealthSources, everyMs = 30_000): () => void {
  const tick = (): void => {
    void collectHealth(src)
      .then((s) => writeHealthFile(path, s))
      .catch(() => undefined);
  };
  tick();
  const timer = setInterval(tick, everyMs);
  return () => clearInterval(timer);
}
