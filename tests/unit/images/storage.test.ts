import { describe, expect, it } from 'vitest';
import {
  InMemoryObjectStore,
  StorageError,
  SupabaseObjectStore,
  contentPath,
  sha1Hex,
  sha256Hex,
  sniffImageMime,
} from '../../../apps/api/src/storage/index.js';
import { HttpImageDownloader, ImageDownloadError } from '../../../apps/api/src/images/download.js';

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const WEBP = new Uint8Array([...Buffer.from('RIFF'), 1, 0, 0, 0, ...Buffer.from('WEBPVP8 ')]);

describe('content helpers', () => {
  it('hashes bytes', () => {
    expect(sha256Hex(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(sha1Hex(new TextEncoder().encode('abc'))).toBe(
      'a9993e364706816aba3e25717850c26c9cd0d89d',
    );
  });
  it('tells the real image type from the first bytes', () => {
    expect(sniffImageMime(JPEG)).toBe('image/jpeg');
    expect(sniffImageMime(PNG)).toBe('image/png');
    expect(sniffImageMime(WEBP)).toBe('image/webp');
    expect(sniffImageMime(new TextEncoder().encode('<html>not an image</html>'))).toBeUndefined();
    expect(sniffImageMime(new Uint8Array())).toBeUndefined();
  });
  it('builds content-addressed paths and refuses anything else', () => {
    expect(contentPath('a'.repeat(64), 'jpg')).toBe(`${'a'.repeat(64)}.jpg`);
    expect(() => contentPath('xyz', 'jpg')).toThrow();
    expect(() => contentPath('a'.repeat(64), '../x')).toThrow();
  });
});

describe('InMemoryObjectStore', () => {
  it('stores once and returns the same bytes', async () => {
    const s = new InMemoryObjectStore();
    await s.put('originals', 'p.jpg', JPEG, 'image/jpeg');
    await s.put('originals', 'p.jpg', PNG, 'image/png'); // same path: the first write stands
    expect(await s.get('originals', 'p.jpg')).toEqual(JPEG);
    expect(await s.get('originals', 'other.jpg')).toBeUndefined();
  });
});

describe('SupabaseObjectStore', () => {
  const make = (reply: (url: string, init: RequestInit) => Response) => {
    const calls: { url: string; init: RequestInit }[] = [];
    const store = new SupabaseObjectStore({
      url: 'https://proj.supabase.co/',
      serviceRoleKey: 'service-key',
      fetchImpl: (async (url: string, init: RequestInit) => {
        calls.push({ url: String(url), init });
        return reply(String(url), init);
      }) as typeof fetch,
    });
    return { store, calls };
  };

  it('uploads with the service key to a private bucket path', async () => {
    const { store, calls } = make(() => new Response('{}', { status: 200 }));
    await store.put('originals', 'ab/c d.jpg', JPEG, 'image/jpeg');
    expect(calls[0]!.url).toBe('https://proj.supabase.co/storage/v1/object/originals/ab/c%20d.jpg');
    const h = calls[0]!.init.headers as Record<string, string>;
    expect(h).toMatchObject({
      authorization: 'Bearer service-key',
      'content-type': 'image/jpeg',
      'x-upsert': 'false',
    });
    expect(calls[0]!.init.method).toBe('POST');
  });

  it('accepts a duplicate, because the path is the content hash', async () => {
    const { store } = make(
      () => new Response('{"error":"Duplicate","statusCode":"409"}', { status: 400 }),
    );
    await expect(store.put('originals', 'p.jpg', JPEG, 'image/jpeg')).resolves.toBeUndefined();
  });

  it('throws on other failures', async () => {
    const { store } = make(() => new Response('boom', { status: 500 }));
    await expect(store.put('originals', 'p.jpg', JPEG, 'image/jpeg')).rejects.toBeInstanceOf(
      StorageError,
    );
  });

  it('reads through the authenticated route and maps a missing object to undefined', async () => {
    const { store, calls } = make((url) =>
      url.endsWith('missing.jpg')
        ? new Response('', { status: 404 })
        : new Response(JPEG, { status: 200 }),
    );
    expect(await store.get('originals', 'p.jpg')).toEqual(JPEG);
    expect(calls[0]!.url).toContain('/object/authenticated/originals/p.jpg');
    expect(await store.get('originals', 'missing.jpg')).toBeUndefined();
  });
});

describe('HttpImageDownloader', () => {
  const opts = { allowedHosts: ['upload.wikimedia.org'], maxBytes: 1000 };
  const make = (reply: () => Response) =>
    new HttpImageDownloader({ userAgent: 'ua', fetchImpl: (async () => reply()) as typeof fetch });
  const code = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      return e instanceof ImageDownloadError ? e.code : 'other';
    }
    return 'none';
  };

  it('downloads from an allowed host', async () => {
    const d = make(
      () => new Response(JPEG, { status: 200, headers: { 'content-type': 'image/jpeg' } }),
    );
    const out = await d.download('https://upload.wikimedia.org/a.jpg', opts);
    expect(out.bytes).toEqual(JPEG);
    expect(out.contentType).toBe('image/jpeg');
  });

  it('refuses other hosts, plain http and bad URLs without making a request', async () => {
    let called = 0;
    const d = new HttpImageDownloader({
      userAgent: 'ua',
      fetchImpl: (async () => {
        called++;
        return new Response(JPEG);
      }) as typeof fetch,
    });
    for (const url of ['https://evil.example/a.jpg', 'http://upload.wikimedia.org/a.jpg', 'nope']) {
      expect(await code(d.download(url, opts))).toBe('host_not_allowed');
    }
    expect(called).toBe(0);
  });

  it('refuses redirects, errors and oversize files', async () => {
    const redirect = make(
      () => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }),
    );
    expect(await code(redirect.download('https://upload.wikimedia.org/a.jpg', opts))).toBe(
      'http_error',
    );
    const missing = make(() => new Response('no', { status: 404 }));
    expect(await code(missing.download('https://upload.wikimedia.org/a.jpg', opts))).toBe(
      'http_error',
    );
    const big = make(() => new Response(new Uint8Array(2000), { status: 200 }));
    expect(await code(big.download('https://upload.wikimedia.org/a.jpg', opts))).toBe('too_large');
  });
});
