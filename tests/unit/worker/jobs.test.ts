import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AiError,
  StubProvider,
  buildGenerationInput,
  type ChannelsRegistry,
  type GenerationInput,
} from '../../../packages/shared/src/index.js';
import { WorkerApiClient } from '../../../apps/worker/src/api-client.js';
import { readCheckpoint, writeCheckpoint } from '../../../apps/worker/src/checkpoint.js';
import {
  createWorkerRuntimeState,
  recoverCheckpoint,
  startJobLoop,
} from '../../../apps/worker/src/jobs.js';
import { GpuStageRunner } from '../../../apps/worker/src/stages.js';
import { Events, FakeGpu, FakeImage, FakeLlm } from './helpers.js';

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'xlw-jobs-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function jsonResponse(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function sampleInput(): GenerationInput {
  const channels: ChannelsRegistry = {
    channels: [
      {
        id: 'x',
        name: 'X',
        enabled: true,
        maxTextLength: 280,
        maxImages: 4,
        mediaRequired: false,
        altTextRequired: true,
      },
    ],
  };
  return buildGenerationInput({
    postType: '1.1',
    opportunityId: '00000000-0000-4000-8000-000000000401',
    packageId: '00000000-0000-4000-8000-000000000501',
    phase: 'tournament',
    angleId: 'game_result',
    claims: [
      {
        claimKey: 'event.name',
        value: 'World Championship 2026',
        verification: 'verified',
        confidence: 0.95,
      },
      {
        claimKey: 'game.white',
        value: 'Gukesh D',
        verification: 'verified',
        confidence: 0.95,
      },
      {
        claimKey: 'game.black',
        value: 'Sindarov',
        verification: 'verified',
        confidence: 0.95,
      },
      {
        claimKey: 'game.result',
        value: '1-0',
        verification: 'verified',
        confidence: 0.95,
      },
    ],
    contentRules: { tone: 'factual', structure: ['headline', 'summary'], restrictions: [] },
    channelIds: ['x'],
    channels,
    imageRules: { need: 'preferred', preferOriginalPhoto: true, composition: [] },
  });
}

function makeRunner() {
  const events = new Events();
  const gpu = new FakeGpu();
  const runner = new GpuStageRunner({
    llm: new FakeLlm(events, gpu),
    image: new FakeImage(events, gpu),
    gpu,
    requireGpu: false,
  });
  return { gpu, runner };
}

describe('worker job loop', () => {
  it('claims a job, runs generation, completes and clears checkpoint', async () => {
    const dir = tempDir();
    const { gpu, runner } = makeRunner();
    const input = sampleInput();
    const jobId = '00000000-0000-4000-8000-000000000101';
    const leaseId = '00000000-0000-4000-8000-000000000201';
    const calls: string[] = [];

    const fetchImpl = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      calls.push(path);
      if (path === '/worker/v1/jobs/claim') {
        return jsonResponse(200, {
          kind: 'candidates_generate',
          jobId,
          leaseId,
          leaseExpiresAt: new Date(Date.now() + 600_000).toISOString(),
          attempt: 1,
          input,
        });
      }
      if (path === `/worker/v1/jobs/${jobId}/complete`) {
        void loop.stop();
        return jsonResponse(200, { outcome: 'completed' });
      }
      return jsonResponse(404, { error: { code: 'not_found', message: 'unexpected' } });
    });

    const client = new WorkerApiClient({
      baseUrl: 'https://api.example.com',
      token: 'smbw_test_token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const state = createWorkerRuntimeState();
    const loop = startJobLoop({
      client,
      workerVersion: '0.1.0',
      checkpointsDir: dir,
      state,
      runner,
      gpu,
      template: {},
      comfyModelsDir: dir,
      provider: new StubProvider(),
      sleep: async () => undefined,
    });

    await loop.done;
    expect(calls).toEqual(['/worker/v1/jobs/claim', `/worker/v1/jobs/${jobId}/complete`]);
    expect(readCheckpoint(dir)).toBeNull();
  });

  it('doubles backoff up to 60s on 204 empty responses', async () => {
    const dir = tempDir();
    const { gpu, runner } = makeRunner();
    const sleeps: number[] = [];

    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const client = new WorkerApiClient({
      baseUrl: 'https://api.example.com',
      token: 'smbw_test_token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const state = createWorkerRuntimeState();
    state.pollSeconds = 10;

    const loop = startJobLoop({
      client,
      workerVersion: '0.1.0',
      checkpointsDir: dir,
      state,
      runner,
      gpu,
      template: {},
      comfyModelsDir: dir,
      sleep: async (ms) => {
        sleeps.push(ms);
        if (sleeps.length >= 4) void loop.stop();
      },
    });
    await loop.done;
    expect(sleeps).toEqual([10_000, 20_000, 40_000, 60_000]);
  });

  it('discards the result and skips complete when heartbeat returns cancel: true', async () => {
    const dir = tempDir();
    const { gpu, runner } = makeRunner();
    const input = sampleInput();
    const jobId = '00000000-0000-4000-8000-000000000102';
    const leaseId = '00000000-0000-4000-8000-000000000202';
    let completeCalls = 0;

    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      if (path === '/worker/v1/jobs/claim') {
        return jsonResponse(200, {
          kind: 'candidates_generate',
          jobId,
          leaseId,
          leaseExpiresAt: new Date(Date.now() + 600_000).toISOString(),
          attempt: 1,
          input,
        });
      }
      if (path === `/worker/v1/jobs/${jobId}/heartbeat`) {
        void loop.stop();
        return jsonResponse(200, { cancel: true });
      }
      if (path === `/worker/v1/jobs/${jobId}/complete`) {
        completeCalls += 1;
        return jsonResponse(200, { outcome: 'completed' });
      }
      return jsonResponse(404, {});
    });

    const client = new WorkerApiClient({
      baseUrl: 'https://api.example.com',
      token: 'smbw_test_token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const state = createWorkerRuntimeState();
    state.heartbeatSeconds = 0.01;
    const slowProvider = {
      name: 'slow',
      model: 'slow',
      generate: async (task: Parameters<StubProvider['generate']>[0]) => {
        await new Promise((r) => setTimeout(r, 150));
        return new StubProvider().generate(task);
      },
    };

    const loop = startJobLoop({
      client,
      workerVersion: '0.1.0',
      checkpointsDir: dir,
      state,
      runner,
      gpu,
      template: {},
      comfyModelsDir: dir,
      provider: slowProvider,
      sleep: async () => undefined,
    });
    await loop.done;
    expect(completeCalls).toBe(0);
    expect(readCheckpoint(dir)).toBeNull();
  });

  it('reports a thrown AiError via fail with its retryable flag', async () => {
    const dir = tempDir();
    const { gpu, runner } = makeRunner();
    const input = sampleInput();
    const jobId = '00000000-0000-4000-8000-000000000103';
    const leaseId = '00000000-0000-4000-8000-000000000203';
    let failBody: Record<string, unknown> | undefined;

    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (path === '/worker/v1/jobs/claim') {
        return jsonResponse(200, {
          kind: 'candidates_generate',
          jobId,
          leaseId,
          leaseExpiresAt: new Date(Date.now() + 600_000).toISOString(),
          attempt: 1,
          input,
        });
      }
      if (path === `/worker/v1/jobs/${jobId}/fail`) {
        failBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        void loop.stop();
        return jsonResponse(200, { outcome: 'failed' });
      }
      return jsonResponse(404, {});
    });

    const client = new WorkerApiClient({
      baseUrl: 'https://api.example.com',
      token: 'smbw_test_token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const failingProvider = {
      name: 'fail',
      model: 'fail',
      generate: async () => {
        throw new AiError('invalid_output', 'bad json', false);
      },
    };

    const loop = startJobLoop({
      client,
      workerVersion: '0.1.0',
      checkpointsDir: dir,
      state: createWorkerRuntimeState(),
      runner,
      gpu,
      template: {},
      comfyModelsDir: dir,
      provider: failingProvider,
      sleep: async () => undefined,
    });
    await loop.done;
    expect(failBody).toMatchObject({
      leaseId,
      code: 'invalid_output',
      message: 'bad json',
      retryable: false,
    });
    expect(readCheckpoint(dir)).toBeNull();
  });

  it('retries complete after a network error until it succeeds', async () => {
    const dir = tempDir();
    const { gpu, runner } = makeRunner();
    const input = sampleInput();
    const jobId = '00000000-0000-4000-8000-000000000104';
    const leaseId = '00000000-0000-4000-8000-000000000204';
    let completeAttempts = 0;

    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      if (path === '/worker/v1/jobs/claim') {
        return jsonResponse(200, {
          kind: 'candidates_generate',
          jobId,
          leaseId,
          leaseExpiresAt: new Date(Date.now() + 600_000).toISOString(),
          attempt: 1,
          input,
        });
      }
      if (path === `/worker/v1/jobs/${jobId}/complete`) {
        completeAttempts += 1;
        if (completeAttempts < 3) throw new Error('ECONNRESET');
        void loop.stop();
        return jsonResponse(200, { outcome: 'completed' });
      }
      return jsonResponse(404, {});
    });

    const client = new WorkerApiClient({
      baseUrl: 'https://api.example.com',
      token: 'smbw_test_token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const loop = startJobLoop({
      client,
      workerVersion: '0.1.0',
      checkpointsDir: dir,
      state: createWorkerRuntimeState(),
      runner,
      gpu,
      template: {},
      comfyModelsDir: dir,
      provider: new StubProvider(),
      sleep: async () => undefined,
      retryBaseMs: 1,
      maxRetryMs: 2,
    });
    await loop.done;
    expect(completeAttempts).toBe(3);
    expect(readCheckpoint(dir)).toBeNull();
  });

  it('recovers a startup checkpoint by calling fail with worker_restarted', async () => {
    const dir = tempDir();
    const jobId = '00000000-0000-4000-8000-000000000105';
    const leaseId = '00000000-0000-4000-8000-000000000205';
    writeCheckpoint(dir, {
      jobId,
      leaseId,
      kind: 'candidates_generate',
      startedAt: new Date().toISOString(),
    });

    let failBody: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      failBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse(200, { outcome: 'requeued' });
    });
    const client = new WorkerApiClient({
      baseUrl: 'https://api.example.com',
      token: 'smbw_test_token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await recoverCheckpoint(client, dir);
    expect(failBody).toMatchObject({
      leaseId,
      code: 'worker_restarted',
      retryable: true,
    });
    expect(readCheckpoint(dir)).toBeNull();
  });

  it('stops the loop on 401', async () => {
    const dir = tempDir();
    const { gpu, runner } = makeRunner();
    const fetchImpl = vi.fn(async () =>
      jsonResponse(401, { error: { code: 'worker_revoked', message: 'revoked' } }),
    );
    const client = new WorkerApiClient({
      baseUrl: 'https://api.example.com',
      token: 'smbw_test_token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const loop = startJobLoop({
      client,
      workerVersion: '0.1.0',
      checkpointsDir: dir,
      state: createWorkerRuntimeState(),
      runner,
      gpu,
      template: {},
      comfyModelsDir: dir,
      sleep: async () => undefined,
    });
    await loop.done;
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not call claim while paused or updateRequired', async () => {
    const dir = tempDir();
    const { gpu, runner } = makeRunner();
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const client = new WorkerApiClient({
      baseUrl: 'https://api.example.com',
      token: 'smbw_test_token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const state = createWorkerRuntimeState();
    state.paused = true;

    let ticks = 0;
    const loop = startJobLoop({
      client,
      workerVersion: '0.1.0',
      checkpointsDir: dir,
      state,
      runner,
      gpu,
      template: {},
      comfyModelsDir: dir,
      sleep: async () => {
        ticks += 1;
        if (ticks === 1) {
          state.paused = false;
          state.updateRequired = true;
        } else if (ticks >= 2) {
          void loop.stop();
        }
      },
    });
    await loop.done;
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
