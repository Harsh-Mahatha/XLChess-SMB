import {
  WorkerPairResponse,
  WorkerStatusResponse,
  type WorkerPairRequest,
  type WorkerStatusRequest,
} from '@smb/shared';

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

  private async post(path: string, body: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.o.token ? { authorization: `Bearer ${this.o.token}` } : {}),
        },
        body: JSON.stringify(body),
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
    return json;
  }

  async pair(req: WorkerPairRequest): Promise<WorkerPairResponse> {
    const parsed = WorkerPairResponse.safeParse(await this.post('/worker/v1/pair', req));
    if (!parsed.success)
      throw new ApiError(502, 'bad_response', 'the server sent an invalid pairing reply');
    return parsed.data;
  }

  async status(req: WorkerStatusRequest): Promise<WorkerStatusResponse> {
    const parsed = WorkerStatusResponse.safeParse(
      (await this.post('/worker/v1/status', req)) ?? {},
    );
    return parsed.success ? parsed.data : {};
  }
}
