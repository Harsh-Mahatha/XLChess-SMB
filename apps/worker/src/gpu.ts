import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface GpuSample {
  index: number;
  name: string;
  totalMiB: number;
  usedMiB: number;
  driver: string;
}

/** Anything that can report GPU memory. Tests use a fake. */
export interface GpuMonitor {
  /** The GPU the models run on, or null when there is no NVIDIA GPU (development machines). */
  sample(): Promise<GpuSample | null>;
}

export const NVIDIA_SMI_ARGS = [
  '--query-gpu=index,name,memory.total,memory.used,driver_version',
  '--format=csv,noheader,nounits',
];

export function parseNvidiaSmiCsv(text: string): GpuSample[] {
  const out: GpuSample[] = [];
  for (const line of text.split(/\r?\n/)) {
    const f = line.split(',').map((s) => s.trim());
    if (f.length < 5) continue;
    const [index, name, total, used, driver] = f as [string, string, string, string, string];
    if (!/^\d+$/.test(index) || !/^\d+$/.test(total) || !/^\d+$/.test(used)) continue;
    out.push({
      index: Number(index),
      name,
      totalMiB: Number(total),
      usedMiB: Number(used),
      driver,
    });
  }
  return out;
}

/** The GPU with the most memory, which is the one the installer's preflight checked. */
export function pickGpu(samples: GpuSample[]): GpuSample | null {
  let best: GpuSample | null = null;
  for (const s of samples) if (!best || s.totalMiB > best.totalMiB) best = s;
  return best;
}

export class NvidiaSmiMonitor implements GpuMonitor {
  async sample(): Promise<GpuSample | null> {
    try {
      const { stdout } = await execFileAsync('nvidia-smi', NVIDIA_SMI_ARGS, {
        windowsHide: true,
        timeout: 10_000,
      });
      return pickGpu(parseNvidiaSmiCsv(stdout));
    } catch {
      return null;
    }
  }
}

export interface VramWaitOptions {
  /** Memory in use before the model was loaded. */
  baselineMiB: number;
  /** How far above the baseline still counts as released. */
  toleranceMiB?: number;
  timeoutMs?: number;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface VramWaitResult {
  released: boolean;
  usedMiB: number | null;
}

/**
 * Waits until GPU memory is back near its baseline. Used after every model is unloaded: a finished API call
 * is not proof the memory was given back (docs/SMB_Local_AI_Models..., section 7).
 */
export async function waitForVramRelease(
  monitor: GpuMonitor,
  options: VramWaitOptions,
): Promise<VramWaitResult> {
  const tolerance = options.toleranceMiB ?? 500;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const intervalMs = options.intervalMs ?? 1_000;
  const sleep = options.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = options.now ?? Date.now;
  const deadline = now() + timeoutMs;
  let last: number | null = null;
  for (;;) {
    const s = await monitor.sample();
    if (!s) return { released: true, usedMiB: null }; // nothing to measure
    last = s.usedMiB;
    if (s.usedMiB <= options.baselineMiB + tolerance) return { released: true, usedMiB: last };
    if (now() >= deadline) return { released: false, usedMiB: last };
    await sleep(intervalMs);
  }
}

/** Tracks the highest memory use seen while a stage runs. */
export class PeakSampler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private peak = 0;
  constructor(
    private readonly monitor: GpuMonitor,
    private readonly intervalMs = 500,
  ) {}
  start(): void {
    const tick = (): void => {
      void this.monitor.sample().then((s) => {
        if (s && s.usedMiB > this.peak) this.peak = s.usedMiB;
      });
    };
    tick();
    this.timer = setInterval(tick, this.intervalMs);
  }
  async stop(): Promise<number> {
    if (this.timer) clearInterval(this.timer);
    const s = await this.monitor.sample();
    if (s && s.usedMiB > this.peak) this.peak = s.usedMiB;
    return this.peak;
  }
}
