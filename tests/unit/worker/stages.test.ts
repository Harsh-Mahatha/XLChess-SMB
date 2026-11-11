import { describe, expect, it } from 'vitest';
import { GpuStageRunner, VramNotReleasedError } from '../../../apps/worker/src/stages.js';
import { Events, FakeGpu, FakeImage, FakeLlm, fastVram } from './helpers.js';

function setup(opts: { requireGpu?: boolean } = {}) {
  const events = new Events();
  const gpu = new FakeGpu();
  const llm = new FakeLlm(events, gpu);
  const image = new FakeImage(events, gpu);
  const runner = new GpuStageRunner({
    llm,
    image,
    gpu,
    requireGpu: opts.requireGpu ?? true,
    vram: fastVram,
  });
  return { events, gpu, llm, image, runner };
}

describe('GpuStageRunner', () => {
  it('runs the text stage, unloads the model and verifies memory came back', async () => {
    const { events, runner, llm } = setup();
    const r = await runner.runLlmStage(async () => {
      llm.loaded = true;
      return 'text';
    });
    expect(r.value).toBe('text');
    expect(events.list).toEqual(['llm:start', 'llm:unload']);
    expect(r.baselineMiB).toBe(1000);
    expect(r.releasedMiB).toBe(1000);
    expect(runner.state.llm).toBe('unloaded');
  });

  it('never has both models loaded: text is unloaded before the image runtime starts', async () => {
    const { events, runner } = setup();
    await runner.runLlmStage(async (llm) => {
      await llm.provider().generate({
        name: 't',
        promptVersion: 'v',
        messages: [],
        schema: { parse: (x: unknown) => x } as never,
      });
    });
    await runner.runImageStage(async () => 'img');
    const order = events.list;
    expect(order.indexOf('llm:unload')).toBeLessThan(order.indexOf('image:start'));
    expect(order).toEqual(['llm:start', 'llm:generate', 'llm:unload', 'image:start', 'image:stop']);
  });

  it('unloads a text model left over from an earlier crash before starting the image stage', async () => {
    const { events, runner, llm } = setup();
    llm.loaded = true;
    await runner.runImageStage(async () => 'img');
    expect(events.list).toEqual(['llm:unload', 'image:start', 'image:stop']);
  });

  it('stops a leftover image runtime before a text stage', async () => {
    const { events, runner, image } = setup();
    image.running = true;
    await runner.runLlmStage(async () => 'x');
    expect(events.list.slice(0, 2)).toEqual(['image:stop', 'llm:start']);
  });

  it('serializes stages: two jobs cannot load models at the same time', async () => {
    const { events, runner } = setup();
    const gate: { open: () => void } = { open: () => undefined };
    const blocked = new Promise<void>((r) => (gate.open = r));
    const first = runner.runLlmStage(async () => {
      events.add('first:running');
      await blocked;
      events.add('first:done');
    });
    const second = runner.runImageStage(async () => {
      events.add('second:running');
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(events.list).not.toContain('image:start');
    gate.open();
    await Promise.all([first, second]);
    expect(events.list.indexOf('first:done')).toBeLessThan(events.list.indexOf('image:start'));
  });

  it('still unloads the model when the stage fails, and rethrows the stage error', async () => {
    const { events, runner } = setup();
    await expect(
      runner.runLlmStage(async () => {
        throw new Error('model said nonsense');
      }),
    ).rejects.toThrow('model said nonsense');
    expect(events.list).toEqual(['llm:start', 'llm:unload']);
    expect(runner.state.llm).toBe('unloaded');
  });

  it('stops ComfyUI when the image stage fails', async () => {
    const { events, runner, image } = setup();
    await expect(
      runner.runImageStage(async (img) => {
        image.failGenerate = true;
        await img.generate({});
      }),
    ).rejects.toThrow('comfyui failed the job');
    expect(events.list).toContain('image:stop');
    expect(runner.state.image).toBe('unloaded');
  });

  it('fails and marks the model failed when the text model keeps its GPU memory', async () => {
    const { runner, llm, gpu } = setup();
    llm.releaseOnUnload = false;
    await expect(
      runner.runLlmStage(async () => {
        gpu.usedMiB = 8000;
      }),
    ).rejects.toBeInstanceOf(VramNotReleasedError);
    expect(runner.state.llm).toBe('failed');
  });

  it('fails when ComfyUI exits but its memory stays allocated', async () => {
    const { runner, image } = setup();
    image.releaseOnStop = false;
    await expect(runner.runImageStage(async () => 1)).rejects.toThrow(
      /did not give back GPU memory/,
    );
    expect(runner.state.image).toBe('failed');
  });

  it('refuses to run without a GPU in production', async () => {
    const { runner, gpu } = setup();
    gpu.present = false;
    await expect(runner.runLlmStage(async () => 1)).rejects.toThrow(/no NVIDIA GPU/);
  });

  it('skips memory checks (but still unloads) on a development PC when a GPU is not required', async () => {
    const { events, runner, gpu } = setup({ requireGpu: false });
    gpu.present = false;
    const r = await runner.runLlmStage(async () => 'ok');
    expect(r.baselineMiB).toBeNull();
    expect(r.releasedMiB).toBeNull();
    expect(events.list).toEqual(['llm:start', 'llm:unload']);
  });

  it('keeps working after a failed stage', async () => {
    const { runner } = setup();
    await runner.runLlmStage(async () => Promise.reject(new Error('boom'))).catch(() => undefined);
    const r = await runner.runImageStage(async () => 'fine');
    expect(r.value).toBe('fine');
  });
});
