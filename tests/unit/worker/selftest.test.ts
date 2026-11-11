import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatSelfTestReport, runLocalSelfTest } from '../../../apps/worker/src/selftest.js';
import { GpuStageRunner } from '../../../apps/worker/src/stages.js';
import type { Workflow } from '../../../apps/worker/src/runtimes/workflow.js';
import { Events, FakeGpu, FakeImage, FakeLlm, fastVram } from './helpers.js';

const template = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, '../../../apps/worker/workflows/z-image-turbo.json'),
    'utf8',
  ),
) as Workflow;

function setup() {
  const events = new Events();
  const gpu = new FakeGpu();
  const llm = new FakeLlm(events, gpu);
  const image = new FakeImage(events, gpu);
  const runner = new GpuStageRunner({ llm, image, gpu, requireGpu: true, vram: fastVram });
  const deps = {
    runner,
    gpu,
    template,
    comfyModelsDir: 'C:\\models',
    fileExists: () => true,
    readImage: () => ({ size: 250_000, isPng: true }),
  };
  return { events, gpu, llm, image, runner, deps };
}

describe('runLocalSelfTest', () => {
  it('passes when both models run on the GPU, one after the other, and release their memory', async () => {
    const { deps, events } = setup();
    const report = await runLocalSelfTest(deps);
    expect(report.ok).toBe(true);
    expect(report.steps.map((s) => s.name)).toEqual([
      'gpu',
      'image model files',
      'text model',
      'image model',
    ]);
    expect(events.list).toEqual([
      'llm:start',
      'llm:generate',
      'llm:unload',
      'image:start',
      'image:generate',
      'image:stop',
    ]);
    const text = report.steps.find((s) => s.name === 'text model');
    expect(text).toMatchObject({ baselineMiB: 1000, releasedMiB: 1000 });
    expect(formatSelfTestReport(report)).toContain('Self-test PASSED');
  });

  it('fails early, naming the files, when image model files are missing', async () => {
    const { deps, events } = setup();
    const report = await runLocalSelfTest({ ...deps, fileExists: () => false });
    expect(report.ok).toBe(false);
    expect(report.steps.at(-1)?.detail).toMatch(/z_image_turbo_bf16\.safetensors/);
    expect(events.list).toEqual([]);
  });

  it('fails when there is no GPU', async () => {
    const { deps, gpu } = setup();
    gpu.present = false;
    const report = await runLocalSelfTest(deps);
    expect(report.ok).toBe(false);
    expect(report.gpu).toBeNull();
    expect(report.steps).toHaveLength(1);
  });

  it('fails when the text model answers invalid JSON', async () => {
    const { deps, llm } = setup();
    llm.answer = { fact: '', openings: [] };
    const report = await runLocalSelfTest(deps);
    expect(report.ok).toBe(false);
    expect(report.steps.find((s) => s.name === 'text model')?.ok).toBe(false);
  });

  it('fails when ComfyUI reports no CUDA device', async () => {
    const { deps, image } = setup();
    image.devicesList = [];
    const report = await runLocalSelfTest(deps);
    expect(report.ok).toBe(false);
    expect(report.steps.at(-1)?.detail).toMatch(/no CUDA device/);
  });

  it('fails when the output is not a PNG', async () => {
    const { deps } = setup();
    const report = await runLocalSelfTest({
      ...deps,
      readImage: () => ({ size: 5000, isPng: false }),
    });
    expect(report.ok).toBe(false);
  });

  it('fails when the text model does not give back its GPU memory', async () => {
    const { deps, llm } = setup();
    llm.releaseOnUnload = false;
    const report = await runLocalSelfTest(deps);
    expect(report.ok).toBe(false);
    expect(report.steps.find((s) => s.name === 'text model')?.detail).toMatch(/did not give back/);
  });
});
