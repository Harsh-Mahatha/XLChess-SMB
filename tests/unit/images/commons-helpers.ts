import { loadConfigSet } from '../../../apps/api/src/config/loader.js';
import {
  createImageRuntimes,
  type ImageSourceRuntime,
} from '../../../apps/api/src/images/index.js';

export type Route = (url: URL) => unknown;

/** Fake fetch: the handler maps a request to a JSON body (or undefined for 404, or an Error to fail). */
export function routedFetch(route: Route) {
  const calls: URL[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(url);
    const out = route(url);
    if (out instanceof Error) throw out;
    if (out === undefined) return new Response('not found', { status: 404 });
    return new Response(typeof out === 'string' ? out : JSON.stringify(out), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { impl, calls };
}

/** The I1 runtime wired to a fake fetch, with no real waiting. */
export function commonsRuntime(fetchImpl: typeof fetch): ImageSourceRuntime {
  const registry = structuredClone(loadConfigSet().sources);
  for (const s of registry.sources) if (s.kind === 'image') s.limits.minIntervalMs = 0;
  const runtimes = createImageRuntimes(registry, {
    userAgent: 'test-agent',
    fetchImpl,
    sleep: async () => undefined,
  });
  return runtimes.get('I1')!;
}

interface PageOptions {
  license?: string | null;
  licenseUrl?: string | null;
  artist?: string | null;
  credit?: string | null;
  restrictions?: string;
  nonFree?: boolean;
  attributionRequired?: boolean;
  taken?: string;
  mime?: string;
  width?: number;
  height?: number;
  sha1?: string;
}

const meta = (value: string | null | undefined) =>
  value === null || value === undefined ? undefined : { value, source: 'commons-desc-page' };

/** One page of an imageinfo response, the way Commons returns it (formatversion 2). */
export function filePage(title: string, o: PageOptions = {}) {
  const ext: Record<string, unknown> = {};
  const set = (k: string, v: string | null | undefined) => {
    const m = meta(v);
    if (m) ext[k] = m;
  };
  set('LicenseShortName', o.license === undefined ? 'CC BY-SA 4.0' : o.license);
  set(
    'LicenseUrl',
    o.licenseUrl === undefined ? 'https://creativecommons.org/licenses/by-sa/4.0' : o.licenseUrl,
  );
  set(
    'Artist',
    o.artist === undefined
      ? '<a href="//commons.wikimedia.org/wiki/User:Jane">Jane Doe</a>'
      : o.artist,
  );
  set('Credit', o.credit);
  set('Restrictions', o.restrictions);
  set('NonFree', o.nonFree ? 'true' : undefined);
  set(
    'AttributionRequired',
    o.attributionRequired === undefined ? 'true' : String(o.attributionRequired),
  );
  set('DateTimeOriginal', o.taken ?? '2026-06-01 12:00:00');
  const file = title.replace(/^File:/, '').replace(/ /g, '_');
  return {
    pageid: 1,
    ns: 6,
    title,
    imageinfo: [
      {
        url: `https://upload.wikimedia.org/wikipedia/commons/a/ab/${file}`,
        descriptionurl: `https://commons.wikimedia.org/wiki/${title.replace(/ /g, '_')}`,
        width: o.width ?? 3000,
        height: o.height ?? 2000,
        size: 900000,
        mime: o.mime ?? 'image/jpeg',
        sha1: o.sha1 ?? 'a'.repeat(40),
        extmetadata: ext,
      },
    ],
  };
}

export const imageInfoResponse = (...pages: ReturnType<typeof filePage>[]) => ({
  batchcomplete: true,
  query: { pages },
});

export const entityResponse = (id: string, claims: Record<string, unknown[]>) => ({
  entities: { [id]: { id, claims } },
});

export const claim = (value: unknown, rank = 'normal') => ({
  rank,
  mainsnak: { snaktype: 'value', datavalue: { value, type: 'string' } },
});
