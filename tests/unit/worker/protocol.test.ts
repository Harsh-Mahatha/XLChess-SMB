import { describe, expect, it, vi } from 'vitest';
import { ApiError, WorkerApiClient } from '../../../apps/worker/src/api-client.js';
import { buildStatus, startHeartbeat } from '../../../apps/worker/src/heartbeat.js';
import { pairWithServer } from '../../../apps/worker/src/pairing.js';
import { GpuStageRunner } from '../../../apps/worker/src/stages.js';
import {
  WorkerPairRequest,
  WorkerPairResponse,
  WorkerStatusRequest,
} from '../../../packages/shared/src/index.js';
import { Events, FakeGpu, FakeImage, FakeLlm } from './helpers.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('pairWithServer', () => {
  const gpu = new FakeGpu();

  it('sends the code and machine details, and returns the token', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = WorkerPairRequest.parse(JSON.parse(String(init?.body)));
      expect(body.pairingCode).toBe('ABCD-1234');
      expect(body.gpu?.name).toBe('Fake RTX 4070');
      expect(new Headers(init?.headers).get('authorization')).toBeNull();
      return jsonResponse(200, { workerId: 'w_1', deviceToken: 'tok_0123456789abcdef' });
    });
    const r = await pairWithServer({
      apiUrl: 'https://smb.example.com/',
      pairingCode: '  ABCD-1234 ',
      version: '0.1.0',
      gpu,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r).toEqual({ ok: true, workerId: 'w_1', deviceToken: 'tok_0123456789abcdef' });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe('https://smb.example.com/worker/v1/pair');
  });

  it('works on a PC without a GPU (development)', async () => {
    const noGpu = new FakeGpu();
    noGpu.present = false;
    const fetchImpl = vi.fn(async (_u: string | URL | Request, init?: RequestInit) => {
      expect(WorkerPairRequest.parse(JSON.parse(String(init?.body))).gpu).toBeNull();
      return jsonResponse(200, { workerId: 'w', deviceToken: 'x'.repeat(20) });
    });
    const r = await pairWithServer({
      apiUrl: 'https://x',
      pairingCode: 'CODE1',
      version: '1',
      gpu: noGpu,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r.ok).toBe(true);
  });

  it.each([['pairing_code_invalid'], ['pairing_code_expired'], ['pairing_code_used']])(
    'reports %s without a token',
    async (code) => {
      const fetchImpl = async () =>
        jsonResponse(400, { error: { code, message: 'nope' } }) as Response;
      const r = await pairWithServer({
        apiUrl: 'https://x',
        pairingCode: 'CODE1',
        version: '1',
        gpu,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      expect(r).toEqual({ ok: false, error: code, message: 'nope' });
      expect(r.deviceToken).toBeUndefined();
    },
  );

  it('reports a network failure distinctly', async () => {
    const fetchImpl = async () => {
      throw new Error('ECONNREFUSED');
    };
    const r = await pairWithServer({
      apiUrl: 'https://x',
      pairingCode: 'CODE1',
      version: '1',
      gpu,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('network');
  });

  it('rejects a reply that has no usable token', async () => {
    const fetchImpl = async () => jsonResponse(200, { workerId: 'w', deviceToken: 'short' });
    const r = await pairWithServer({
      apiUrl: 'https://x',
      pairingCode: 'CODE1',
      version: '1',
      gpu,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r).toMatchObject({ ok: false, error: 'bad_response' });
  });
});

describe('WorkerApiClient', () => {
  it('sends the device token as a bearer token', async () => {
    const fetchImpl = vi.fn(async (_u: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer secret-token');
      return jsonResponse(200, { paused: true });
    });
    const client = new WorkerApiClient({
      baseUrl: 'https://x',
      token: 'secret-token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const r = await client.status({
      workerVersion: '1',
      startedAt: 'now',
      ollamaUp: true,
      models: { llm: 'unloaded', image: 'unloaded' },
      gpu: null,
    });
    expect(r.paused).toBe(true);
  });

  it('surfaces a revoked token as an ApiError with the status', async () => {
    const fetchImpl = async () =>
      jsonResponse(401, { error: { code: 'unauthorized', message: 'revoked' } });
    const client = new WorkerApiClient({
      baseUrl: 'https://x',
      token: 't',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(
      client.status({
        workerVersion: '1',
        startedAt: 'now',
        ollamaUp: true,
        models: { llm: 'a', image: 'b' },
        gpu: null,
      }),
    ).rejects.toMatchObject({ status: 401, code: 'unauthorized' });
  });

  it('copes with a non-JSON error page', async () => {
    const fetchImpl = async () => new Response('<html>bad gateway</html>', { status: 502 });
    const client = new WorkerApiClient({
      baseUrl: 'https://x',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(
      client.pair({
        pairingCode: 'CODE1',
        workerVersion: '1',
        hostname: 'h',
        os: 'o',
        gpu: null,
      }),
    ).rejects.toBeInstanceOf(ApiError);
  });
});

describe('heartbeat', () => {
  function setup() {
    const events = new Events();
    const gpu = new FakeGpu();
    const runner = new GpuStageRunner({
      llm: new FakeLlm(events, gpu),
      image: new FakeImage(events, gpu),
      gpu,
      requireGpu: true,
    });
    return { gpu, runner };
  }

  it('builds a status the API schema accepts', async () => {
    const { gpu, runner } = setup();
    const status = await buildStatus({
      client: new WorkerApiClient({ baseUrl: 'https://x' }),
      version: '0.1.0',
      startedAt: '2026-11-11T00:00:00Z',
      runner,
      gpu,
      ollamaUp: async () => true,
      dataDir: process.cwd(),
    });
    expect(WorkerStatusRequest.safeParse(status).success).toBe(true);
    expect(status.gpu?.totalMiB).toBe(12282);
    expect(status.models).toEqual({ llm: 'unloaded', image: 'unloaded' });
  });

  it('keeps going when the API is unreachable and reconnects later', async () => {
    const { gpu, runner } = setup();
    let up = false;
    const calls: boolean[] = [];
    const fetchImpl = async () => {
      calls.push(up);
      if (!up) throw new Error('offline');
      return jsonResponse(200, {});
    };
    const stop = startHeartbeat(
      {
        client: new WorkerApiClient({
          baseUrl: 'https://x',
          token: 't',
          fetchImpl: fetchImpl as unknown as typeof fetch,
        }),
        version: '1',
        startedAt: 'now',
        runner,
        gpu,
        ollamaUp: async () => true,
        dataDir: process.cwd(),
      },
      10,
    );
    await new Promise((r) => setTimeout(r, 60));
    up = true;
    await new Promise((r) => setTimeout(r, 60));
    stop();
    expect(calls.some((c) => !c)).toBe(true);
    expect(calls.some((c) => c)).toBe(true);
  });
});

describe('shared worker contract', () => {
  it('requires a long enough token', () => {
    expect(WorkerPairResponse.safeParse({ workerId: 'w', deviceToken: 'short' }).success).toBe(
      false,
    );
    expect(
      WorkerPairResponse.safeParse({ workerId: 'w', deviceToken: 'a-long-enough-token' }).success,
    ).toBe(true);
  });
});
