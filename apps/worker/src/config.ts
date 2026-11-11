import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * `config.json` is written by the installer (never hand-edited) and holds no secrets: the device token
 * lives in a separate DPAPI-protected file.
 */
export const WorkerConfig = z.object({
  schemaVersion: z.literal(1),
  /** Where binaries live, e.g. C:\Program Files\XLChessWorker. */
  programDir: z.string().min(1),
  /** Where models, logs and state live, e.g. C:\ProgramData\XLChessWorker. */
  dataDir: z.string().min(1),
  apiUrl: z.string().url().optional(),
  ollama: z
    .object({
      port: z.number().int().default(11434),
      model: z.string().default('qwen3.5:9b'),
      numCtx: z.number().int().default(16384),
    })
    .default({}),
  comfy: z
    .object({
      port: z.number().int().default(8188),
    })
    .default({}),
});
export type WorkerConfig = z.infer<typeof WorkerConfig>;

export interface WorkerPaths {
  ollamaExe: string;
  ollamaModels: string;
  comfyDir: string;
  comfyPython: string;
  comfyMain: string;
  comfyModels: string;
  outputs: string;
  comfyTemp: string;
  comfyInput: string;
  comfyUser: string;
  logs: string;
  health: string;
  checkpoints: string;
  workflows: string;
  tokenFile: string;
}

export function derivePaths(cfg: WorkerConfig): WorkerPaths {
  const comfyDir = join(cfg.dataDir, 'comfyui');
  return {
    ollamaExe: join(cfg.programDir, 'ollama', 'ollama.exe'),
    ollamaModels: join(cfg.dataDir, 'models', 'ollama'),
    comfyDir,
    comfyPython: join(comfyDir, 'python_embeded', 'python.exe'),
    comfyMain: join(comfyDir, 'ComfyUI', 'main.py'),
    comfyModels: join(comfyDir, 'ComfyUI', 'models'),
    outputs: join(cfg.dataDir, 'outputs'),
    comfyTemp: join(cfg.dataDir, 'comfy-temp'),
    comfyInput: join(cfg.dataDir, 'comfy-input'),
    comfyUser: join(cfg.dataDir, 'comfy-user'),
    logs: join(cfg.dataDir, 'logs'),
    health: join(cfg.dataDir, 'state', 'health.json'),
    checkpoints: join(cfg.dataDir, 'checkpoints'),
    workflows: join(cfg.programDir, 'worker', 'workflows'),
    tokenFile: join(cfg.dataDir, 'secrets', 'device-token.bin'),
  };
}

export const DEFAULT_CONFIG_PATH = 'C:\\ProgramData\\XLChessWorker\\config.json';

export function loadConfig(path: string): WorkerConfig {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`cannot read worker config ${path}: ${String(err)}`);
  }
  // Tolerate a UTF-8 byte-order mark in case the file was edited with a Windows tool.
  const parsed = WorkerConfig.safeParse(JSON.parse(raw.replace(/^\uFEFF/, '')));
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`invalid worker config ${path}: ${problems}`);
  }
  return parsed.data;
}
