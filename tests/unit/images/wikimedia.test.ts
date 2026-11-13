import { describe, expect, it } from 'vitest';
import { assessLicence } from '@smb/shared';
import { htmlToText, wikimediaAdapter } from '../../../apps/api/src/images/index.js';
import { SourceError } from '../../../apps/api/src/sources/errors.js';
import {
  claim,
  commonsRuntime,
  entityResponse,
  filePage,
  imageInfoResponse,
  routedFetch,
  type Route,
} from './commons-helpers.js';

const player = { role: 'player', name: 'Gukesh D', fideId: '46616543' } as const;

/** Wikidata and Commons answers for one player with a portrait (P18) and a category (P373). */
const playerRoute =
  (over: { items?: string[]; claims?: Record<string, unknown[]>; pages?: unknown } = {}): Route =>
  (url) => {
    const p = url.searchParams;
    if (url.hostname === 'www.wikidata.org') {
      if (p.get('list') === 'search') {
        expect(p.get('srsearch')).toBe('haswbstatement:P1440=46616543');
        return { query: { search: (over.items ?? ['Q60']).map((title) => ({ title })) } };
      }
      if (p.get('action') === 'wbgetentities') {
        return entityResponse(
          'Q60',
          over.claims ?? {
            P18: [claim('Gukesh 2024.jpg')],
            P373: [claim('Gukesh Dommaraju')],
          },
        );
      }
    }
    if (p.get('list') === 'categorymembers') {
      expect(p.get('cmtitle')).toBe('Category:Gukesh Dommaraju');
      return {
        query: {
          categorymembers: [
            { title: 'File:Gukesh 2024.jpg' },
            { title: 'File:Gukesh at Chennai.jpg' },
          ],
        },
      };
    }
    if (p.get('prop') === 'imageinfo') {
      return (
        over.pages ??
        imageInfoResponse(
          filePage('File:Gukesh 2024.jpg'),
          filePage('File:Gukesh at Chennai.jpg', {
            license: 'CC BY-NC 4.0',
            licenseUrl: 'https://creativecommons.org/licenses/by-nc/4.0/',
          }),
        )
      );
    }
    return undefined;
  };

describe('htmlToText', () => {
  it('keeps the words of an author credit', () => {
    expect(htmlToText('<a href="//x.org/User:J">Jane &amp; Co</a><br/>  Smith&nbsp;Jr')).toBe(
      'Jane & Co Smith Jr',
    );
    expect(htmlToText('&#169; &#x41;')).toBe('© A');
    expect(htmlToText(undefined)).toBe('');
  });
});

describe('Wikimedia Commons adapter', () => {
  it('finds a player through the FIDE id on Wikidata, tags how each photo matched, and reads the licence facts', async () => {
    const { impl, calls } = routedFetch(playerRoute());
    const rt = commonsRuntime(impl);
    const found = await wikimediaAdapter.search({ subject: player, limit: 10 }, rt.ctx);

    expect(found.map((c) => [c.externalId, c.match])).toEqual([
      ['File:Gukesh 2024.jpg', 'wikidata_image'],
      ['File:Gukesh at Chennai.jpg', 'category'],
    ]);
    const first = found[0]!;
    expect(first).toMatchObject({
      sourceId: 'I1',
      title: 'Gukesh 2024.jpg',
      mime: 'image/jpeg',
      width: 3000,
      height: 2000,
      pageUrl: 'https://commons.wikimedia.org/wiki/File:Gukesh_2024.jpg',
      imageUrl: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Gukesh_2024.jpg',
      takenAt: '2026-06-01 12:00:00',
    });
    expect(first.evidence).toMatchObject({
      sourceName: 'Wikimedia Commons',
      licenceShortName: 'CC BY-SA 4.0',
      licenceUrl: 'https://creativecommons.org/licenses/by-sa/4.0',
      author: 'Jane Doe',
      providerRequiresAttribution: true,
      restrictions: [],
      nonFree: false,
    });
    expect((first.evidence.raw as { imageinfo: { sha1: string } }).imageinfo.sha1).toHaveLength(40);
    // Only the documented hosts are called.
    expect(new Set(calls.map((u) => u.hostname))).toEqual(
      new Set(['www.wikidata.org', 'commons.wikimedia.org']),
    );
    // The licence rules then decide: CC BY-SA passes, CC BY-NC does not.
    expect(assessLicence(first.evidence).decision).toBe('accepted');
    expect(assessLicence(found[1]!.evidence).reasons).toContain('non_commercial');
  });

  it('never searches for a person by name alone', async () => {
    const { impl, calls } = routedFetch(playerRoute());
    const rt = commonsRuntime(impl);
    const found = await wikimediaAdapter.search(
      { subject: { role: 'player', name: 'Gukesh D' }, limit: 10 },
      rt.ctx,
    );
    expect(found).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('treats an ambiguous or missing Wikidata match as no photo', async () => {
    for (const items of [[], ['Q1', 'Q2']]) {
      const { impl } = routedFetch(playerRoute({ items }));
      const found = await wikimediaAdapter.search(
        { subject: player, limit: 10 },
        commonsRuntime(impl).ctx,
      );
      expect(found).toEqual([]);
    }
  });

  it('ignores deprecated portrait statements and prefers the preferred one', async () => {
    const { impl } = routedFetch(
      playerRoute({
        claims: {
          P18: [
            claim('Old.jpg', 'deprecated'),
            claim('Normal.jpg'),
            claim('Best.jpg', 'preferred'),
          ],
        },
        pages: imageInfoResponse(filePage('File:Best.jpg'), filePage('File:Normal.jpg')),
      }),
    );
    const found = await wikimediaAdapter.search(
      { subject: player, limit: 10 },
      commonsRuntime(impl).ctx,
    );
    expect(found.map((c) => c.externalId)).toEqual(['File:Best.jpg', 'File:Normal.jpg']);
  });

  it('reads restrictions, non-free flags and missing authors for the licence rules to reject', async () => {
    const { impl } = routedFetch(
      playerRoute({
        claims: { P18: [claim('A.jpg'), claim('B.jpg'), claim('C.jpg')] },
        pages: imageInfoResponse(
          filePage('File:A.jpg', { restrictions: 'personality,trademarked' }),
          filePage('File:B.jpg', { nonFree: true, license: 'Fair use', licenseUrl: null }),
          filePage('File:C.jpg', { artist: null }),
        ),
      }),
    );
    const [a, b, c] = await wikimediaAdapter.search(
      { subject: player, limit: 10 },
      commonsRuntime(impl).ctx,
    );
    expect(a!.evidence.restrictions).toEqual(['personality', 'trademarked']);
    expect(assessLicence(a!.evidence).reasons).toEqual(
      expect.arrayContaining(['personality_rights', 'restricted_use']),
    );
    expect(assessLicence(b!.evidence).reasons).toEqual(
      expect.arrayContaining(['non_free', 'unknown_licence']),
    );
    expect(c!.evidence.author).toBeUndefined();
    expect(assessLicence(c!.evidence).reasons).toEqual(['no_author']);
  });

  it('skips missing files and ones the provider describes badly', async () => {
    const { impl } = routedFetch(
      playerRoute({
        claims: { P18: [claim('A.jpg'), claim('Gone.jpg')] },
        pages: {
          query: {
            pages: [
              filePage('File:A.jpg'),
              { title: 'File:Gone.jpg', missing: true },
              filePage('File:Zero.jpg', { width: 0 }),
            ],
          },
        },
      }),
    );
    const found = await wikimediaAdapter.search(
      { subject: player, limit: 10 },
      commonsRuntime(impl).ctx,
    );
    expect(found.map((c) => c.externalId)).toEqual(['File:A.jpg']);
  });

  it('searches events and venues by keyword, as a weaker match', async () => {
    const { impl, calls } = routedFetch((url) => {
      const p = url.searchParams;
      if (p.get('list') === 'search') {
        expect(p.get('srnamespace')).toBe('6');
        expect(p.get('srsearch')).toBe('Singapore chess filetype:bitmap');
        return { query: { search: [{ title: 'File:Hall.jpg' }] } };
      }
      if (p.get('prop') === 'imageinfo') return imageInfoResponse(filePage('File:Hall.jpg'));
    });
    const found = await wikimediaAdapter.search(
      { subject: { role: 'venue', name: 'Singapore', location: 'chess' }, limit: 5 },
      commonsRuntime(impl).ctx,
    );
    expect(found.map((c) => [c.externalId, c.match])).toEqual([['File:Hall.jpg', 'search']]);
    expect(calls.every((u) => u.hostname === 'commons.wikimedia.org')).toBe(true);
  });

  it('throws on a malformed response instead of returning "no photos"', async () => {
    const { impl } = routedFetch(() => ({ unexpected: true }));
    await expect(
      wikimediaAdapter.search(
        { subject: { role: 'event', name: 'World Championship' }, limit: 5 },
        commonsRuntime(impl).ctx,
      ),
    ).rejects.toMatchObject({ name: 'SourceError', code: 'invalid_response' });
    const { impl: notJson } = routedFetch(() => '<html>error</html>');
    await expect(
      wikimediaAdapter.search(
        { subject: { role: 'generic', keywords: 'chess' }, limit: 5 },
        commonsRuntime(notJson).ctx,
      ),
    ).rejects.toBeInstanceOf(SourceError);
  });

  it('throws when the provider is unavailable', async () => {
    const { impl } = routedFetch(() => new Error('network down'));
    await expect(
      wikimediaAdapter.search(
        { subject: { role: 'event', name: 'x' }, limit: 5 },
        commonsRuntime(impl).ctx,
      ),
    ).rejects.toMatchObject({ code: 'upstream_unavailable' });
  });
});
