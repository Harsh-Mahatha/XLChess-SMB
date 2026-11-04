/* eslint-disable @typescript-eslint/no-explicit-any -- tests edit the registry JSON loosely */
import { describe, expect, it } from 'vitest';
import { SourceError, type SourceErrorCode } from '../../../apps/api/src/sources/index.js';
import { API, ROUND_ID, TOUR_ID, fixture, makeGateway, okRoutes } from './helpers.js';

async function codeOf(p: Promise<unknown>): Promise<SourceErrorCode> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(SourceError);
    return (err as SourceError).code;
  }
  throw new Error('expected a SourceError but the call succeeded');
}

describe('Lichess events (D3)', () => {
  it('lists broadcasts as normalised events with provenance and a stored record', async () => {
    const { gateway, store } = makeGateway();
    const res = await gateway.fetch('D3', 'events', {});
    expect(res.fromCache).toBe(false);
    expect(res.items).toHaveLength(3);

    const ev = res.items[0]!;
    expect(ev.data.sourceId).toBe('D3');
    expect(ev.data.externalId).toBe('DOH73W7G');
    expect(ev.data.name).toContain('Prague International Chess Festival 2027');
    expect(ev.data.status).toBe('upcoming');
    expect(ev.data.rounds).toHaveLength(9);
    expect(ev.data.startDate).toBe(new Date(1802787300000).toISOString());
    expect(ev.provenance).toMatchObject({
      sourceId: 'D3',
      url: ev.data.url,
      adapterVersion: 'lichess-broadcast/1.0.0',
    });
    expect(ev.provenance.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(store.records).toHaveLength(3);
    expect(store.records[0]!.id).toBe(ev.provenance.recordId);
    expect(store.records[0]!.rawPayload).toBeTruthy();
  });

  it('fetches one tournament and derives status from its rounds', async () => {
    const { gateway } = makeGateway();
    const res = await gateway.fetch('D3', 'events', { externalId: TOUR_ID });
    const ev = res.items[0]!.data;
    expect(ev.externalId).toBe(TOUR_ID);
    expect(ev.status).toBe('in_progress'); // round 1 finished, round 2 ongoing
    expect(ev.rounds.map((r) => r.status).slice(0, 3)).toEqual([
      'completed',
      'in_progress',
      'upcoming',
    ]);
    expect(ev.rounds[0]!.finishedAt).toBeDefined();
    expect(ev.location).toContain('Greece');
  });

  it('filters by name after normalisation', async () => {
    const { gateway } = makeGateway();
    const res = await gateway.fetch('D3', 'events', { nameContains: 'challengers' });
    expect(res.items.length).toBeGreaterThan(0);
    expect(res.items.every((i) => /challengers/i.test(i.data.name))).toBe(true);
  });
});

describe('Lichess games (D3)', () => {
  it('normalises a round PGN into games', async () => {
    const { gateway, store } = makeGateway();
    const res = await gateway.fetch('D3', 'games', { roundExternalId: ROUND_ID });
    expect(res.items).toHaveLength(3);
    const g = res.items[0]!.data;
    expect(g).toMatchObject({
      sourceId: 'D3',
      externalId: 'mapcPrAc',
      roundExternalId: ROUND_ID,
      round: '1.1',
      result: '0-1',
    });
    expect(g.white).toEqual({ name: 'Marianna Feldmann', fideId: '524085' });
    expect(g.black).toMatchObject({
      name: 'Minguez Mendoza, Mar',
      rating: 1726,
      fideId: '523071230',
    });
    expect(g.playedAt).toBe('2026-11-03T13:15:49.000Z');
    expect(g.url).toContain(`/round-1/${ROUND_ID}/mapcPrAc`);
    expect(g.pgn).toContain('1. e4');
    expect(res.items[0]!.provenance.eventTime).toBe(g.playedAt);
    expect(store.records.map((r) => r.url)).toEqual(res.items.map((i) => i.data.url));
  });

  it('does not invent ratings that the feed omits', async () => {
    const { gateway } = makeGateway();
    const res = await gateway.fetch('D3', 'games', { roundExternalId: ROUND_ID });
    const missing = res.items.filter(
      (i) => i.data.white.rating === undefined || i.data.black.rating === undefined,
    );
    expect(missing.length).toBeGreaterThan(0);
  });

  it('returns no games (not an error) when a round has none yet', async () => {
    const { gateway } = makeGateway({ [`${API}broadcast/round/${ROUND_ID}.pgn`]: { body: '' } });
    const res = await gateway.fetch('D3', 'games', { roundExternalId: ROUND_ID });
    expect(res.items).toEqual([]);
  });

  it('fetches all games of an event', async () => {
    const { gateway } = makeGateway({
      [`${API}broadcast/${TOUR_ID}.pgn`]: { body: fixture('round.pgn') },
    });
    const res = await gateway.fetch('D3', 'games', { eventExternalId: TOUR_ID });
    expect(res.items[0]!.data.eventExternalId).toBe(TOUR_ID);
  });
});

describe('capability and policy enforcement', () => {
  it('fails explicitly for capabilities Lichess does not provide', async () => {
    const { gateway, net } = makeGateway();
    expect(await codeOf(gateway.fetch('D3', 'players', { name: 'Carlsen' }))).toBe(
      'unsupported_capability',
    );
    expect(await codeOf(gateway.fetch('D3', 'news', {}))).toBe('unsupported_capability');
    expect(net.calls).toEqual([]);
  });

  it.each(['D1', 'D2', 'D4', 'D5'])(
    'refuses %s: not approved for automated retrieval',
    async (id) => {
      const { gateway, net } = makeGateway();
      expect(await codeOf(gateway.fetch(id, 'games', { roundExternalId: 'x' }))).toBe(
        'source_not_approved',
      );
      expect(net.calls).toEqual([]);
    },
  );

  it('refuses unknown and image sources', async () => {
    const { gateway } = makeGateway();
    expect(await codeOf(gateway.fetch('D9', 'events', {}))).toBe('source_not_registered');
    expect(await codeOf(gateway.fetch('I1', 'events', {}))).toBe('source_not_registered');
  });

  it('refuses a disabled source', async () => {
    const { gateway } = makeGateway(
      okRoutes(),
      (r) => (r.sources.find((s: any) => s.id === 'D3').enabled = false),
    );
    expect(await codeOf(gateway.fetch('D3', 'events', {}))).toBe('source_disabled');
    expect(gateway.capabilitiesOf('D3')).toEqual([]);
  });

  it('reports capabilities only for usable sources', () => {
    const { gateway } = makeGateway();
    expect(gateway.capabilitiesOf('D3')).toEqual(['events', 'games']);
    expect(gateway.capabilitiesOf('D1')).toEqual([]);
    expect(gateway.capabilitiesOf('nope')).toEqual([]);
  });

  it('rejects invalid queries before any request', async () => {
    const { gateway, net } = makeGateway();
    expect(await codeOf(gateway.fetch('D3', 'games', {}))).toBe('invalid_query');
    expect(
      await codeOf(gateway.fetch('D3', 'games', { roundExternalId: 'a', eventExternalId: 'b' })),
    ).toBe('invalid_query');
    expect(await codeOf(gateway.fetch('D3', 'events', { limit: 0 }))).toBe('invalid_query');
    expect(net.calls).toEqual([]);
  });

  it('refuses to start when a declared capability has no adapter code', () => {
    expect(() =>
      makeGateway(
        okRoutes(),
        (r) =>
          (r.sources.find((s: any) => s.id === 'D3').capabilities = ['events', 'games', 'news']),
      ),
    ).toThrow(/no adapter implementing it/);
  });
});

describe('failures are explicit, never empty data', () => {
  const url = `${API}broadcast/round/${ROUND_ID}.pgn`;
  const q = { roundExternalId: ROUND_ID };

  it('HTTP 404 -> not_found', async () => {
    const { gateway } = makeGateway({ [url]: { status: 404 } });
    expect(await codeOf(gateway.fetch('D3', 'games', q))).toBe('not_found');
  });

  it('HTTP 500 -> upstream_unavailable after bounded retries with backoff', async () => {
    const { gateway, net, clock } = makeGateway({ [url]: { status: 500 } });
    expect(await codeOf(gateway.fetch('D3', 'games', q))).toBe('upstream_unavailable');
    expect(net.calls).toHaveLength(3); // 1 try + maxRetries (2)
    expect(clock.sleeps.some((ms) => ms >= 500)).toBe(true);
  });

  it('recovers when a retry succeeds', async () => {
    const { gateway, net } = makeGateway({
      [url]: [{ status: 503 }, { body: fixture('round.pgn') }],
    });
    const res = await gateway.fetch('D3', 'games', q);
    expect(res.items).toHaveLength(3);
    expect(net.calls).toHaveLength(2);
  });

  it('network error -> upstream_unavailable', async () => {
    const { gateway } = makeGateway({ [url]: new Error('ECONNRESET') });
    expect(await codeOf(gateway.fetch('D3', 'games', q))).toBe('upstream_unavailable');
  });

  it('HTTP 429 pauses the whole source for at least the configured backoff, then reports rate_limited', async () => {
    const { gateway, net, clock } = makeGateway({
      [url]: { status: 429, headers: { 'retry-after': '5' } },
    });
    expect(await codeOf(gateway.fetch('D3', 'games', q))).toBe('rate_limited');
    expect(net.calls).toHaveLength(2); // one retry after the pause, then give up
    expect(clock.sleeps.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(60_000);
  });

  it('keeps requests to one source at least minIntervalMs apart', async () => {
    const { gateway, clock } = makeGateway();
    await gateway.fetch('D3', 'events', { externalId: TOUR_ID });
    await gateway.fetch('D3', 'games', q);
    expect(clock.sleeps.some((ms) => ms > 0 && ms <= 1000)).toBe(true);
  });

  it('non-JSON events response -> invalid_response', async () => {
    const { gateway } = makeGateway({
      [`${API}broadcast/${TOUR_ID}`]: { body: '<html>oops</html>' },
    });
    expect(await codeOf(gateway.fetch('D3', 'events', { externalId: TOUR_ID }))).toBe(
      'invalid_response',
    );
  });

  it('JSON of the wrong shape -> invalid_response', async () => {
    const { gateway } = makeGateway({
      [`${API}broadcast/${TOUR_ID}`]: { body: '{"tour":{"id":1}}' },
    });
    expect(await codeOf(gateway.fetch('D3', 'events', { externalId: TOUR_ID }))).toBe(
      'invalid_response',
    );
  });

  it('a bad line in the NDJSON stream fails the whole call', async () => {
    const lines = fixture('broadcasts.ndjson').trim().split('\n');
    const body = [lines[0], '{not json', lines[1]].join('\n');
    const { gateway, store } = makeGateway({ [`${API}broadcast?nb=20`]: { body } });
    expect(await codeOf(gateway.fetch('D3', 'events', {}))).toBe('invalid_response');
    expect(store.records).toHaveLength(0);
  });

  it('non-PGN text where PGN is expected -> invalid_response', async () => {
    const { gateway } = makeGateway({ [url]: { body: '<html>Service Unavailable</html>' } });
    expect(await codeOf(gateway.fetch('D3', 'games', q))).toBe('invalid_response');
  });

  it('a game without a valid Result tag -> invalid_response', async () => {
    const body = fixture('round.pgn').replace('[Result "0-1"]', '[Result "banana"]');
    const { gateway } = makeGateway({ [url]: { body } });
    expect(await codeOf(gateway.fetch('D3', 'games', q))).toBe('invalid_response');
  });
});

describe('caching and record storage', () => {
  const q = { roundExternalId: ROUND_ID };

  it('serves repeat calls from cache within the TTL and refetches after it', async () => {
    const { gateway, net, clock } = makeGateway();
    const first = await gateway.fetch('D3', 'games', q);
    const second = await gateway.fetch('D3', 'games', q);
    expect(first.fromCache).toBe(false);
    expect(second.fromCache).toBe(true);
    expect(net.calls).toHaveLength(1);

    clock.t += 61_000; // games TTL is 60s
    const third = await gateway.fetch('D3', 'games', q);
    expect(third.fromCache).toBe(false);
    expect(net.calls).toHaveLength(2);
  });

  it('does not cache failures', async () => {
    const url = `${API}broadcast/round/${ROUND_ID}.pgn`;
    const { gateway } = makeGateway({
      [url]: [{ status: 500 }, { status: 500 }, { status: 500 }, { body: fixture('round.pgn') }],
    });
    await expect(gateway.fetch('D3', 'games', q)).rejects.toBeInstanceOf(SourceError);
    expect((await gateway.fetch('D3', 'games', q)).items).toHaveLength(3);
  });

  it('reuses a stored record when the payload is unchanged, and adds one when it changes', async () => {
    const url = `${API}broadcast/round/${ROUND_ID}.pgn`;
    const changed = fixture('round.pgn').replace('[Result "0-1"]', '[Result "1-0"]');
    const { gateway, store, clock } = makeGateway({
      [url]: [{ body: fixture('round.pgn') }, { body: fixture('round.pgn') }, { body: changed }],
    });

    const a = await gateway.fetch('D3', 'games', q);
    clock.t += 61_000;
    const b = await gateway.fetch('D3', 'games', q);
    expect(store.records).toHaveLength(3); // identical refetch added nothing
    expect(b.items[0]!.provenance.recordId).toBe(a.items[0]!.provenance.recordId);

    clock.t += 61_000;
    const c = await gateway.fetch('D3', 'games', q);
    expect(store.records).toHaveLength(4); // only the changed game got a new record
    expect(c.items[0]!.provenance.recordId).not.toBe(a.items[0]!.provenance.recordId);
    expect(c.items[0]!.data.result).toBe('1-0');
    expect(c.items[1]!.provenance.recordId).toBe(a.items[1]!.provenance.recordId);
  });

  it('stored hash matches the raw PGN so evidence can be re-verified', async () => {
    const { createHash } = await import('node:crypto');
    const { gateway, store } = makeGateway();
    const res = await gateway.fetch('D3', 'games', q);
    const rec = store.records[0]!;
    expect(
      createHash('sha256')
        .update(rec.rawPayload as string)
        .digest('hex'),
    ).toBe(rec.payloadHash);
    expect(rec.payloadHash).toBe(res.items[0]!.provenance.payloadHash);
  });
});
