import { describe, expect, it } from 'vitest';
import {
  PeakSampler,
  parseNvidiaSmiCsv,
  pickGpu,
  waitForVramRelease,
  type GpuMonitor,
} from '../../../apps/worker/src/gpu.js';
import { FakeGpu } from './helpers.js';

describe('parseNvidiaSmiCsv', () => {
  it('reads one line per GPU', () => {
    const text = '0, NVIDIA GeForce RTX 4070, 12282, 1043, 572.16\r\n';
    expect(parseNvidiaSmiCsv(text)).toEqual([
      {
        index: 0,
        name: 'NVIDIA GeForce RTX 4070',
        totalMiB: 12282,
        usedMiB: 1043,
        driver: '572.16',
      },
    ]);
  });

  it('ignores blank, malformed and error lines', () => {
    expect(parseNvidiaSmiCsv('\nNVIDIA-SMI has failed\n0, X, abc, 1, 2\n')).toEqual([]);
  });

  it('picks the GPU with the most memory when there are several', () => {
    const text = '0, RTX 3050, 6144, 100, 560.1\n1, RTX 4070, 12282, 200, 560.1';
    const gpus = parseNvidiaSmiCsv(text);
    expect(gpus).toHaveLength(2);
    expect(pickGpu(gpus)?.name).toBe('RTX 4070');
  });
});

describe('waitForVramRelease', () => {
  it('returns at once when memory is already near the baseline', async () => {
    const gpu = new FakeGpu();
    gpu.usedMiB = 1200;
    const r = await waitForVramRelease(gpu, { baselineMiB: 1000, sleep: async () => undefined });
    expect(r).toEqual({ released: true, usedMiB: 1200 });
  });

  it('waits while memory drains, then reports released', async () => {
    const gpu = new FakeGpu();
    gpu.usedMiB = 9000;
    let sleeps = 0;
    const r = await waitForVramRelease(gpu, {
      baselineMiB: 1000,
      sleep: async () => {
        sleeps++;
        gpu.usedMiB -= 4000;
      },
    });
    expect(r.released).toBe(true);
    expect(sleeps).toBe(2);
  });

  it('gives up after the timeout and says memory was not released', async () => {
    const gpu = new FakeGpu();
    gpu.usedMiB = 9000;
    let t = 0;
    const r = await waitForVramRelease(gpu, {
      baselineMiB: 1000,
      timeoutMs: 3000,
      intervalMs: 1000,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
    });
    expect(r).toEqual({ released: false, usedMiB: 9000 });
  });

  it('treats a PC without a GPU as nothing to wait for', async () => {
    const gpu = new FakeGpu();
    gpu.present = false;
    expect((await waitForVramRelease(gpu, { baselineMiB: 0 })).released).toBe(true);
  });
});

describe('PeakSampler', () => {
  it('reports the highest value seen', async () => {
    const values = [1000, 5000, 9000, 2000];
    let i = 0;
    const monitor: GpuMonitor = {
      sample: async () => ({
        index: 0,
        name: 'x',
        totalMiB: 12000,
        usedMiB: values[Math.min(i++, values.length - 1)] as number,
        driver: '1',
      }),
    };
    const sampler = new PeakSampler(monitor, 5);
    sampler.start();
    await new Promise((r) => setTimeout(r, 40));
    expect(await sampler.stop()).toBe(9000);
  });
});
