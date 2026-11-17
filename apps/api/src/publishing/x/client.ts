import { oauth1Header } from './oauth1.js';
import type { XCredentials } from '../types.js';

export interface XClientOptions {
  baseUrl: string;
  creds: XCredentials;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export interface XResponse {
  status: number;
  headers: Headers;
  body: unknown;
}

export class XRequestError extends Error {
  constructor(
    message: string,
    readonly isTimeout: boolean = false,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'XRequestError';
  }
}

export class XClient {
  private readonly baseUrl: string;
  private readonly creds: XCredentials;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: XClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.creds = options.creds;
    this.timeoutMs = options.timeoutMs;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private buildUrl(path: string, query?: Record<string, string>): URL {
    const fullPath = path.startsWith('http')
      ? path
      : `${this.baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;
    const url = new URL(fullPath);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        url.searchParams.set(k, v);
      }
    }
    return url;
  }

  private combineSignals(signal?: AbortSignal): { signal: AbortSignal; cleanup: () => void } {
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    if (!signal) {
      return { signal: timeoutSignal, cleanup: () => {} };
    }
    const combined = AbortSignal.any([timeoutSignal, signal]);
    return { signal: combined, cleanup: () => {} };
  }

  private async execute(
    method: 'GET' | 'POST',
    url: URL,
    headers: Record<string, string>,
    body?: BodyInit,
    signal?: AbortSignal,
  ): Promise<XResponse> {
    const authHeader = oauth1Header({
      method,
      url: url.toString(),
      creds: this.creds,
    });

    const requestHeaders = {
      ...headers,
      Authorization: authHeader,
    };

    const { signal: combinedSignal } = this.combineSignals(signal);

    try {
      const res = await this.fetchImpl(url.toString(), {
        method,
        headers: requestHeaders,
        body,
        signal: combinedSignal,
        redirect: 'error',
      });

      const contentType = res.headers.get('content-type') || '';
      let parsedBody: unknown;

      if (contentType.includes('application/json')) {
        try {
          parsedBody = await res.json();
        } catch {
          parsedBody = null;
        }
      } else {
        try {
          const text = await res.text();
          parsedBody = text.slice(0, 500);
        } catch {
          parsedBody = null;
        }
      }

      return {
        status: res.status,
        headers: res.headers,
        body: parsedBody,
      };
    } catch (err: unknown) {
      const error = err as Error;
      const isTimeout =
        error.name === 'TimeoutError' ||
        error.name === 'AbortError' ||
        error.message.toLowerCase().includes('timeout') ||
        error.message.toLowerCase().includes('aborted');

      throw new XRequestError(
        isTimeout
          ? `X API request timed out after ${this.timeoutMs}ms`
          : `X API network error: ${error.message}`,
        isTimeout,
        err,
      );
    }
  }

  async postJson(path: string, body: unknown, signal?: AbortSignal): Promise<XResponse> {
    const url = this.buildUrl(path);
    return this.execute(
      'POST',
      url,
      {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      JSON.stringify(body),
      signal,
    );
  }

  async postMultipart(path: string, form: FormData, signal?: AbortSignal): Promise<XResponse> {
    const url = this.buildUrl(path);
    // Do not set Content-Type so fetch sets boundary
    return this.execute(
      'POST',
      url,
      {
        Accept: 'application/json',
      },
      form,
      signal,
    );
  }

  async get(
    path: string,
    query?: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<XResponse> {
    const url = this.buildUrl(path, query);
    return this.execute(
      'GET',
      url,
      {
        Accept: 'application/json',
      },
      undefined,
      signal,
    );
  }
}
