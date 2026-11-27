import { z } from 'zod';
import {
  ClaimedJob,
  CompleteResponse,
  HeartbeatResponse,
  WorkerConfigResponse,
  WorkerPairResponse,
  WorkerStatusResponse,
  type ClaimRequest,
  type CompleteRequest,
  type FailRequest,
  type HeartbeatRequest,
  type WorkerPairRequest,
  type WorkerStatusRequest,
} from '@smb/shared';

const FailResponse = z.object({ outcome: z.string() });

/** The server said no in a way the owner can act on (wrong, expired or used pairing code). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ApiClientOptions {
  baseUrl: string;
  /** Device token; absent only for the pairing call. */
  token?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** Outbound-only HTTPS client for /worker/v1/*. The worker never listens for inbound connections. */
export class WorkerApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly o: ApiClientOptions) {
    this.baseUrl = o.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = o.fetchImpl ?? fetch;
    this.timeoutMs = o.timeoutMs ?? 20_000;
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: unknown }> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(this.o.token ? { authorization: `Bearer ${this.o.token}` } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new ApiError(0, 'network', `cannot reach ${this.baseUrl}: ${String(err)}`);
    }
    const text = await res.text();
    let json: unknown = undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      /* non-JSON error page */
    }
    if (!res.ok) {
      const err = (json as { error?: { code?: string; message?: string } } | undefined)?.error;
      throw new ApiError(
        res.status,
        err?.code ?? `http_${res.status}`,
        err?.message ?? `HTTP ${res.status}`,
      );
    }
    return { status: res.status, json };
  }

  private async get(path: string): Promise<{ status: number; json: unknown }> {
    return this.request('GET', path);
  }

  private async post(path: string, body: unknown): Promise<{ status: number; json: unknown }> {
    return this.request('POST', path, body);
  }

  private parse<T>(schema: z.ZodType<T>, data: unknown, what: string): T {
    const parsed = schema.safeParse(data);
    if (!parsed.success) {
      throw new ApiError(502, 'bad_response', `the server sent an invalid ${what} reply`);
    }
    return parsed.data;
  }

  async pair(req: WorkerPairRequest): Promise<WorkerPairResponse> {
    const { json } = await this.post('/worker/v1/pair', req);
    return this.parse(WorkerPairResponse, json, 'pairing');
  }

  async status(req: WorkerStatusRequest): Promise<WorkerStatusResponse> {
    const { json } = await this.post('/worker/v1/status', req);
    const parsed = WorkerStatusResponse.safeParse(json ?? {});
    return parsed.success ? parsed.data : {};
  }

  async config(): Promise<WorkerConfigResponse> {
    const { json } = await this.get('/worker/v1/config');
    return this.parse(WorkerConfigResponse, json, 'config');
  }

  async claim(req: ClaimRequest): Promise<ClaimedJob | null> {
    const { status, json } = await this.post('/worker/v1/jobs/claim', req);
    if (status === 204) return null;
    return this.parse(ClaimedJob, json, 'claim');
  }

  async heartbeat(jobId: string, req: HeartbeatRequest): Promise<HeartbeatResponse> {
    const { json } = await this.post(`/worker/v1/jobs/${jobId}/heartbeat`, req);
    return this.parse(HeartbeatResponse, json, 'heartbeat');
  }

  async complete(jobId: string, req: CompleteRequest): Promise<CompleteResponse> {
    const { json } = await this.post(`/worker/v1/jobs/${jobId}/complete`, req);
    return this.parse(CompleteResponse, json, 'complete');
  }

  async fail(jobId: string, req: FailRequest): Promise<{ outcome: string }> {
    const { json } = await this.post(`/worker/v1/jobs/${jobId}/fail`, req);
    return this.parse(FailResponse, json, 'fail');
  }
}
