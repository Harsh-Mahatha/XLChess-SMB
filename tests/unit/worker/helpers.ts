import type { AiProvider } from '../../../packages/shared/src/index.js';
import type { GpuMonitor, GpuSample } from '../../../apps/worker/src/gpu.js';
import type { ImageRuntime } from '../../../apps/worker/src/runtimes/comfy.js';
import type { LlmRuntime, LoadedModel } from '../../../apps/worker/src/runtimes/ollama.js';
import type { Workflow } from '../../../apps/worker/src/runtimes/workflow.js';

/** One shared event log lets tests assert the exact order of load/unload calls across both runtimes. */
export class Events {
  readonly list: string[] = [];
  add(e: string): void {
    this.list.push(e);
  }
}

/** A GPU whose memory use follows what the fake runtimes "load". */
export class FakeGpu implements GpuMonitor {
  usedMiB = 1000;
  total = 12282;
  present = true;
  async sample(): Promise<GpuSample | null> {
    if (!this.present) return null;
    return {
      index: 0,
      name: 'Fake RTX 4070',
      totalMiB: this.total,
      usedMiB: this.usedMiB,
      driver: '572.16',
    };
  }
}

export class FakeLlm implements LlmRuntime {
  readonly model = 'qwen3.5:9b';
  loaded = false;
  /** false simulates a model that keeps its memory after being told to unload. */
  releaseOnUnload = true;
  answer: unknown = { fact: 'The Sicilian is popular.', openings: ['Sicilian', 'Ruy Lopez'] };
  constructor(
    private readonly events: Events,
    private readonly gpu: FakeGpu,
  ) {}
  async ensureRunning(): Promise<void> {
    this.events.add('llm:start');
  }
  async loadedModels(): Promise<LoadedModel[]> {
    return this.loaded ? [{ name: this.model, sizeVram: 6_000_000_000 }] : [];
  }
  async unload(): Promise<void> {
    this.events.add('llm:unload');
    this.loaded = false;
    if (this.releaseOnUnload) this.gpu.usedMiB = 1000;
  }
  async stop(): Promise<void> {
    this.events.add('llm:stop');
  }
  provider(): AiProvider {
    return {
      name: 'fake',
      model: this.model,
      generate: async (task) => {
        this.events.add('llm:generate');
        this.loaded = true;
        this.gpu.usedMiB = 8000;
        return {
          output: task.schema.parse(this.answer),
          provider: 'fake',
          model: this.model,
          settings: {},
          durationMs: 1,
          repaired: false,
        };
      },
    } as AiProvider;
  }
}

export class FakeImage implements ImageRuntime {
  running = false;
  releaseOnStop = true;
  devicesList = ['NVIDIA GeForce RTX 4070'];
  files: string[] = ['out/selftest_00001_.png'];
  failGenerate = false;
  constructor(
    private readonly events: Events,
    private readonly gpu: FakeGpu,
  ) {}
  async start(): Promise<void> {
    this.events.add('image:start');
    this.running = true;
    this.gpu.usedMiB = 9000;
  }
  async stop(): Promise<void> {
    this.events.add('image:stop');
    this.running = false;
    if (this.releaseOnStop) this.gpu.usedMiB = 1000;
  }
  async devices(): Promise<string[]> {
    return this.devicesList;
  }
  async generate(_wf: Workflow): Promise<string[]> {
    this.events.add('image:generate');
    if (this.failGenerate) throw new Error('comfyui failed the job');
    return this.files;
  }
}

/** Short waits so a "memory never released" test finishes quickly. */
export const fastVram = { toleranceMiB: 500, timeoutMs: 50, intervalMs: 5 };

export type { GpuMonitor };
