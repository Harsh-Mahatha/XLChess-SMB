import { join } from 'node:path';
import { OllamaProvider, type AiProvider } from '@smb/shared';
import type { WorkerConfig, WorkerPaths } from '../config.js';
import { log } from '../log.js';
import { ManagedProcess } from './process.js';

export interface LoadedModel {
  name: string;
  sizeVram: number;
}

/** What the stage runner needs from the text-model server. */
export interface LlmRuntime {
  ensureRunning(): Promise<void>;
  loadedModels(): Promise<LoadedModel[]>;
  /** Tells Ollama to drop the model from GPU memory now. */
  unload(): Promise<void>;
  stop(): Promise<void>;
  /** The provider job handlers use to run prompts against the loaded model. */
  provider(): AiProvider;
  readonly model: string;
}

/**
 * Runs `ollama serve` bound to localhost only, with one loaded model and one request at a time.
 * Ollama stays running between jobs (it holds no GPU memory with no model loaded); models are unloaded
 * explicitly after every stage instead of trusting the keep-alive timer.
 */
export class OllamaRuntime implements LlmRuntime {
  readonly model: string;
  readonly baseUrl: string;
  private proc: ManagedProcess | undefined;
  private adopted = false;

  constructor(
    private readonly cfg: WorkerConfig,
    private readonly paths: WorkerPaths,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.model = cfg.ollama.model;
    this.baseUrl = `http://127.0.0.1:${cfg.ollama.port}`;
  }

  async isUp(): Promise<boolean> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/api/version`, {
        signal: AbortSignal.timeout(3_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async ensureRunning(): Promise<void> {
    if (await this.isUp()) {
      if (!this.proc?.running) this.adopted = true;
      return;
    }
    if (!this.proc?.running) {
      this.adopted = false;
      this.proc = new ManagedProcess({
        name: 'ollama',
        command: this.paths.ollamaExe,
        args: ['serve'],
        env: {
          OLLAMA_HOST: `127.0.0.1:${this.cfg.ollama.port}`,
          OLLAMA_MODELS: this.paths.ollamaModels,
          OLLAMA_MAX_LOADED_MODELS: '1',
          OLLAMA_NUM_PARALLEL: '1',
          OLLAMA_KEEP_ALIVE: '2m',
        },
        logFile: join(this.paths.logs, 'ollama.log'),
      });
      this.proc.start();
    }
    await this.waitUntilUp(60_000);
  }

  private async waitUntilUp(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.isUp()) return;
      if (this.proc && !this.proc.running)
        throw new Error('ollama exited while starting; see ollama.log');
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`ollama did not become ready within ${timeoutMs / 1000}s`);
  }

  async loadedModels(): Promise<LoadedModel[]> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/ps`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`ollama /api/ps returned HTTP ${res.status}`);
    const body = (await res.json()) as {
      models?: { name?: string; model?: string; size_vram?: number }[];
    };
    return (body.models ?? []).map((m) => ({
      name: m.name ?? m.model ?? 'unknown',
      sizeVram: m.size_vram ?? 0,
    }));
  }

  async unload(): Promise<void> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.model, keep_alive: 0 }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok && res.status !== 404) throw new Error(`ollama unload returned HTTP ${res.status}`);
    await res.arrayBuffer().catch(() => undefined);
  }

  /** The provider the job handlers use: same prompts and validation as the server's stub-tested path. */
  provider(): OllamaProvider {
    return new OllamaProvider({
      baseUrl: this.baseUrl,
      model: this.model,
      defaults: { numCtx: this.cfg.ollama.numCtx },
    });
  }

  async stop(): Promise<void> {
    if (this.adopted) {
      log('info', 'leaving an already-running ollama alone');
      return;
    }
    await this.proc?.stop();
  }
}
