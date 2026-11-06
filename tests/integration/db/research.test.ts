/* eslint-disable @typescript-eslint/no-explicit-any -- JSON column contents are checked loosely */
import { PrismaClient } from '@prisma/client';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import type { SourcesRegistry } from '@smb/shared';
import { loadConfigSet } from '../../../apps/api/src/config/loader.js';
import { syncConfigs } from '../../../apps/api/src/config/sync.js';
import { syncSources } from '../../../apps/api/src/config/sources-sync.js';
import {
  ResearchNotReadyError,
  assertReadyForGeneration,
  buildResearchPackage,
} from '../../../apps/api/src/research/index.js';
import {
  PrismaSourceRecordStore,
  createSourceGateway,
} from '../../../apps/api/src/sources/index.js';
import { API, TOUR_ID, fakeClock, fakeFetch, fixture } from '../../unit/sources/helpers.js';
import { freshDb, rows } from './harness.js';

let pgc: pg.Client;
let prisma: PrismaClient;
let registry: SourcesRegistry;
let configId: string;

const subject = {
  eventRefs: { D3: TOUR_ID },
  gameRef: { sourceId: 'D3', externalId: 'mapcPrAc' },
};

function deps() {
  const clock = fakeClock();
  const net = fakeFetch({
    [`${API}broadcast/${TOUR_ID}`]: { body: fixture('tour.json') },
    [`${API}broadcast/${TOUR_ID}.pgn`]: { body: fixture('round.pgn') },
  });
  return {
    db: prisma,
    registry,
    gateway: createSourceGateway(registry, new PrismaSourceRecordStore(prisma), {
      fetchImpl: net.impl,
      now: clock.now,
      sleep: clock.sleep,
    }),
  };
}

async function opportunity(key: string, phase: string): Promise<string> {
  const [row] = await rows<{ id: string }>(
    pgc,
    `insert into smb.post_opportunities (post_type_id, post_config_id, dedupe_key, trigger_kind, trigger_ref, phase)
     values ('1.1', $1, $2, 'manual', $3::jsonb, $4) returning id`,
    [configId, key, JSON.stringify(subject), phase],
  );
  return row!.id;
}

beforeAll(async () => {
  pgc = await freshDb();
  prisma = new PrismaClient({ datasourceUrl: `${inject('dbUrl')}?schema=smb` });
  const set = loadConfigSet();
  registry = set.sources;
  await syncSources(prisma, registry);
  await syncConfigs(prisma, set); // the seed's config is a stub; use the real one
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

describe('research package persistence', () => {
  it('tournament phase with one feed: stored as partial, claims cite stored evidence, generation is refused', async () => {
    const opp = await opportunity('test:1.5:tournament', 'tournament');
    const built = await buildResearchPackage(deps(), opp);
    expect(built).toMatchObject({ version: 1, status: 'partial' });

    const [pkg] = await rows<{ status: string; summary: any; content_hash: string }>(
      pgc,
      'select status, summary, content_hash from smb.research_packages where id = $1',
      [built.packageId],
    );
    expect(pkg!.status).toBe('partial');
    expect(pkg!.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(pkg!.summary.blocked.map((b: { claimKey: string }) => b.claimKey)).toContain(
      'game.result',
    );

    // Every claim links to at least one stored record with a URL and a hash.
    const claims = await rows<{ claim_key: string; verification: string; sources: string }>(
      pgc,
      `select c.claim_key, c.verification, count(s.source_record_id) as sources
         from smb.research_claims c
         left join smb.research_claim_sources s on s.claim_id = c.id
        where c.package_id = $1 group by c.id`,
      [built.packageId],
    );
    expect(claims.length).toBeGreaterThan(0);
    expect(claims.every((c) => Number(c.sources) > 0)).toBe(true);

    const cited = await rows<{ url: string; payload_hash: string; source_id: string }>(
      pgc,
      `select distinct r.url, r.payload_hash, r.source_id
         from smb.research_claims c
         join smb.research_claim_sources s on s.claim_id = c.id
         join smb.source_records r on r.id = s.source_record_id
        where c.package_id = $1 and c.claim_key = 'game.result'`,
      [built.packageId],
    );
    expect(cited).toEqual([
      expect.objectContaining({ source_id: 'D3', url: expect.stringContaining('lichess.org') }),
    ]);
    expect(cited[0]!.payload_hash).toMatch(/^[0-9a-f]{64}$/);

    await expect(assertReadyForGeneration(prisma, built.packageId)).rejects.toBeInstanceOf(
      ResearchNotReadyError,
    );
  });

  it('pre-tournament phase needs only descriptive facts: complete, and the gate passes', async () => {
    const opp = await opportunity('test:1.5:pre', 'pre_tournament');
    const built = await buildResearchPackage(deps(), opp);
    expect(built.status).toBe('complete');
    await expect(assertReadyForGeneration(prisma, built.packageId)).resolves.toBeUndefined();
  });

  it('building again stores a new version; the earlier one is untouched', async () => {
    const opp = await opportunity('test:1.5:versions', 'pre_tournament');
    const first = await buildResearchPackage(deps(), opp);
    const second = await buildResearchPackage(deps(), opp);
    expect([first.version, second.version]).toEqual([1, 2]);
    const hashes = await rows<{ content_hash: string }>(
      pgc,
      'select content_hash from smb.research_packages where opportunity_id = $1 order by version',
      [opp],
    );
    expect(hashes[0]!.content_hash).toBe(hashes[1]!.content_hash); // same evidence, same hash
  });

  it('claims cannot be edited or deleted after they are stored', async () => {
    const [claim] = await rows<{ id: string }>(pgc, 'select id from smb.research_claims limit 1');
    await expect(
      pgc.query('update smb.research_claims set description = $2 where id = $1', [claim!.id, 'x']),
    ).rejects.toThrow();
    await expect(
      pgc.query('delete from smb.research_claims where id = $1', [claim!.id]),
    ).rejects.toThrow();
  });

  it('a Lichess outage stores a failed package with no claims', async () => {
    const clock = fakeClock();
    const net = fakeFetch({
      [`${API}broadcast/${TOUR_ID}`]: { status: 500 },
      [`${API}broadcast/${TOUR_ID}.pgn`]: { status: 500 },
    });
    const d = {
      db: prisma,
      registry,
      gateway: createSourceGateway(registry, new PrismaSourceRecordStore(prisma), {
        fetchImpl: net.impl,
        now: clock.now,
        sleep: clock.sleep,
      }),
    };
    const opp = await opportunity('test:1.5:outage', 'tournament');
    const built = await buildResearchPackage(d, opp);
    expect(built.status).toBe('failed');
    const [n] = await rows<{ n: string }>(
      pgc,
      'select count(*) as n from smb.research_claims where package_id = $1',
      [built.packageId],
    );
    expect(Number(n!.n)).toBe(0);
    await expect(assertReadyForGeneration(prisma, built.packageId)).rejects.toBeInstanceOf(
      ResearchNotReadyError,
    );
  });
});
