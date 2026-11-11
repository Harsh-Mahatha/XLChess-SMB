import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { GpuMonitor } from './gpu.js';
import type { GpuStageRunner } from './stages.js';
import { buildWorkflow, requiredModelFiles, type Workflow } from './runtimes/workflow.js';

export interface SelfTestStep {
  name: string;
  ok: boolean;
  detail: string;
  durationMs?: number;
  baselineMiB?: number | null;
  peakMiB?: number | null;
  releasedMiB?: number | null;
}

export interface SelfTestReport {
  ok: boolean;
  gpu: { name: string; totalMiB: number; driver: string } | null;
  steps: SelfTestStep[];
  durationMs: number;
}

export interface SelfTestDeps {
  runner: GpuStageRunner;
  gpu: GpuMonitor;
  template: Workflow;
  /** Folder that holds ComfyUI's `models/` tree. */
  comfyModelsDir: string;
  /** Overridable for tests. */
  fileExists?: (path: string) => boolean;
  readImage?: (path: string) => { size: number; isPng: boolean };
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

function defaultReadImage(path: string): { size: number; isPng: boolean } {
  const size = statSync(path).size;
  const head = readFileSync(path).subarray(0, 4);
  return { size, isPng: PNG_MAGIC.every((b, i) => head[i] === b) };
}

const Probe = z.object({
  fact: z.string().min(1),
  openings: z.array(z.string().min(1)).min(2),
});

/**
 * Part A of the installer self-test (docs/installer-v1-plan.md section 6): proves on this PC, without the
 * server, that both models run on the GPU one at a time and give their memory back.
 */
export async function runLocalSelfTest(deps: SelfTestDeps): Promise<SelfTestReport> {
  const started = Date.now();
  const steps: SelfTestStep[] = [];
  const fileExists = deps.fileExists ?? existsSync;
  const readImage = deps.readImage ?? defaultReadImage;
  const add = (s: SelfTestStep): boolean => {
    steps.push(s);
    return s.ok;
  };
  const finish = (gpu: SelfTestReport['gpu']): SelfTestReport => ({
    ok: steps.every((s) => s.ok),
    gpu,
    steps,
    durationMs: Date.now() - started,
  });

  const sample = await deps.gpu.sample();
  const gpu = sample
    ? { name: sample.name, totalMiB: sample.totalMiB, driver: sample.driver }
    : null;
  if (
    !add({
      name: 'gpu',
      ok: sample !== null,
      detail: sample
        ? `${sample.name}, ${sample.totalMiB} MiB, driver ${sample.driver}`
        : 'nvidia-smi found no NVIDIA GPU',
    })
  ) {
    return finish(gpu);
  }

  const missing = requiredModelFiles(deps.template)
    .map((m) => join(deps.comfyModelsDir, m.folder, m.file))
    .filter((p) => !fileExists(p));
  if (
    !add({
      name: 'image model files',
      ok: missing.length === 0,
      detail: missing.length === 0 ? 'all present' : `missing: ${missing.join(', ')}`,
    })
  ) {
    return finish(gpu);
  }

  // ---- text stage: valid structured output, and the model really sat in GPU memory
  try {
    const r = await deps.runner.runLlmStage(async (llm) => {
      const result = await llm.provider().generate({
        name: 'selftest',
        promptVersion: 'selftest@1',
        messages: [
          { role: 'system', content: 'You answer with one JSON object and nothing else.' },
          {
            role: 'user',
            content: 'Give one short chess fact in "fact" and two opening names in "openings".',
          },
        ],
        schema: Probe,
        settings: { temperature: 0, seed: 7, maxTokens: 400 },
      });
      const loaded = await llm.loadedModels();
      const inVram = loaded.some((m) => m.sizeVram > 0);
      return { output: result.output, inVram };
    });
    add({
      name: 'text model',
      ok: r.value.inVram,
      detail: r.value.inVram
        ? `valid JSON in ${r.durationMs} ms, model resident in GPU memory`
        : 'answered, but Ollama reports no GPU memory in use (running on CPU)',
      durationMs: r.durationMs,
      baselineMiB: r.baselineMiB,
      peakMiB: r.peakMiB,
      releasedMiB: r.releasedMiB,
    });
  } catch (err) {
    add({
      name: 'text model',
      ok: false,
      detail: String(err instanceof Error ? err.message : err),
    });
    return finish(gpu);
  }

  // ---- image stage: CUDA device in use, a real PNG produced
  try {
    const r = await deps.runner.runImageStage(async (image) => {
      const devices = await image.devices();
      const wf = buildWorkflow(deps.template, {
        prompt: 'a wooden chessboard with a few pieces, studio lighting, simple background',
        seed: 7,
        width: 512,
        height: 512,
        filenamePrefix: 'selftest',
      });
      const files = await image.generate(wf);
      const first = files[0];
      const info = first && fileExists(first) ? readImage(first) : null;
      return { devices, file: first, info };
    });
    const { devices, file, info } = r.value;
    const ok = devices.length > 0 && info !== null && info.isPng && info.size > 1000;
    add({
      name: 'image model',
      ok,
      detail: ok
        ? `PNG written (${info.size} bytes) on ${devices.join(', ')} in ${r.durationMs} ms`
        : devices.length === 0
          ? 'ComfyUI reports no CUDA device (running on CPU)'
          : `no valid PNG at ${file ?? '(none)'}`,
      durationMs: r.durationMs,
      baselineMiB: r.baselineMiB,
      peakMiB: r.peakMiB,
      releasedMiB: r.releasedMiB,
    });
  } catch (err) {
    add({
      name: 'image model',
      ok: false,
      detail: String(err instanceof Error ? err.message : err),
    });
  }
  return finish(gpu);
}

export function formatSelfTestReport(r: SelfTestReport): string {
  const lines = [r.ok ? 'Self-test PASSED' : 'Self-test FAILED'];
  if (r.gpu) lines.push(`GPU: ${r.gpu.name} (${r.gpu.totalMiB} MiB, driver ${r.gpu.driver})`);
  for (const s of r.steps) {
    const mem =
      s.peakMiB != null
        ? ` [VRAM baseline ${s.baselineMiB} -> peak ${s.peakMiB} -> released ${s.releasedMiB} MiB]`
        : '';
    lines.push(`${s.ok ? 'PASS' : 'FAIL'}  ${s.name}: ${s.detail}${mem}`);
  }
  lines.push(`Total: ${(r.durationMs / 1000).toFixed(1)} s`);
  return lines.join('\n');
}
