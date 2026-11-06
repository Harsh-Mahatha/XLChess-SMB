import { describe, expect, it } from 'vitest';
import { loadConfigSet } from '../../../apps/api/src/config/loader.js';
import {
  InMemorySourceRecordStore,
  createSourceGateway,
} from '../../../apps/api/src/sources/index.js';

/**
 * Hits the real Lichess API. Skipped unless SMB_LIVE_SOURCE_TESTS=1, so CI never depends on the network.
 * Run: SMB_LIVE_SOURCE_TESTS=1 npx vitest run tests/unit/sources/live.test.ts
 */
describe.skipIf(process.env.SMB_LIVE_SOURCE_TESTS !== '1')('Lichess live smoke test (D3)', () => {
  it('lists broadcasts, then fetches games of a finished round', async () => {
    const store = new InMemorySourceRecordStore();
    const gateway = createSourceGateway(loadConfigSet().sources, store);

    const events = await gateway.fetch('D3', 'events', { limit: 40 });
    expect(events.items.length).toBeGreaterThan(0);

    const round = events.items.flatMap((e) => e.data.rounds).find((r) => r.status === 'completed');
    expect(round, 'expected at least one completed round among recent broadcasts').toBeDefined();

    const games = await gateway.fetch('D3', 'games', { roundExternalId: round!.externalId });
    expect(games.items.length).toBeGreaterThan(0);
    for (const g of games.items) {
      expect(['1-0', '0-1', '1/2-1/2', '*']).toContain(g.data.result);
      expect(g.provenance.url).toMatch(/^https:\/\/lichess\.org\//);
    }
  }, 60_000);
});
