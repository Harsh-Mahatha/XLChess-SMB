/* eslint-disable @typescript-eslint/no-explicit-any -- JSON column contents are checked loosely */
import { PrismaClient } from '@prisma/client';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import type { SourcesRegistry } from '@smb/shared';
import { loadConfigSet } from '../../../apps/api/src/config/loader.js';
import { syncSources } from '../../../apps/api/src/config/sources-sync.js';
import {
  createSourceGateway,
  PrismaSourceRecordStore,
} from '../../../apps/api/src/sources/index.js';
import { ROUND_ID, fakeClock, fakeFetch, okRoutes } from '../../unit/sources/helpers.js';
import { freshDb, rows } from './harness.js';

let pgc: pg.Client;
let prisma: PrismaClient;
let registry: SourcesRegistry;

beforeAll(async () => {
  pgc = await freshDb();
  prisma = new PrismaClient({ datasourceUrl: `${inject('dbUrl')}?schema=smb` });
  registry = loadConfigSet().sources;
});
afterAll(async () => {
  await prisma.$disconnect();
  await pgc.end();
});

describe('source registry sync', () => {
  it('writes the registry into smb.data_sources, then does nothing on a second run', async () => {
    const first = await syncSources(prisma, registry);
    expect(first.length).toBe(9);
    const [lichess] = await rows<{
      name: string;
      base_url: string;
      terms_url: string;
      config: any;
    }>(pgc, "select name, base_url, terms_url, config from smb.data_sources where id = 'D3'");
    expect(lichess).toMatchObject({
      name: 'Lichess Broadcasts',
      base_url: 'https://lichess.org/api/',
    });
    expect(lichess!.config.policy.status).toBe('approved');
    expect(lichess!.config.capabilities).toEqual(['events', 'games']);

    const [fide] = await rows<{ config: any }>(
      pgc,
      "select config from smb.data_sources where id = 'D1'",
    );
    expect(fide!.config.capabilities).toEqual([]);

    const auditCount = async () =>
      Number(
        (
          await rows<{ n: string }>(
            pgc,
            "select count(*) as n from smb.audit_log where target_type = 'data_source'",
          )
        )[0]!.n,
      );
    // The seed already holds a row per source, so some rows are updated and some may already match.
    // Exactly the changed rows get an audit entry.
    const changedRows = first.filter((r) => r.action !== 'unchanged').length;
    expect(changedRows).toBeGreaterThan(0);
    expect(await auditCount()).toBe(changedRows);

    const second = await syncSources(prisma, registry);
    expect(second.every((r) => r.action === 'unchanged')).toBe(true);
    expect(await auditCount()).toBe(changedRows); // the second run added no entries
  });

  it('records a change as an update with an audit entry', async () => {
    const changed = structuredClone(registry);
    const d3 = changed.sources.find((s) => s.id === 'D3')!;
    if (d3.kind === 'data') d3.limits.minIntervalMs = 2000;
    const d3Updates = async () =>
      Number(
        (
          await rows<{ n: string }>(
            pgc,
            "select count(*) as n from smb.audit_log where action = 'source.update' and target_id = 'D3'",
          )
        )[0]!.n,
      );
    const before = await d3Updates();
    const res = await syncSources(prisma, changed);
    expect(res.find((r) => r.sourceId === 'D3')?.action).toBe('updated');
    expect(res.filter((r) => r.action !== 'unchanged').map((r) => r.sourceId)).toEqual(['D3']);
    expect(await d3Updates()).toBe(before + 1);
  });
});

describe('Lichess through the gateway into smb.source_records', () => {
  it('stores evidence rows that provenance can point at, and does not duplicate unchanged payloads', async () => {
    await syncSources(prisma, registry); // source rows must exist for the foreign key
    const clock = fakeClock();
    const gateway = createSourceGateway(registry, new PrismaSourceRecordStore(prisma), {
      fetchImpl: fakeFetch(okRoutes()).impl,
      now: clock.now,
      sleep: clock.sleep,
    });
    const before = Number(
      (
        await rows<{ n: string }>(
          pgc,
          "select count(*) as n from smb.source_records where source_id = 'D3'",
        )
      )[0]!.n,
    );

    const a = await gateway.fetch('D3', 'games', { roundExternalId: ROUND_ID });
    clock.t += 61_000;
    const b = await gateway.fetch('D3', 'games', { roundExternalId: ROUND_ID });

    const after = Number(
      (
        await rows<{ n: string }>(
          pgc,
          "select count(*) as n from smb.source_records where source_id = 'D3'",
        )
      )[0]!.n,
    );
    expect(after - before).toBe(3); // second fetch reused the same three rows
    expect(b.items.map((i) => i.provenance.recordId)).toEqual(
      a.items.map((i) => i.provenance.recordId),
    );

    const [rec] = await rows<{
      payload_hash: string;
      adapter_version: string;
      normalised: any;
      raw_payload: string;
    }>(
      pgc,
      'select payload_hash, adapter_version, normalised, raw_payload from smb.source_records where id = $1',
      [a.items[0]!.provenance.recordId],
    );
    expect(rec!.payload_hash).toBe(a.items[0]!.provenance.payloadHash);
    expect(rec!.adapter_version).toBe('lichess-broadcast/1.0.0');
    expect(rec!.normalised.externalId).toBe('mapcPrAc');
    expect(rec!.raw_payload).toContain('[White "Marianna Feldmann"]');
  });
});
