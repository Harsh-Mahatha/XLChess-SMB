import { describe, expect, it } from 'vitest';
import { assessLicence, scoreCandidate } from '@smb/shared';
import { loadConfigSet } from '../../../apps/api/src/config/loader.js';
import { HttpImageDownloader, createImageRuntimes } from '../../../apps/api/src/images/index.js';
import { sha1Hex, sniffImageMime } from '../../../apps/api/src/storage/index.js';

/**
 * Hits the real Wikimedia APIs. Skipped unless SMB_LIVE_SOURCE_TESTS=1, so CI never depends on the network.
 * Run: SMB_LIVE_SOURCE_TESTS=1 npx vitest run tests/unit/images/live.test.ts
 */
describe.skipIf(process.env.SMB_LIVE_SOURCE_TESTS !== '1')(
  'Wikimedia Commons live smoke test (I1)',
  () => {
    const userAgent = 'XLChess-SMB/0.1 (chess news research bot; live test)';
    const rt = createImageRuntimes(loadConfigSet().sources, { userAgent }).get('I1')!;

    it('finds photos of a well-known player by FIDE id, with licence facts, and downloads one intact', async () => {
      // Magnus Carlsen, FIDE id 1503014.
      const found = await rt.adapter.search(
        { subject: { role: 'player', name: 'Magnus Carlsen', fideId: '1503014' }, limit: 8 },
        rt.ctx,
      );
      expect(found.length).toBeGreaterThan(0);
      for (const c of found) {
        expect(c.pageUrl).toMatch(/^https:\/\/commons\.wikimedia\.org\//);
        expect(c.imageUrl).toMatch(/^https:\/\/upload\.wikimedia\.org\//);
        expect(c.evidence.licenceShortName ?? c.evidence.licenceUrl).toBeTruthy();
      }
      const decisions = found.map((c) => assessLicence(c.evidence));
      // eslint-disable-next-line no-console
      console.log(
        found.map(
          (c, i) =>
            `${c.match} ${c.title} ${c.width}x${c.height} -> ${decisions[i]!.decision} ${decisions[i]!.reasons.join(',')}`,
        ),
      );

      const usable = found.find(
        (c, i) => decisions[i]!.decision === 'accepted' && scoreCandidate(c).eligible,
      );
      if (!usable) return; // none of the first few photos is usable: nothing to download
      const file = await rt.limiter.run(() =>
        new HttpImageDownloader({ userAgent }).download(usable.imageUrl, {
          allowedHosts: rt.adapter.downloadHosts,
          maxBytes: 50 * 1024 * 1024,
        }),
      );
      expect(sniffImageMime(file.bytes)).toBe(usable.mime);
      const published = (usable.evidence.raw as { imageinfo: { sha1: string } }).imageinfo.sha1;
      expect(sha1Hex(file.bytes)).toBe(published);
    }, 120_000);

    it('finds nothing for a FIDE id that is not on Wikidata, rather than guessing', async () => {
      const found = await rt.adapter.search(
        { subject: { role: 'player', name: 'Nobody', fideId: '999999999' }, limit: 5 },
        rt.ctx,
      );
      expect(found).toEqual([]);
    }, 60_000);
  },
);
