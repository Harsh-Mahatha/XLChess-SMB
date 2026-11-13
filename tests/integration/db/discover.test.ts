/* eslint-disable @typescript-eslint/no-explicit-any -- JSON column contents are checked loosely */
import { PrismaClient } from '@prisma/client';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { type ImageCandidate, type ImageSubject } from '@smb/shared';
import { loadConfigSet } from '../../../apps/api/src/config/loader.js';
import { syncConfigs } from '../../../apps/api/src/config/sync.js';
import { syncSources } from '../../../apps/api/src/config/sources-sync.js';
import {
  AssetLicenceError,
  ImageDiscoveryError,
  ImageDownloadError,
  ImageNotReadyError,
  assertAssetsLicensed,
  assetLicenceProblem,
  discoverImages,
  listChosenPhotos,
  type ImageDownloader,
  type ImageSourceAdapter,
  type ImageSourceRuntime,
} from '../../../apps/api/src/images/index.js';
import { RateLimiter } from '../../../apps/api/src/sources/limiter.js';
import { InMemoryObjectStore, sha1Hex } from '../../../apps/api/src/storage/index.js';
import { freshDb, rows } from './harness.js';

let pgc: pg.Client;
let prisma: PrismaClient;
let configId: string;
let counter = 0;

const JPEG = (n: number) => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, n, 1, 2, 3, 4, 5, 6, 7]);
const GUKESH: ImageSubject = { role: 'player', name: 'Gukesh D', fideId: '46616543' };

function cand(title: string, over: Record<string, any> = {}): ImageCandidate {
  const { evidence, ...rest } = over;
  return {
    sourceId: 'I1',
    externalId: `File:${title}`,
    title,
    pageUrl: `https://commons.wikimedia.org/wiki/File:${title}`,
    imageUrl: `https://upload.wikimedia.org/wikipedia/commons/a/ab/${title}`,
    mime: 'image/jpeg',
    width: 3000,
    height: 2000,
    match: 'wikidata_image',
    subject: GUKESH,
    evidence: {
      sourceId: 'I1',
      sourceName: 'Wikimedia Commons',
      originalUrl: `https://upload.wikimedia.org/wikipedia/commons/a/ab/${title}`,
      sourcePageUrl: `https://commons.wikimedia.org/wiki/File:${title}`,
      licenceShortName: 'CC BY-SA 4.0',
      licenceUrl: 'https://creativecommons.org/licenses/by-sa/4.0',
      author: 'Jane Doe',
      restrictions: [],
      nonFree: false,
      raw: { imageinfo: { sha1: sha1Hex(JPEG(Number(title.replace(/\D/g, '')) || 0)) } },
      ...evidence,
    },
    ...rest,
  } as ImageCandidate;
}

/** A fake source that returns the given candidates (or throws), and a downloader that serves their bytes. */
function fakeRuntime(
  search: (subject: ImageSubject) => ImageCandidate[] | Error,
  roles: ('player' | 'event' | 'venue' | 'generic')[] = ['player', 'event', 'venue', 'generic'],
) {
  const searched: ImageSubject[] = [];
  const adapter: ImageSourceAdapter = {
    id: 'I1',
    adapterVersion: 'fake/1',
    downloadHosts: ['upload.wikimedia.org'],
    async search({ subject }) {
      searched.push(subject);
      const out = search(subject);
      if (out instanceof Error) throw out;
      return out;
    },
  };
  const entry: any = loadConfigSet().sources.sources.find((s) => s.id === 'I1');
  const runtime: ImageSourceRuntime = {
    entry: { ...entry, roles },
    adapter,
    ctx: { http: undefined as never, limits: entry.limits, baseUrl: entry.access.baseUrl },
    limiter: new RateLimiter({ maxConcurrent: 1, minIntervalMs: 0 }),
  };
  return { runtimes: new Map([['I1', runtime]]), searched };
}

function fakeDownloader(
  files: Record<string, Uint8Array | Error>,
): ImageDownloader & { urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    async download(url) {
      urls.push(url);
      const f = files[url.split('/').pop()!];
      if (!f) throw new ImageDownloadError('http_error', 'HTTP 404');
      if (f instanceof Error) throw f;
      return { bytes: f, contentType: 'image/jpeg' };
    },
  };
}

interface ClaimSeed {
  key: string;
  value: unknown;
}
const defaultClaims: ClaimSeed[] = [
  {
    key: 'participants',
    value: [
      { name: 'Gukesh D', fideId: '46616543' },
      { name: 'Sindarov J', fideId: '14204118' },
    ],
  },
  { key: 'event.name', value: 'World Championship 2026' },
  { key: 'event.venue', value: 'Singapore' },
  { key: 'game.result', value: { result: '1-0', white: 'Gukesh D', black: 'Sindarov J' } },
];

async function opportunity(
  opts: { status?: string; claims?: ClaimSeed[]; withPackage?: boolean } = {},
) {
  const n = ++counter;
  const [o] = await rows<{ id: string }>(
    pgc,
    `insert into smb.post_opportunities (post_type_id, post_config_id, dedupe_key, trigger_kind, phase)
     values ('1.1', $1, $2, 'manual', 'tournament') returning id`,
    [opts.config ?? configId, `test:1.8:${n}`],
  );
  if (opts.withPackage !== false) {
    const [p] = await rows<{ id: string }>(
      pgc,
      `insert into smb.research_packages (opportunity_id, version, status, summary)
       values ($1, 1, 'complete', '{}') returning id`,
      [o!.id],
    );
    for (const c of opts.claims ?? defaultClaims) {
      await pgc.query(
        `insert into smb.research_claims (package_id, claim_key, description, value, verification, confidence)
         values ($1, $2, $2, $3::jsonb, 'verified', 0.9)`,
        [p!.id, c.key, JSON.stringify(c.value)],
      );
    }
  }
  await pgc.query('update smb.post_opportunities set status = $2 where id = $1', [
    o!.id,
    opts.status ?? 'generating',
  ]);
  return o!.id;
}

const make = (
  runtime: ReturnType<typeof fakeRuntime>,
  downloader: ImageDownloader,
  store = new InMemoryObjectStore(),
) => ({ db: prisma, runtimes: runtime.runtimes, store, downloader });

beforeAll(async () => {
  pgc = await freshDb();
  prisma = new PrismaClient({ datasourceUrl: `${inject('dbUrl')}?schema=smb` });
  const set = loadConfigSet();
  await syncSources(prisma, set.sources);
  await syncConfigs(prisma, set);
  const [active] = await rows<{ id: string }>(
    pgc,
    "select id from smb.post_configs where post_type_id = '1.1' and is_active",
  );
  configId = active!.id;
});
afterAll(async () => {
  await prisma.$disconnect();
  await pgc.end();
});

describe('discoverImages', () => {
  it('stores the best licensed photo with its licence, credit, evidence and a content-addressed file', async () => {
    const opp = await opportunity();
    const rt = fakeRuntime((s) =>
      s.role === 'player' && s.name === 'Gukesh D' ? [cand('Gukesh1.jpg')] : [],
    );
    const store = new InMemoryObjectStore();
    const dl = fakeDownloader({ 'Gukesh1.jpg': JPEG(1) });
    const out = await discoverImages(make(rt, dl, store), opp);

    expect(out).toMatchObject({
      status: 'found',
      created: true,
      needsHuman: false,
      considered: 1,
      rejected: 0,
    });
    expect(out.chosen).toHaveLength(1);
    const photo = out.chosen[0]!;
    expect(photo).toMatchObject({
      title: 'Gukesh1.jpg',
      licence: 'CC BY-SA 4.0',
      shareAlike: true,
      attributionText: 'Photo: Jane Doe / Wikimedia Commons, CC BY-SA 4.0',
    });

    // The file is in storage under its own hash, and the asset row records it.
    const [asset] = await rows<any>(pgc, 'select * from smb.media_assets where id = $1', [
      photo.assetId,
    ]);
    expect(asset).toMatchObject({
      kind: 'original',
      bucket: 'originals',
      sha256: photo.sha256,
      path: `${photo.sha256}.jpg`,
      image_source_id: 'I1',
      source_url: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Gukesh1.jpg',
      opportunity_id: opp,
    });
    expect(Number(asset.size_bytes)).toBe(JPEG(1).byteLength);
    expect(await store.get('originals', asset.path)).toEqual(JPEG(1));

    // The licence row has everything the guide lists, and points at saved evidence.
    const [lic] = await rows<any>(pgc, 'select * from smb.media_licenses where id = $1', [
      photo.licenseId,
    ]);
    expect(lic).toMatchObject({
      asset_id: photo.assetId,
      photographer: 'Jane Doe',
      licence_type: 'CC BY-SA',
      licence_version: '4.0',
      licence_url: 'https://creativecommons.org/licenses/by-sa/4.0',
      commercial_use_allowed: true,
      modifications_allowed: true,
      attribution_required: true,
      share_alike: true,
      decision: 'accepted',
      verified_by: 'system',
      policy_version: 'licence-policy@1.0.0',
    });
    expect(lic.other_obligations).toMatch(/CC BY-SA 4.0/);
    const [ev] = await rows<any>(pgc, 'select * from smb.media_assets where id = $1', [
      lic.evidence_asset_id,
    ]);
    expect(ev).toMatchObject({ kind: 'evidence', bucket: 'evidence' });
    const doc = JSON.parse(new TextDecoder().decode((await store.get('evidence', ev.path))!));
    expect(doc.evidence.licenceShortName).toBe('CC BY-SA 4.0');
    expect(doc.assessment.decision).toBe('accepted');

    // And the database agrees the photo may be used.
    expect(await assetLicenceProblem(prisma, photo.assetId)).toBeNull();
    await expect(assertAssetsLicensed(prisma, [photo.assetId])).resolves.toBeUndefined();
    expect((await listChosenPhotos(prisma, opp)).map((p) => p.assetId)).toEqual([photo.assetId]);
  });

  it('logs rejected photos without downloading them, and never lets them be chosen', async () => {
    const opp = await opportunity();
    const nc = {
      evidence: {
        licenceShortName: 'CC BY-NC 4.0',
        licenceUrl: 'https://creativecommons.org/licenses/by-nc/4.0/',
      },
    };
    const rt = fakeRuntime((s) =>
      s.role === 'player' && s.name === 'Gukesh D'
        ? [
            cand('Nc2.jpg', { ...nc, match: 'wikidata_image' }),
            cand('NoAuthor3.jpg', { evidence: { author: undefined }, match: 'category' }),
          ]
        : [],
    );
    const dl = fakeDownloader({});
    const out = await discoverImages(make(rt, dl), opp);
    expect(out).toMatchObject({
      status: 'none_found',
      needsHuman: false,
      considered: 2,
      rejected: 2,
    });
    expect(dl.urls).toEqual([]);

    const log = await rows<any>(
      pgc,
      'select title, decision, rejection_codes, decision_reason, chosen, asset_id from smb.image_candidates where opportunity_id = $1 order by title',
      [opp],
    );
    expect(log).toEqual([
      expect.objectContaining({
        title: 'Nc2.jpg',
        decision: 'rejected',
        rejection_codes: ['non_commercial'],
        chosen: false,
        asset_id: null,
      }),
      expect.objectContaining({
        title: 'NoAuthor3.jpg',
        decision: 'rejected',
        rejection_codes: ['no_author'],
        chosen: false,
        asset_id: null,
      }),
    ]);
    expect(log[0].decision_reason).toMatch(/commercial/);
    const assets = await rows(pgc, 'select 1 from smb.media_assets where opportunity_id = $1', [
      opp,
    ]);
    expect(assets).toHaveLength(0);
  });

  it('skips a photo that licenses fine but is too small, and one found only by name', async () => {
    const opp = await opportunity();
    const rt = fakeRuntime((s) =>
      s.role === 'player' && s.name === 'Gukesh D'
        ? [cand('Tiny4.jpg', { width: 600, height: 400 }), cand('ByName5.jpg', { match: 'search' })]
        : [],
    );
    const dl = fakeDownloader({});
    const out = await discoverImages(make(rt, dl), opp);
    expect(out.status).toBe('none_found');
    expect(dl.urls).toEqual([]);
    const log = await rows<any>(
      pgc,
      'select title, decision, eligible, score_detail from smb.image_candidates where opportunity_id = $1',
      [opp],
    );
    expect(log.every((r) => r.decision === 'accepted' && r.eligible === false)).toBe(true);
    expect(log.find((r) => r.title === 'Tiny4.jpg').score_detail.rejections).toEqual(['too_small']);
    expect(log.find((r) => r.title === 'ByName5.jpg').score_detail.rejections).toEqual([
      'weak_identity',
    ]);
  });

  it('keeps one photo per subject and falls back to the next when a download fails', async () => {
    const opp = await opportunity();
    const rt = fakeRuntime((s) => {
      if (s.role === 'player' && s.name === 'Gukesh D')
        return [cand('Best6.jpg'), cand('Second7.jpg', { match: 'category' })];
      if (s.role === 'event') return [cand('Hall8.jpg', { match: 'search', subject: s })];
      return [];
    });
    const dl = fakeDownloader({
      'Best6.jpg': new ImageDownloadError('network', 'connection reset'),
      'Second7.jpg': JPEG(7),
      'Hall8.jpg': JPEG(8),
    });
    const out = await discoverImages(make(rt, dl), opp);
    expect(out.chosen.map((c) => c.title).sort()).toEqual(['Hall8.jpg', 'Second7.jpg']);
    expect(out.errors.join(' ')).toMatch(/Best6.jpg: connection reset/);
    const [failed] = await rows<any>(
      pgc,
      "select eligible, chosen, score_detail from smb.image_candidates where opportunity_id = $1 and title = 'Best6.jpg'",
      [opp],
    );
    expect(failed).toMatchObject({ eligible: false, chosen: false });
    expect(failed.score_detail.download).toMatch(/connection reset/);
  });

  it('rejects a download that is not the image the provider described', async () => {
    const opp = await opportunity();
    const rt = fakeRuntime((s) =>
      s.role === 'player' && s.name === 'Gukesh D' ? [cand('Fake9.jpg'), cand('Hash10.jpg')] : [],
    );
    const dl = fakeDownloader({
      'Fake9.jpg': new TextEncoder().encode('<html>not an image</html>'),
      'Hash10.jpg': JPEG(99), // the provider's published sha1 is for JPEG(10)
    });
    const out = await discoverImages(make(rt, dl), opp);
    expect(out.chosen).toEqual([]);
    expect(out.errors.join(' ')).toMatch(/not a JPEG, PNG or WebP/);
    expect(out.errors.join(' ')).toMatch(/does not match the hash/);
  });

  it('is idempotent: a second run returns the stored answer and searches nothing', async () => {
    const opp = await opportunity();
    const rt = fakeRuntime((s) =>
      s.role === 'player' && s.name === 'Gukesh D' ? [cand('Again11.jpg')] : [],
    );
    const deps = make(rt, fakeDownloader({ 'Again11.jpg': JPEG(11) }));
    const first = await discoverImages(deps, opp);
    const searches = rt.searched.length;
    const second = await discoverImages(deps, opp);
    expect(second.created).toBe(false);
    expect(second.chosen.map((c) => c.assetId)).toEqual(first.chosen.map((c) => c.assetId));
    expect(rt.searched.length).toBe(searches);
    const n = await rows<{ n: string }>(
      pgc,
      'select count(*) n from smb.image_candidates where opportunity_id = $1',
      [opp],
    );
    expect(Number(n[0]!.n)).toBe(1);
  });

  it('reuses the stored original when another opportunity picks the same photo, with a fresh licence check', async () => {
    const a = await opportunity();
    const b = await opportunity();
    const search = (s: ImageSubject) =>
      s.role === 'player' && s.name === 'Gukesh D' ? [cand('Shared12.jpg')] : [];
    const first = await discoverImages(
      make(fakeRuntime(search), fakeDownloader({ 'Shared12.jpg': JPEG(12) })),
      a,
    );
    const second = await discoverImages(
      make(fakeRuntime(search), fakeDownloader({ 'Shared12.jpg': JPEG(12) })),
      b,
    );
    expect(second.chosen[0]!.assetId).toBe(first.chosen[0]!.assetId);
    expect(second.chosen[0]!.licenseId).not.toBe(first.chosen[0]!.licenseId);
  });

  it('withdraws a photo when a later check rejects its licence', async () => {
    const opp = await opportunity();
    const rt = fakeRuntime((s) =>
      s.role === 'player' && s.name === 'Gukesh D' ? [cand('Later13.jpg')] : [],
    );
    const out = await discoverImages(make(rt, fakeDownloader({ 'Later13.jpg': JPEG(13) })), opp);
    const assetId = out.chosen[0]!.assetId;
    await pgc.query(
      `insert into smb.media_licenses (asset_id, original_url, licence_type, commercial_use_allowed, modifications_allowed,
         attribution_required, decision, decision_reason, verified_at, verified_by)
       values ($1, 'https://example.org/x', 'CC BY-NC', false, false, true, 'rejected', 'relicensed as non-commercial', now(), 'system')`,
      [assetId],
    );
    await expect(assertAssetsLicensed(prisma, [assetId])).rejects.toBeInstanceOf(AssetLicenceError);
    await expect(assertAssetsLicensed(prisma, [assetId])).rejects.toThrow(
      /relicensed as non-commercial/,
    );
  });

  it('can reject share-alike photos when that is switched off', async () => {
    const opp = await opportunity();
    const rt = fakeRuntime((s) =>
      s.role === 'player' && s.name === 'Gukesh D' ? [cand('Sa14.jpg')] : [],
    );
    const out = await discoverImages(
      { ...make(rt, fakeDownloader({})), allowShareAlike: false },
      opp,
    );
    expect(out.chosen).toEqual([]);
    const [r] = await rows<any>(
      pgc,
      'select rejection_codes from smb.image_candidates where opportunity_id = $1',
      [opp],
    );
    expect(r.rejection_codes).toEqual(['share_alike_not_allowed']);
  });

  it('searches the players of the game by FIDE id, then the event and venue, only for roles the source allows', async () => {
    const opp = await opportunity({
      claims: [...defaultClaims, { key: 'participants', value: [] }].slice(0, 4),
    });
    const rt = fakeRuntime(() => [], ['player', 'venue']);
    await discoverImages(make(rt, fakeDownloader({})), opp);
    expect(rt.searched).toEqual([
      { role: 'player', name: 'Gukesh D', fideId: '46616543' },
      { role: 'player', name: 'Sindarov J', fideId: '14204118' },
      { role: 'venue', name: 'Singapore' },
    ]);
  });

  /** An inactive copy of the synced config with a different image need (config versions are immutable). */
  async function configWithNeed(need: string, version: number): Promise<string> {
    const [cfg] = await rows<{ id: string }>(
      pgc,
      `insert into smb.post_configs (post_type_id, version, config_json, content_hash, file_hash, origin, override, is_active)
       select post_type_id, $2, jsonb_set(config_json, '{imageRules,need}', to_jsonb($3::text)), repeat('b', 64), file_hash, 'override', jsonb_build_object('imageRules', jsonb_build_object('need', $3::text)), false
       from smb.post_configs where id = $1 returning id`,
      [configId, version, need],
    );
    return cfg!.id;
  }

  it('flags a person when a required photo cannot be found', async () => {
    const opp = await opportunity({ config: await configWithNeed('required', 900) });
    const out = await discoverImages(
      make(
        fakeRuntime(() => []),
        fakeDownloader({}),
      ),
      opp,
    );
    expect(out).toMatchObject({ status: 'none_found', needsHuman: true });
  });

  it('does nothing when the post type needs no image', async () => {
    const opp = await opportunity({ config: await configWithNeed('none', 901) });
    const rt = fakeRuntime(() => []);
    const out = await discoverImages(make(rt, fakeDownloader({})), opp);
    expect(out).toMatchObject({ status: 'not_needed', needsHuman: false });
    expect(rt.searched).toEqual([]);
  });

  it('throws, rather than reporting "no photo", when every search failed', async () => {
    const opp = await opportunity();
    const rt = fakeRuntime(() => new Error('provider down'));
    await expect(discoverImages(make(rt, fakeDownloader({})), opp)).rejects.toBeInstanceOf(
      ImageDiscoveryError,
    );
    const n = await rows(pgc, 'select 1 from smb.image_candidates where opportunity_id = $1', [
      opp,
    ]);
    expect(n).toHaveLength(0);
  });

  it('refuses an opportunity that is not generating or has no research', async () => {
    const wrong = await opportunity({ status: 'researching' });
    await expect(
      discoverImages(
        make(
          fakeRuntime(() => []),
          fakeDownloader({}),
        ),
        wrong,
      ),
    ).rejects.toBeInstanceOf(ImageNotReadyError);
    const noPkg = await opportunity({ withPackage: false });
    await expect(
      discoverImages(
        make(
          fakeRuntime(() => []),
          fakeDownloader({}),
        ),
        noPkg,
      ),
    ).rejects.toThrow(/no research package/);
  });
});
