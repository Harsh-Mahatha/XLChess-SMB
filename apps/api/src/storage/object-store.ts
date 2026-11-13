/**
 * Where media files live (Supabase Storage in production). Buckets are private and only the API's service
 * role reaches them. Paths are content-addressed, so writing the same bytes twice is harmless.
 */
export interface ObjectStore {
  /** Stores the bytes. Succeeds without change if the same path already holds an object. */
  put(bucket: string, path: string, bytes: Uint8Array, contentType: string): Promise<void>;
  /** The stored bytes, or undefined when there is no such object. */
  get(bucket: string, path: string): Promise<Uint8Array | undefined>;
  /** Removes the object (retention). Returns false when there was nothing to remove; never fails for that. */
  remove(bucket: string, path: string): Promise<boolean>;
}

export class StorageError extends Error {
  constructor(
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'StorageError';
  }
}

/** For tests and dry runs. */
export class InMemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, { bytes: Uint8Array; contentType: string }>();

  private key(bucket: string, path: string): string {
    return `${bucket}/${path}`;
  }

  async put(bucket: string, path: string, bytes: Uint8Array, contentType: string): Promise<void> {
    const k = this.key(bucket, path);
    if (!this.objects.has(k)) this.objects.set(k, { bytes: new Uint8Array(bytes), contentType });
  }

  async get(bucket: string, path: string): Promise<Uint8Array | undefined> {
    return this.objects.get(this.key(bucket, path))?.bytes;
  }

  async remove(bucket: string, path: string): Promise<boolean> {
    return this.objects.delete(this.key(bucket, path));
  }
}

export interface SupabaseStoreOptions {
  /** Project URL, for example https://abc.supabase.co */
  url: string;
  serviceRoleKey: string;
  fetchImpl?: typeof fetch;
}

const encodePath = (p: string): string => p.split('/').map(encodeURIComponent).join('/');

/** Supabase Storage over its REST API with the service-role key. */
export class SupabaseObjectStore implements ObjectStore {
  private readonly base: string;
  private readonly doFetch: typeof fetch;

  constructor(private readonly opts: SupabaseStoreOptions) {
    this.base = `${opts.url.replace(/\/+$/, '')}/storage/v1`;
    this.doFetch = opts.fetchImpl ?? fetch;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      authorization: `Bearer ${this.opts.serviceRoleKey}`,
      apikey: this.opts.serviceRoleKey,
      ...extra,
    };
  }

  async put(bucket: string, path: string, bytes: Uint8Array, contentType: string): Promise<void> {
    const res = await this.doFetch(`${this.base}/object/${bucket}/${encodePath(path)}`, {
      method: 'POST',
      headers: this.headers({ 'content-type': contentType, 'x-upsert': 'false' }),
      body: Buffer.from(bytes),
    });
    if (res.ok) return;
    const body = await res.text().catch(() => '');
    // Storage answers a repeated write of an existing path with 400/409 "Duplicate". The path is the
    // hash of the content, so what is there already is what we meant to write.
    if ((res.status === 400 || res.status === 409) && /duplicate|already exists/i.test(body))
      return;
    throw new StorageError(`storing ${bucket}/${path} failed (HTTP ${res.status})`, body);
  }

  async get(bucket: string, path: string): Promise<Uint8Array | undefined> {
    const res = await this.doFetch(
      `${this.base}/object/authenticated/${bucket}/${encodePath(path)}`,
      { headers: this.headers() },
    );
    if (res.status === 404 || res.status === 400) return undefined;
    if (!res.ok) throw new StorageError(`reading ${bucket}/${path} failed (HTTP ${res.status})`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async remove(bucket: string, path: string): Promise<boolean> {
    const res = await this.doFetch(`${this.base}/object/${bucket}/${encodePath(path)}`, {
      method: 'DELETE',
      headers: this.headers(),
    });
    if (res.ok) return true;
    // Storage answers 400/404 "not found" for an object that is already gone.
    if (res.status === 404 || res.status === 400) return false;
    throw new StorageError(`removing ${bucket}/${path} failed (HTTP ${res.status})`);
  }
}
