import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkerConfig, WorkerPaths } from '../config.js';
import { ManagedProcess } from './process.js';
import type { Workflow } from './workflow.js';

/** What the stage runner needs from the image-model server. */
export interface ImageRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly running: boolean;
  /** Runs a workflow and returns the absolute paths of the images it saved. */
  generate(workflow: Workflow, timeoutMs?: number): Promise<string[]>;
  /** CUDA device names ComfyUI reports, to prove the GPU (not the CPU) is in use. */
  devices(): Promise<string[]>;
}

interface HistoryEntry {
  status?: { status_str?: string; messages?: unknown[] };
  outputs?: Record<string, { images?: { filename: string; subfolder: string; type: string }[] }>;
}

/**
 * Starts ComfyUI headless (localhost only, no custom nodes, no browser) for the image stage and stops it
 * afterwards, so its GPU memory is freed by the process exiting rather than by a request.
 */
export class ComfyRuntime implements ImageRuntime {
  private proc: ManagedProcess | undefined;
  readonly baseUrl: string;

  constructor(
    cfg: WorkerConfig,
    private readonly paths: WorkerPaths,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.baseUrl = `http://127.0.0.1:${cfg.comfy.port}`;
    this.port = cfg.comfy.port;
  }
  private readonly port: number;

  get running(): boolean {
    return this.proc?.running ?? false;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.proc = new ManagedProcess({
      name: 'comfyui',
      command: this.paths.comfyPython,
      args: [
        '-s',
        this.paths.comfyMain,
        '--listen',
        '127.0.0.1',
        '--port',
        String(this.port),
        '--disable-auto-launch',
        '--disable-all-custom-nodes',
        '--offline',
        '--output-directory',
        this.paths.outputs,
        '--temp-directory',
        this.paths.comfyTemp,
        '--input-directory',
        this.paths.comfyInput,
        '--user-directory',
        this.paths.comfyUser,
      ],
      cwd: this.paths.comfyDir,
      env: { PYTHONIOENCODING: 'utf-8' },
      logFile: join(this.paths.logs, 'comfyui.log'),
    });
    this.proc.start();
    await this.waitUntilUp(180_000);
  }

  private async waitUntilUp(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const res = await this.fetchImpl(`${this.baseUrl}/system_stats`, {
          signal: AbortSignal.timeout(3_000),
        });
        if (res.ok) return;
      } catch {
        /* not up yet */
      }
      if (this.proc && !this.proc.running)
        throw new Error('comfyui exited while starting; see comfyui.log');
      await new Promise((r) => setTimeout(r, 1_000));
    }
    throw new Error(`comfyui did not become ready within ${timeoutMs / 1000}s`);
  }

  async devices(): Promise<string[]> {
    const res = await this.fetchImpl(`${this.baseUrl}/system_stats`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`comfyui /system_stats returned HTTP ${res.status}`);
    const body = (await res.json()) as { devices?: { name?: string; type?: string }[] };
    return (body.devices ?? []).filter((d) => d.type === 'cuda').map((d) => d.name ?? 'cuda');
  }

  async generate(workflow: Workflow, timeoutMs = 600_000): Promise<string[]> {
    const submit = await this.fetchImpl(`${this.baseUrl}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: workflow, client_id: randomUUID() }),
      signal: AbortSignal.timeout(30_000),
    });
    const submitted = (await submit.json().catch(() => ({}))) as {
      prompt_id?: string;
      error?: { message?: string };
      node_errors?: unknown;
    };
    if (!submit.ok || !submitted.prompt_id) {
      throw new Error(
        `comfyui rejected the workflow: ${submitted.error?.message ?? `HTTP ${submit.status}`} ${
          submitted.node_errors ? JSON.stringify(submitted.node_errors) : ''
        }`.trim(),
      );
    }
    const id = submitted.prompt_id;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const res = await this.fetchImpl(`${this.baseUrl}/history/${id}`, {
        signal: AbortSignal.timeout(10_000),
      });
      const history = (await res.json()) as Record<string, HistoryEntry>;
      const entry = history[id];
      if (entry?.status?.status_str === 'error') {
        throw new Error(`comfyui failed the job: ${JSON.stringify(entry.status.messages ?? [])}`);
      }
      if (entry?.outputs && Object.keys(entry.outputs).length > 0) {
        const files: string[] = [];
        for (const out of Object.values(entry.outputs)) {
          for (const img of out.images ?? []) {
            if (img.type === 'output')
              files.push(join(this.paths.outputs, img.subfolder, img.filename));
          }
        }
        if (files.length === 0) throw new Error('comfyui finished but saved no images');
        return files;
      }
      if (!this.running) throw new Error('comfyui stopped while generating');
      await new Promise((r) => setTimeout(r, 1_000));
    }
    throw new Error(`comfyui did not finish within ${timeoutMs / 1000}s`);
  }

  async stop(): Promise<void> {
    await this.proc?.stop();
    this.proc = undefined;
  }
}

export function loadWorkflowTemplate(path: string): Workflow {
  return JSON.parse(readFileSync(path, 'utf8')) as Workflow;
}
