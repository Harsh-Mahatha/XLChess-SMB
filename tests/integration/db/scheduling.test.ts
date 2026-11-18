import { PrismaClient } from '@prisma/client';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { loadConfigSet } from '../../../apps/api/src/config/loader.js';
import { syncConfigs } from '../../../apps/api/src/config/sync.js';
import {
  openEventOpportunity,
  openManualOpportunity,
} from '../../../apps/api/src/scheduling/open.js';
import { freshDb, rows } from './harness.js';

let pgc: pg.Client;
let prisma: PrismaClient;

beforeAll(async () => {
  pgc = await freshDb();
  prisma = new PrismaClient({ datasourceUrl: `${inject('dbUrl')}?schema=smb` });
  const set = loadConfigSet();
  await syncConfigs(prisma, set);
});

afterAll(async () => {
  await prisma.$disconnect();
  await pgc.end();
});

describe('scheduling: triggers and opportunities (scenarios 11-13)', () => {
  it('11. Event trigger: accepts configured event in phase, duplicates, and refuses unconfigured or disabled', async () => {
    const context = {
      phase: 'tournament',
      subject: { eventRefs: {} },
      eventKey: 'wcc-2026',
    };

    // 1. In phase 'tournament', 1.1 config has event: game_completed with priority 5
    const res1 = await openEventOpportunity(
      { db: prisma },
      {
        postTypeId: '1.1',
        event: 'game_completed',
        occurredAt: new Date('2026-11-20T14:30:00Z'),
        slot: 'game-7:result',
        context,
        reason: 'Game 7 completed',
      },
    );

    expect(res1.status).toBe('created');
    if (res1.status === 'created') {
      expect(res1.dedupeKey).toBe('1.1:wcc-2026:game-7:result');
      const opp = await prisma.post_opportunities.findUniqueOrThrow({
        where: { id: res1.opportunityId },
      });
      expect(opp.priority).toBe(5);
      expect(opp.trigger_kind).toBe('event');
      expect(opp.phase).toBe('tournament');
      expect(opp.triggered_by).toBe('event:game_completed');
    }

    // 2. Same call again returns duplicate with the same id
    const res2 = await openEventOpportunity(
      { db: prisma },
      {
        postTypeId: '1.1',
        event: 'game_completed',
        occurredAt: new Date('2026-11-20T14:30:00Z'),
        slot: 'game-7:result',
        context,
        reason: 'Game 7 completed duplicate',
      },
    );
    expect(res2.status).toBe('duplicate');
    if (res2.status === 'duplicate' && res1.status === 'created') {
      expect(res2.opportunityId).toBe(res1.opportunityId);
    }

    // 3. In phase 'post_tournament', game_completed is not configured -> refused
    const res3 = await openEventOpportunity(
      { db: prisma },
      {
        postTypeId: '1.1',
        event: 'game_completed',
        occurredAt: new Date('2026-11-20T14:30:00Z'),
        slot: 'game-8:result',
        context: { ...context, phase: 'post_tournament' },
        reason: 'Game 8 completed post-tournament',
      },
    );
    expect(res3.status).toBe('refused');
    if (res3.status === 'refused') {
      expect(res3.code).toBe('trigger_not_configured');
    }

    // 4. With post_types.enabled = false -> refused/post_type_disabled
    await prisma.post_types.update({
      where: { id: '1.1' },
      data: { enabled: false },
    });
    try {
      const res4 = await openEventOpportunity(
        { db: prisma },
        {
          postTypeId: '1.1',
          event: 'game_completed',
          occurredAt: new Date('2026-11-20T14:30:00Z'),
          slot: 'game-9:result',
          context,
          reason: 'Game 9 disabled',
        },
      );
      expect(res4.status).toBe('refused');
      if (res4.status === 'refused') {
        expect(res4.code).toBe('post_type_disabled');
      }
    } finally {
      await prisma.post_types.update({
        where: { id: '1.1' },
        data: { enabled: true },
      });
    }
  });

  it('12. Manual: same requestId duplicates, different ids create, unknown phase refused, works while suspended, refuses on disabled', async () => {
    // 1. Same requestId twice gives one row
    const m1 = await openManualOpportunity(
      { db: prisma },
      {
        postTypeId: '1.1',
        requestedBy: 'user-admin-1',
        requestId: 'req-manual-1',
        reason: 'Editorial extra post',
        phase: 'tournament',
        subject: { eventRefs: {} },
      },
    );
    expect(m1.status).toBe('created');

    const m1Dup = await openManualOpportunity(
      { db: prisma },
      {
        postTypeId: '1.1',
        requestedBy: 'user-admin-1',
        requestId: 'req-manual-1',
        reason: 'Editorial extra post retry',
        phase: 'tournament',
        subject: { eventRefs: {} },
      },
    );
    expect(m1Dup.status).toBe('duplicate');
    if (m1.status === 'created' && m1Dup.status === 'duplicate') {
      expect(m1Dup.opportunityId).toBe(m1.opportunityId);
    }

    // 2. Different requestId creates another opportunity
    const m2 = await openManualOpportunity(
      { db: prisma },
      {
        postTypeId: '1.1',
        requestedBy: 'user-admin-1',
        requestId: 'req-manual-2',
        reason: 'Editorial extra post 2',
        phase: 'tournament',
        subject: { eventRefs: {} },
      },
    );
    expect(m2.status).toBe('created');
    if (m1.status === 'created' && m2.status === 'created') {
      expect(m2.opportunityId).not.toBe(m1.opportunityId);
    }

    // 3. Unknown phase is refused
    const mBadPhase = await openManualOpportunity(
      { db: prisma },
      {
        postTypeId: '1.1',
        requestedBy: 'user-admin-1',
        requestId: 'req-manual-3',
        reason: 'Editorial bad phase',
        phase: 'nonexistent_phase',
        subject: { eventRefs: {} },
      },
    );
    expect(mBadPhase.status).toBe('refused');
    if (mBadPhase.status === 'refused') {
      expect(mBadPhase.code).toBe('unknown_phase');
    }

    // 4. Works while the schedule is suspended (schedule holds don't block manual)
    await prisma.schedule_holds.create({
      data: {
        post_type_id: '1.1',
        reason: 'Test schedule hold',
        created_by: 'admin',
      },
    });
    try {
      const mSuspended = await openManualOpportunity(
        { db: prisma },
        {
          postTypeId: '1.1',
          requestedBy: 'user-admin-1',
          requestId: 'req-manual-4',
          reason: 'Manual during schedule hold',
          phase: 'tournament',
          subject: { eventRefs: {} },
        },
      );
      expect(mSuspended.status).toBe('created');
    } finally {
      await prisma.schedule_holds.deleteMany({ where: { post_type_id: '1.1' } });
    }

    // 5. Refuses on disabled type
    await prisma.post_types.update({
      where: { id: '1.1' },
      data: { enabled: false },
    });
    try {
      const mDisabled = await openManualOpportunity(
        { db: prisma },
        {
          postTypeId: '1.1',
          requestedBy: 'user-admin-1',
          requestId: 'req-manual-5',
          reason: 'Manual while disabled',
        },
      );
      expect(mDisabled.status).toBe('refused');
      if (mDisabled.status === 'refused') {
        expect(mDisabled.code).toBe('post_type_disabled');
      }
    } finally {
      await prisma.post_types.update({
        where: { id: '1.1' },
        data: { enabled: true },
      });
    }

    // 6. Verify trigger_log rows exist for all outcomes
    const logRows = await prisma.trigger_log.findMany({
      where: { post_type_id: '1.1' },
    });
    const outcomes = new Set(logRows.map((r) => r.outcome));
    expect(outcomes.has('created')).toBe(true);
    expect(outcomes.has('duplicate')).toBe(true);
    expect(outcomes.has('refused')).toBe(true);
  });

  it('13. trigger_log is immutable (update and delete both fail)', async () => {
    const [log] = await rows<{ id: string }>(
      pgc,
      "select id from smb.trigger_log where post_type_id = '1.1' limit 1",
    );
    expect(log).toBeDefined();

    await expect(
      pgc.query(`update smb.trigger_log set outcome = 'error' where id = ${log!.id}`),
    ).rejects.toThrow(/append-only/);

    await expect(
      pgc.query(`delete from smb.trigger_log where id = ${log!.id}`),
    ).rejects.toThrow(/append-only/);
  });
});
