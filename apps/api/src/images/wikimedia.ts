import { z } from 'zod';
import { ImageCandidate, type ImageSubject, type MatchKind } from '@smb/shared';
import { SourceError } from '../sources/errors.js';
import type { ImageAdapterContext, ImageSourceAdapter } from './types.js';

export const WIKIMEDIA_SOURCE_ID = 'I1';
export const WIKIMEDIA_ADAPTER_VERSION = 'wikimedia-commons/1.0.0';
const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';
const FIDE_ID_PROPERTY = 'P1440';
const IMAGE_PROPERTY = 'P18';
const COMMONS_CATEGORY_PROPERTY = 'P373';
const MAX_TITLES_PER_REQUEST = 20;

const EXTMETADATA_FIELDS = [
  'LicenseShortName',
  'LicenseUrl',
  'UsageTerms',
  'Artist',
  'Credit',
  'Attribution',
  'AttributionRequired',
  'Restrictions',
  'NonFree',
  'DateTimeOriginal',
];

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** Commons gives authors and credits as HTML. Keep only the words. */
export function htmlToText(html: string | undefined): string {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e.startsWith('#x')) return String.fromCodePoint(parseInt(e.slice(2), 16));
      if (e.startsWith('#')) return String.fromCodePoint(parseInt(e.slice(1), 10));
      return NAMED_ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

const Meta = z
  .object({ value: z.union([z.string(), z.number(), z.boolean()]).optional() })
  .passthrough();

const ImageInfoPage = z
  .object({
    title: z.string(),
    missing: z.boolean().optional(),
    imageinfo: z
      .array(
        z
          .object({
            url: z.string().url(),
            descriptionurl: z.string().url(),
            width: z.number().int().positive(),
            height: z.number().int().positive(),
            size: z.number().int().nonnegative().optional(),
            mime: z.string(),
            sha1: z.string().optional(),
            extmetadata: z.record(z.string(), Meta).optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

// Pages are checked one by one below, so a single badly described file cannot hide the others.
const ImageInfoResponse = z.object({
  query: z.object({ pages: z.array(z.unknown()) }).passthrough(),
});
const TitleList = z.object({ title: z.string() }).passthrough();
const SearchResponse = z.object({
  query: z.object({ search: z.array(TitleList) }).passthrough(),
});
const CategoryResponse = z.object({
  query: z.object({ categorymembers: z.array(TitleList) }).passthrough(),
});
const EntityResponse = z.object({
  entities: z.record(
    z.string(),
    z
      .object({
        claims: z
          .record(
            z.string(),
            z.array(
              z
                .object({
                  rank: z.string().optional(),
                  mainsnak: z
                    .object({
                      datavalue: z.object({ value: z.unknown() }).passthrough().optional(),
                    })
                    .passthrough(),
                })
                .passthrough(),
            ),
          )
          .optional(),
      })
      .passthrough(),
  ),
});

function parseJson<T>(schema: z.ZodType<T>, text: string, what: string): T {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new SourceError('invalid_response', WIKIMEDIA_SOURCE_ID, `${what}: response is not JSON`);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new SourceError('invalid_response', WIKIMEDIA_SOURCE_ID, `${what}: unexpected response`, {
      issues: parsed.error.issues.slice(0, 5),
    });
  }
  return parsed.data;
}

const qs = (params: Record<string, string | number>): string =>
  Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&');

const str = (m: z.infer<typeof Meta> | undefined): string | undefined => {
  if (m?.value === undefined) return undefined;
  const s = String(m.value).trim();
  return s === '' ? undefined : s;
};

/** Claim values of one Wikidata property, preferred rank first. Deprecated statements are ignored. */
function claimValues(
  claims:
    Record<string, { rank?: string; mainsnak: { datavalue?: { value?: unknown } } }[]> | undefined,
  property: string,
): string[] {
  const list = (claims?.[property] ?? []).filter((c) => c.rank !== 'deprecated');
  list.sort((a, b) => Number(b.rank === 'preferred') - Number(a.rank === 'preferred'));
  return list.flatMap((c) => {
    const v = c.mainsnak.datavalue?.value;
    return typeof v === 'string' && v.trim() ? [v.trim()] : [];
  });
}

async function getJson<T>(
  ctx: ImageAdapterContext,
  url: string,
  schema: z.ZodType<T>,
  what: string,
): Promise<T> {
  const res = await ctx.http.get(url, { accept: 'application/json' });
  return parseJson(schema, res.text, what);
}

/** File pages and their licence facts for a list of file titles. */
async function fetchImageInfo(
  ctx: ImageAdapterContext,
  titles: string[],
  subject: ImageSubject,
  matches: Map<string, MatchKind>,
): Promise<ImageCandidate[]> {
  const out: ImageCandidate[] = [];
  for (let i = 0; i < titles.length; i += MAX_TITLES_PER_REQUEST) {
    const batch = titles.slice(i, i + MAX_TITLES_PER_REQUEST);
    const url = `${ctx.baseUrl}?${qs({
      action: 'query',
      titles: batch.join('|'),
      prop: 'imageinfo',
      iiprop: 'url|size|mime|sha1|extmetadata',
      iiextmetadatafilter: EXTMETADATA_FIELDS.join('|'),
      format: 'json',
      formatversion: 2,
    })}`;
    const data = await getJson(ctx, url, ImageInfoResponse, 'imageinfo');
    for (const raw of data.query.pages) {
      const checked = ImageInfoPage.safeParse(raw);
      if (!checked.success) continue;
      const page = checked.data;
      const info = page.imageinfo?.[0];
      if (page.missing || !info) continue;
      const meta = info.extmetadata ?? {};
      const author = htmlToText(str(meta.Artist)) || undefined;
      const credit = htmlToText(str(meta.Credit) ?? str(meta.Attribution)) || undefined;
      const takenText = htmlToText(str(meta.DateTimeOriginal));
      const takenAt = takenText && !Number.isNaN(Date.parse(takenText)) ? takenText : undefined;
      const restrictions = (str(meta.Restrictions) ?? '')
        .split(/[,|]/)
        .map((r) => r.trim().toLowerCase())
        .filter(Boolean);
      const candidate = ImageCandidate.safeParse({
        sourceId: WIKIMEDIA_SOURCE_ID,
        externalId: page.title,
        title: page.title.replace(/^File:/, ''),
        pageUrl: info.descriptionurl,
        imageUrl: info.url,
        mime: info.mime,
        width: info.width,
        height: info.height,
        sizeBytes: info.size,
        takenAt,
        match: matches.get(page.title) ?? 'search',
        subject,
        evidence: {
          sourceId: WIKIMEDIA_SOURCE_ID,
          sourceName: 'Wikimedia Commons',
          originalUrl: info.url,
          sourcePageUrl: info.descriptionurl,
          licenceShortName: str(meta.LicenseShortName),
          licenceUrl: str(meta.LicenseUrl),
          usageTerms: htmlToText(str(meta.UsageTerms)) || undefined,
          author: author && author.length <= 200 ? author : undefined,
          copyrightHolder: credit && credit.length <= 200 ? credit : undefined,
          providerRequiresAttribution:
            str(meta.AttributionRequired) === undefined
              ? undefined
              : str(meta.AttributionRequired)?.toLowerCase() === 'true',
          restrictions,
          nonFree: str(meta.NonFree)?.toLowerCase() === 'true',
          raw: { title: page.title, imageinfo: info },
        },
      });
      // A file the provider describes badly is skipped, not guessed at.
      if (candidate.success) out.push(candidate.data);
    }
  }
  return out;
}

/** Wikidata item for a FIDE id. More than one item is ambiguous, so it is treated as no match. */
async function findPlayerItem(
  ctx: ImageAdapterContext,
  fideId: string,
): Promise<string | undefined> {
  const url = `${WIKIDATA_API}?${qs({
    action: 'query',
    list: 'search',
    srsearch: `haswbstatement:${FIDE_ID_PROPERTY}=${fideId}`,
    srlimit: 3,
    format: 'json',
    formatversion: 2,
  })}`;
  const data = await getJson(ctx, url, SearchResponse, 'wikidata search');
  const ids = data.query.search.map((s) => s.title).filter((t) => /^Q\d+$/.test(t));
  return ids.length === 1 ? ids[0] : undefined;
}

async function searchPlayer(
  subject: Extract<ImageSubject, { role: 'player' }>,
  limit: number,
  ctx: ImageAdapterContext,
): Promise<ImageCandidate[]> {
  // Identity comes from the FIDE id. A name alone never selects a photo of a person.
  if (!subject.fideId) return [];
  const item = await findPlayerItem(ctx, subject.fideId);
  if (!item) return [];
  const entity = await getJson(
    ctx,
    `${WIKIDATA_API}?${qs({ action: 'wbgetentities', ids: item, props: 'claims', format: 'json' })}`,
    EntityResponse,
    'wikidata entity',
  );
  const claims = entity.entities[item]?.claims;
  const matches = new Map<string, MatchKind>();
  for (const f of claimValues(claims, IMAGE_PROPERTY)) matches.set(`File:${f}`, 'wikidata_image');

  const category = claimValues(claims, COMMONS_CATEGORY_PROPERTY)[0];
  if (category && matches.size < limit) {
    const members = await getJson(
      ctx,
      `${ctx.baseUrl}?${qs({
        action: 'query',
        list: 'categorymembers',
        cmtitle: `Category:${category}`,
        cmtype: 'file',
        cmlimit: limit,
        format: 'json',
        formatversion: 2,
      })}`,
      CategoryResponse,
      'category members',
    );
    for (const m of members.query.categorymembers) {
      if (!matches.has(m.title)) matches.set(m.title, 'category');
    }
  }
  return fetchImageInfo(ctx, [...matches.keys()].slice(0, limit), subject, matches);
}

async function searchKeywords(
  subject: ImageSubject,
  text: string,
  limit: number,
  ctx: ImageAdapterContext,
): Promise<ImageCandidate[]> {
  const found = await getJson(
    ctx,
    `${ctx.baseUrl}?${qs({
      action: 'query',
      list: 'search',
      srsearch: `${text} filetype:bitmap`,
      srnamespace: 6,
      srlimit: limit,
      format: 'json',
      formatversion: 2,
    })}`,
    SearchResponse,
    'file search',
  );
  const titles = found.query.search.map((s) => s.title);
  return fetchImageInfo(ctx, titles, subject, new Map());
}

export const wikimediaAdapter: ImageSourceAdapter = {
  id: WIKIMEDIA_SOURCE_ID,
  adapterVersion: WIKIMEDIA_ADAPTER_VERSION,
  downloadHosts: ['upload.wikimedia.org'],

  async search({ subject, limit }, ctx) {
    switch (subject.role) {
      case 'player':
        return searchPlayer(subject, limit, ctx);
      case 'event':
        return searchKeywords(subject, subject.name, limit, ctx);
      case 'venue':
        return searchKeywords(
          subject,
          subject.location ? `${subject.name} ${subject.location}` : subject.name,
          limit,
          ctx,
        );
      case 'generic':
        return searchKeywords(subject, subject.keywords, limit, ctx);
    }
  },
};
