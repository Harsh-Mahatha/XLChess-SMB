/* eslint-disable @typescript-eslint/no-explicit-any -- JSON column contents are checked loosely */
import { PrismaClient } from '@prisma/client';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { loadConfigSet } from '../../../apps/api/src/config/loader.js';
import { syncConfigs } from '../../../apps/api/src/config/sync.js';
import { syncSources } from '../../../apps/api/src/config/sources-sync.js';
import {
  StoryNotReadyError,
  assertReadyToGenerate,
  selectStory,
  selectedAngleFor,
} from '../../../apps/api/src/story/index.js';
import { ID, freshDb, rows } from './harness.js';

let pgc: pg.Client;
let prisma: PrismaClient;
let configId: string;
let counter = 0;

interface ClaimSeed {
  key: string;
  value: unknown;
  verification?: string;
  minutesAgo?: number;
}

const gameResult = (round: string, result = '1-0'): ClaimSeed => ({
  key: 'game.result',
  value: { result, white: 'Gukesh D', black: 'Sindarov J', round },
  minutesAgo: 30,
});
const nextGame: ClaimSeed = {
  key: 'next_game',
  value: { name: 'Round 2', startsAt: '2030-01-01T00:00:00Z' },
  verification: 'single_source',
};

/** A pending opportunity with a complete research package holding the given claims. */
async function setup(claims: ClaimSeed[], phase = 'tournament') {
  const n = ++counter;
  const [o] = await rows<{ id: string }>(
    pgc,
    `insert into smb.post_opportunities (post_type_id, post_config_id, dedupe_key, trigger_kind, phase)
     values ('1.1', $1, $2, 'manual', $3) returning id`,
    [configId, `test:1.6:${n}`, phase],
  );
  const summary = {
    requiredFacts: [],
    phase,
    missing: [],
    blocked: [],
    conflicts: [],
    sourceErrors: [],
    skippedSources: [],
    issues: [],
  };
  const [p] = await rows<{ id: string }>(
    pgc,
    `insert into smb.research_packages (opportunity_id, version, status, summary)
     values ($1, 1, 'complete', $2::jsonb) returning id`,
    [o!.id, JSON.stringify(summary)],
  );
  for (const c of claims) {
    const [claim] = await rows<{ id: string }>(
      pgc,
      `insert into smb.research_claims (package_id, claim_key, description, value, verification, confidence, event_time)
       values ($1, $2, $2, $3::jsonb, $4, 0.9, $5) returning id`,
      [
        p!.id,
        c.key,
        JSON.stringify(c.value),
        c.verification ?? 'verified',
        c.minutesAgo === undefined ? null : new Date(Date.now() - c.minutesAgo * 60_000),
      ],
    );
    await pgc.query(
      'insert into smb.research_claim_sources (claim_id, source_record_id) values ($1, $2)',
      [claim!.id, ID.sourceRecord1],
    );
  }
  return { opportunity: o!.id, pkg: p!.id };
}

const status = async (id: string) =>
  (
    await rows<{ status: string }>(pgc, 'select status from smb.post_opportunities where id = $1', [
      id,
    ])
  )[0]!.status;

const rejected = (sel: Awaited<ReturnType<typeof selectStory>>, angle: string) =>
  sel.ranking.find((r) => r.angleId === angle)!.rejections.map((j) => j.code);

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

describe('selectStory', () => {
  it('selects a story with no topic supplied, stores every reason and moves the opportunity on', async () => {
    const { opportunity, pkg } = await setup([gameResult('1'), nextGame]);
    const sel = await selectStory(prisma, opportunity);

    expect(sel).toMatchObject({
      outcome: 'selected',
      angleId: 'game_result',
      created: true,
      packageId: pkg,
    });
    expect(sel.ranking.length).toBeGreaterThan(5);
    expect(rejected(sel, 'rating_movement')).toEqual(['unsupported']);
    expect(await status(opportunity)).toBe('generating');

    const [stored] = await rows<any>(
      pgc,
      'select * from smb.story_selections where opportunity_id = $1',
      [opportunity],
    );
    expect(stored.selector_version).toBe('story-select/1');
    expect(stored.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(Number(stored.score)).toBeGreaterThan(0.35);
    expect(stored.ranking[0].angleId).toBe('game_result');

    const events = await rows<any>(
      pgc,
      'select from_status, to_status, actor, reason from smb.opportunity_events where opportunity_id = $1 order by seq',
      [opportunity],
    );
    expect(events.map((e) => e.to_status)).toEqual(['pending', 'researching', 'generating']);
    expect(events[2]).toMatchObject({ actor: 'story-selection' });
    expect(events[2].reason).toContain('game_result');
  });

  it('is idempotent: a retried step returns the stored answer and changes nothing', async () => {
    const { opportunity } = await setup([gameResult('2')]);
    const first = await selectStory(prisma, opportunity);
    const again = await selectStory(prisma, opportunity);
    expect(again).toMatchObject({ id: first.id, created: false, angleId: first.angleId });
    const [{ n }] = await rows<{ n: string }>(
      pgc,
      'select count(*) n from smb.opportunity_events where opportunity_id = $1',
      [opportunity],
    );
    expect(n).toBe('3');
  });

  it('avoids repeating a story that is already being written or published', async () => {
    const first = await setup([gameResult('3')]);
    const a = await selectStory(prisma, first.opportunity);
    expect(a.angleId).toBe('game_result');

    const second = await setup([gameResult('3'), nextGame]);
    const b = await selectStory(prisma, second.opportunity);
    expect(rejected(b, 'game_result')).toEqual(['duplicate']);
    expect(b.angleId).not.toBe('game_result');
    const dup = b.ranking.find((r) => r.angleId === 'game_result')!;
    expect(dup.mostSimilar).toMatchObject({ opportunityId: first.opportunity, similarity: 1 });
  });

  it('allows the same kind of story about a different game', async () => {
    await selectStory(prisma, (await setup([gameResult('4')])).opportunity);
    const next = await selectStory(prisma, (await setup([gameResult('5', '1/2-1/2')])).opportunity);
    expect(next.angleId).toBe('game_result');
  });

  it('frees a story again when its post was rejected by a reviewer', async () => {
    const first = await setup([gameResult('6')]);
    await selectStory(prisma, first.opportunity);
    await pgc.query("update smb.post_opportunities set status = 'rejected' where id = $1", [
      first.opportunity,
    ]);

    const again = await selectStory(prisma, (await setup([gameResult('6')])).opportunity);
    expect(again.angleId).toBe('game_result');
  });

  it('ignores stories older than the deduplication window', async () => {
    const first = await setup([gameResult('7')]);
    await selectStory(prisma, first.opportunity);
    const second = await setup([gameResult('7')]);
    const later = new Date(Date.now() + 31 * 86_400_000);
    const sel = await selectStory(prisma, second.opportunity, { now: later });
    // 31 days on, the first selection is outside the 30 day window. (The evidence is then stale, so the
    // result is not game_result, but it must not be a duplicate rejection.)
    expect(rejected(sel, 'game_result')).not.toContain('duplicate');
  });

  it('flags no worthwhile post and skips the opportunity when nothing is supported', async () => {
    const { opportunity } = await setup([]);
    const sel = await selectStory(prisma, opportunity);
    expect(sel).toMatchObject({ outcome: 'no_worthwhile_post', angleId: null, score: null });
    expect(sel.reason).toContain('No worthwhile post');
    expect(await status(opportunity)).toBe('skipped');
    await expect(selectedAngleFor(prisma, opportunity, sel.packageId)).rejects.toBeInstanceOf(
      StoryNotReadyError,
    );
  });

  it('does not use a claim below its required verification level', async () => {
    const { opportunity } = await setup([{ ...gameResult('8'), verification: 'single_source' }]);
    const sel = await selectStory(prisma, opportunity);
    expect(sel.outcome).toBe('no_worthwhile_post');
    expect(rejected(sel, 'game_result')).toEqual(['weak_fact']);
  });

  it('refuses an opportunity with no usable package or one that has already moved on', async () => {
    const [o] = await rows<{ id: string }>(
      pgc,
      `insert into smb.post_opportunities (post_type_id, post_config_id, dedupe_key, trigger_kind, phase)
       values ('1.1', $1, 'test:1.6:nopkg', 'manual', 'tournament') returning id`,
      [configId],
    );
    await expect(selectStory(prisma, o!.id)).rejects.toThrow(/no usable research package/);

    const { opportunity } = await setup([gameResult('9')]);
    await pgc.query("update smb.post_opportunities set status = 'awaiting_review' where id = $1", [
      opportunity,
    ]);
    await expect(selectStory(prisma, opportunity)).rejects.toThrow(
      /expected pending or researching/,
    );
  });

  it('never gives two concurrent opportunities the same story', async () => {
    const a = await setup([gameResult('10'), nextGame]);
    const b = await setup([gameResult('10'), nextGame]);
    const [x, y] = await Promise.all([
      selectStory(prisma, a.opportunity),
      selectStory(prisma, b.opportunity),
    ]);
    const chosen = [x.angleId, y.angleId];
    expect(chosen.filter((c) => c === 'game_result')).toHaveLength(1);
    expect(new Set(chosen).size).toBe(2);
  });
});

describe('generation gate', () => {
  it('needs a selected story on top of a ready research package', async () => {
    const { opportunity, pkg } = await setup([gameResult('11')]);
    await expect(assertReadyToGenerate(prisma, pkg)).rejects.toBeInstanceOf(StoryNotReadyError);
    const sel = await selectStory(prisma, opportunity);
    await expect(assertReadyToGenerate(prisma, pkg)).resolves.toMatchObject({
      angleId: 'game_result',
      selectionId: sel.id,
    });
  });
});

describe('story_selections table', () => {
  it('is append-only', async () => {
    const [row] = await rows<{ id: string }>(pgc, 'select id from smb.story_selections limit 1');
    await expect(
      pgc.query("update smb.story_selections set reason = 'x' where id = $1", [row!.id]),
    ).rejects.toThrow(/append-only/);
    await expect(
      pgc.query('delete from smb.story_selections where id = $1', [row!.id]),
    ).rejects.toThrow(/append-only/);
  });

  it('requires an angle, fingerprint and score exactly when a story was selected', async () => {
    const { opportunity, pkg } = await setup([]);
    await expect(
      pgc.query(
        `insert into smb.story_selections (opportunity_id, research_package_id, outcome, reason, selector_version)
         values ($1, $2, 'selected', 'x', 'v')`,
        [opportunity, pkg],
      ),
    ).rejects.toThrow(/check constraint/);
    await expect(
      pgc.query(
        `insert into smb.story_selections (opportunity_id, research_package_id, outcome, angle_id, fingerprint, score, reason, selector_version)
         values ($1, $2, 'no_worthwhile_post', 'a', $3, 0.5, 'x', 'v')`,
        [opportunity, pkg, 'a'.repeat(64)],
      ),
    ).rejects.toThrow(/check constraint/);
  });

  it('allows one selection per opportunity and package', async () => {
    const { opportunity, pkg } = await setup([]);
    const insert = () =>
      pgc.query(
        `insert into smb.story_selections (opportunity_id, research_package_id, outcome, reason, selector_version)
         values ($1, $2, 'no_worthwhile_post', 'x', 'v')`,
        [opportunity, pkg],
      );
    await insert();
    await expect(insert()).rejects.toThrow(/duplicate key/);
  });

  it('appears in publication provenance, and provenance still has one row per publication', async () => {
    await pgc.query(
      `insert into smb.story_selections (opportunity_id, research_package_id, outcome, angle_id, fingerprint, score, reason, selector_version)
       values ($1, $2, 'selected', 'game_result', $3, 0.9, 'because', 'story-select/1')`,
      [ID.opportunity, ID.package, 'b'.repeat(64)],
    );
    const prov = await rows<any>(pgc, 'select * from smb.publication_provenance');
    expect(prov).toHaveLength(1);
    expect(prov[0]).toMatchObject({
      publication_id: ID.publication,
      story_angle_id: 'game_result',
      story_reason: 'because',
      story_selector_version: 'story-select/1',
    });
  });
});
