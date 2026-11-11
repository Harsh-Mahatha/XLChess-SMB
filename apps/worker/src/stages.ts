import { log } from './log.js';
import { PeakSampler, waitForVramRelease, type GpuMonitor } from './gpu.js';
import type { ImageRuntime } from './runtimes/comfy.js';
import type { LlmRuntime } from './runtimes/ollama.js';

/**
 * Model lifecycle from docs/SMB_Local_AI_Models_and_Sequential_Execution.md section 7:
 * unloaded -> loading -> running -> unloading -> unloaded (or failed when memory is not given back).
 */
export type ModelState = 'unloaded' | 'loading' | 'running' | 'unloading' | 'failed';

export interface StageResult<T> {
  value: T;
  durationMs: number;
  /** GPU memory in use before the stage, and the highest value seen during it. Null without an NVIDIA GPU. */
  baselineMiB: number | null;
  peakMiB: number | null;
  /** Memory in use once the model was released. */
  releasedMiB: number | null;
}

export class VramNotReleasedError extends Error {
  constructor(
    readonly model: 'llm' | 'image',
    readonly baselineMiB: number,
    readonly usedMiB: number | null,
  ) {
    super(
      `${model} model did not give back GPU memory (baseline ${baselineMiB} MiB, still ${usedMiB ?? '?'} MiB in use)`,
    );
    this.name = 'VramNotReleasedError';
  }
}

export interface StageRunnerOptions {
  llm: LlmRuntime;
  image: ImageRuntime;
  gpu: GpuMonitor;
  /** Production: true. Without a GPU there is nothing to verify, so a stage refuses to run. */
  requireGpu: boolean;
  vram?: { toleranceMiB?: number; timeoutMs?: number; intervalMs?: number };
}

/**
 * The only way the worker touches the GPU. It enforces the sequential-execution rules:
 *  1. one GPU-heavy model at a time (stages are serialized by a lock);
 *  2. explicit lifecycle (state is tracked and reported in health.json);
 *  3. memory release is verified with nvidia-smi, not assumed from a finished request;
 *  4. a failed stage still releases its model before the error is passed on.
 */
export class GpuStageRunner {
  private tail: Promise<unknown> = Promise.resolve();
  readonly state: { llm: ModelState; image: ModelState } = { llm: 'unloaded', image: 'unloaded' };

  constructor(private readonly o: StageRunnerOptions) {}

  runLlmStage<T>(fn: (llm: LlmRuntime) => Promise<T>): Promise<StageResult<T>> {
    return this.serialize(() => this.llmStage(fn));
  }

  runImageStage<T>(fn: (image: ImageRuntime) => Promise<T>): Promise<StageResult<T>> {
    return this.serialize(() => this.imageStage(fn));
  }

  private serialize<T>(job: () => Promise<T>): Promise<T> {
    const run = this.tail.then(job, job);
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async baseline(): Promise<number | null> {
    const s = await this.o.gpu.sample();
    if (!s && this.o.requireGpu) throw new Error('no NVIDIA GPU is available (nvidia-smi failed)');
    return s ? s.usedMiB : null;
  }

  private async confirmReleased(
    which: 'llm' | 'image',
    baseline: number | null,
  ): Promise<number | null> {
    if (baseline === null) return null;
    const r = await waitForVramRelease(this.o.gpu, { baselineMiB: baseline, ...this.o.vram });
    if (!r.released) {
      this.state[which] = 'failed';
      throw new VramNotReleasedError(which, baseline, r.usedMiB);
    }
    return r.usedMiB;
  }

  /** Before any stage: nothing of ours may still be holding GPU memory from an earlier crash or timeout. */
  private async ensureIdle(): Promise<void> {
    if (this.o.image.running) {
      log('warn', 'image runtime was still running before a new stage; stopping it');
      await this.o.image.stop();
    }
    let loaded: unknown[] = [];
    try {
      loaded = await this.o.llm.loadedModels();
    } catch {
      /* Ollama not running: nothing is loaded */
    }
    if (loaded.length > 0) {
      log('warn', 'a text model was still loaded before a new stage; unloading it');
      await this.o.llm.unload();
    }
  }

  private async llmStage<T>(fn: (llm: LlmRuntime) => Promise<T>): Promise<StageResult<T>> {
    await this.ensureIdle();
    const baselineMiB = await this.baseline();
    const peak = new PeakSampler(this.o.gpu);
    const started = Date.now();
    let value: T | undefined;
    let failure: { error: unknown } | undefined;
    this.state.llm = 'loading';
    try {
      await this.o.llm.ensureRunning();
      this.state.llm = 'running';
      peak.start();
      value = await fn(this.o.llm);
    } catch (error) {
      failure = { error };
    }
    const peakMiB = baselineMiB === null ? null : await peak.stop();
    this.state.llm = 'unloading';
    let releasedMiB: number | null = null;
    try {
      await this.o.llm.unload();
      releasedMiB = await this.confirmReleased('llm', baselineMiB);
      this.state.llm = 'unloaded';
    } catch (releaseError) {
      this.state.llm = 'failed';
      if (!failure) throw releaseError;
      log('error', 'could not release the text model after a failed stage', {
        error: String(releaseError),
      });
    }
    if (failure) throw failure.error;
    return {
      value: value as T,
      durationMs: Date.now() - started,
      baselineMiB,
      peakMiB,
      releasedMiB,
    };
  }

  private async imageStage<T>(fn: (image: ImageRuntime) => Promise<T>): Promise<StageResult<T>> {
    await this.ensureIdle();
    const baselineMiB = await this.baseline();
    const peak = new PeakSampler(this.o.gpu);
    const started = Date.now();
    let value: T | undefined;
    let failure: { error: unknown } | undefined;
    this.state.image = 'loading';
    try {
      await this.o.image.start();
      this.state.image = 'running';
      peak.start();
      value = await fn(this.o.image);
    } catch (error) {
      failure = { error };
    }
    const peakMiB = baselineMiB === null ? null : await peak.stop();
    this.state.image = 'unloading';
    let releasedMiB: number | null = null;
    try {
      await this.o.image.stop();
      releasedMiB = await this.confirmReleased('image', baselineMiB);
      this.state.image = 'unloaded';
    } catch (releaseError) {
      this.state.image = 'failed';
      if (!failure) throw releaseError;
      log('error', 'could not release the image model after a failed stage', {
        error: String(releaseError),
      });
    }
    if (failure) throw failure.error;
    return {
      value: value as T,
      durationMs: Date.now() - started,
      baselineMiB,
      peakMiB,
      releasedMiB,
    };
  }
}
