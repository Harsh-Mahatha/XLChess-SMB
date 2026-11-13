export type DownloadErrorCode = 'host_not_allowed' | 'too_large' | 'http_error' | 'network';

export class ImageDownloadError extends Error {
  constructor(
    readonly code: DownloadErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ImageDownloadError';
  }
}

export interface DownloadedFile {
  bytes: Uint8Array;
  contentType: string;
}

export interface DownloadOptions {
  /** Only these hosts may be fetched, so a provider response cannot point us at anything else. */
  allowedHosts: readonly string[];
  maxBytes: number;
}

export interface ImageDownloader {
  download(url: string, opts: DownloadOptions): Promise<DownloadedFile>;
}

export interface HttpDownloaderOptions {
  userAgent: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** Plain HTTPS download with a host allowlist, no redirects and a hard size cap. */
export class HttpImageDownloader implements ImageDownloader {
  constructor(private readonly opts: HttpDownloaderOptions) {}

  async download(
    url: string,
    { allowedHosts, maxBytes }: DownloadOptions,
  ): Promise<DownloadedFile> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new ImageDownloadError('host_not_allowed', `not a valid URL: ${url}`);
    }
    if (parsed.protocol !== 'https:' || !allowedHosts.includes(parsed.hostname.toLowerCase())) {
      throw new ImageDownloadError(
        'host_not_allowed',
        `downloads from ${parsed.host} are not allowed`,
      );
    }
    let res: Response;
    try {
      res = await (this.opts.fetchImpl ?? fetch)(url, {
        headers: { 'user-agent': this.opts.userAgent, accept: 'image/*' },
        redirect: 'manual',
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 60_000),
      });
    } catch (err) {
      throw new ImageDownloadError('network', `request to ${url} failed: ${String(err)}`);
    }
    if (!res.ok) throw new ImageDownloadError('http_error', `HTTP ${res.status} from ${url}`);
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new ImageDownloadError('too_large', `file is ${declared} bytes (limit ${maxBytes})`);
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      const reader = res.body?.getReader();
      if (!reader) throw new ImageDownloadError('http_error', `empty body from ${url}`);
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new ImageDownloadError('too_large', `file exceeds ${maxBytes} bytes`);
        }
        chunks.push(value);
      }
    } catch (err) {
      if (err instanceof ImageDownloadError) throw err;
      throw new ImageDownloadError('network', `reading ${url} failed: ${String(err)}`);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      bytes.set(c, offset);
      offset += c.byteLength;
    }
    return { bytes, contentType: res.headers.get('content-type') ?? 'application/octet-stream' };
  }
}
