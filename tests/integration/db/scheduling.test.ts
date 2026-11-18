import { PrismaClient, type Prisma } from '@prisma/client';
import { configHash, type ConfigSet } from '@smb/shared';
import type pg from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { loadConfigSet } from '../../../apps/api/src/config/loader.js';
import {
  clearOverride,
  setOverride,
  syncConfigs,
} from '../../../apps/api/src/config/sync.js';
import { ContextResolvers } from '../../../apps/api/src/scheduling/context.js';
import { suspendSchedules } from '../../../apps/api/src/scheduling/holds.js';
import {
  openEventOpportunity,
  openManualOpportunity,
} from '../../../apps/api/src/scheduling/open.js';
import { runSchedulerTick } from '../../../apps/api/src/scheduling/tick.js';
import { freshDb, rows } from './harness.js';

let pgc: pg.Client;
let prisma: PrismaClient;
let configSet: ConfigSet;
const silentLogger = pino({ level: 'silent' });

beforeAll(async () => {
  pgc = await freshDb();
  prisma = new PrismaClient({ datasourceUrl: `${inject('dbUrl')}?schema=smb` });
  configSet = loadConfigSet();
  await syncConfigs(prisma, configSet);
});

afterAll(async () => {
  await prisma.$disconnect();
  await pgc.end();
});

describe('scheduling tick and recovery (scenarios 1-10)', () => {
  const resolvers = new ContextResolvers();

  it('1. First tick creates schedules row with cursor_at = now, no opportunity (D7)', async () => {
    const t0 = new Date('2026-11-18T10:00:00Z');
    const summary = await runSchedulerTick({ db: prisma, resolvers, logger: silentLogger }, { now: t0 });

    expect(summary.created).toBe(0);
    expect(summary.errors).toBe(0);

    const schedule = await prisma.schedules.findFirst({
      where: { post_type_id: '1.1' },
    });
    expect(schedule).toBeDefined();
    expect(schedule!.state).toBe('active');
    expect(schedule!.cursor_at.toISOString()).toBe(t0.toISOString());
    expect(schedule!.anchor_at.toISOString()).toBe(t0.toISOString());
    expect(schedule!.next_run_at?.toISOString()).toBe('2026-11-20T09:00:00.000Z');

    const oppCount = await prisma.post_opportunities.count({
      where: { post_type_id: '1.1' },
    });
    expect(oppCount).toBe(0);
  });

  it('2. Tick at 2026-11-20T09:00:30Z after a tick at 08:59:00Z creates exactly one opportunity with metadata', async () => {
    // Tick at 08:59:00Z (before slot)
    const tBefore = new Date('2026-11-20T08:59:00Z');
    await runSchedulerTick({ db: prisma, resolvers, logger: silentLogger }, { now: tBefore });

    // Tick at 09:00:30Z (after slot)
    const tSlot = new Date('2026-11-20T09:00:30Z');
    const summary = await runSchedulerTick({ db: prisma, resolvers, logger: silentLogger }, { now: tSlot });

    expect(summary.created).toBe(1);
    expect(summary.errors).toBe(0);

    const opp = await prisma.post_opportunities.findFirstOrThrow({
      where: { post_type_id: '1.1', trigger_kind: 'schedule' },
    });

    expect(opp.scheduled_for?.toISOString()).toBe('2026-11-20T09:00:00.000Z');
    expect(opp.dedupe_key).toBe('1.1:pt1-1:s20261120T0900Z');
    expect(opp.trigger_reason).toContain('Weekly schedule');
    expect(opp.triggered_by).toBe('scheduler');
    expect(opp.trigger_ref).toEqual({ eventRefs: {} });
    // not_after = scheduled_for + 1440 min
    expect(opp.not_after?.toISOString()).toBe('2026-11-21T09:00:00.000Z');
    expect(opp.priority).toBe(10);

    // trigger_log row
    const logRow = await prisma.trigger_log.findFirst({
      where: { opportunity_id: opp.id, outcome: 'created' },
    });
    expect(logRow).toBeDefined();

    // opportunity_events row with actor = scheduler
    const eventRow = await prisma.opportunity_events.findFirst({
      where: { opportunity_id: opp.id },
    });
    expect(eventRow).toBeDefined();
    expect(eventRow!.actor).toBe('scheduler');

    // schedules row next_run_at set to following Friday
    const schedule = await prisma.schedules.findFirstOrThrow({
      where: { post_type_id: '1.1' },
    });
    expect(schedule.next_run_at?.toISOString()).toBe('2026-11-27T09:00:00.000Z');
    expect(schedule.last_opportunity_id).toBe(opp.id);
    expect(schedule.last_outcome).toBe('created');
  });

  it('3. Same tick repeated and concurrent ticks via Promise.all produce only one opportunity', async () => {
    const tSlot = new Date('2026-11-20T09:00:30Z');
    const repeatSummary = await runSchedulerTick({ db: prisma, resolvers, logger: silentLogger }, { now: tSlot });
    expect(repeatSummary.created).toBe(0);

    const [c1, c2] = await Promise.all([
      runSchedulerTick({ db: prisma, resolvers, logger: silentLogger }, { now: tSlot }),
      runSchedulerTick({ db: prisma, resolvers, logger: silentLogger }, { now: tSlot }),
    ]);
    expect(c1.created + c2.created).toBe(0);

    const oppCount = await prisma.post_opportunities.count({
      where: { post_type_id: '1.1', dedupe_key: '1.1:pt1-1:s20261120T0900Z' },
    });
    expect(oppCount).toBe(1);
  });

  it('4. Crash safety: reset cursor_at back before the slot and tick again logs duplicate, no second opportunity', async () => {
    const beforeSlot = new Date('2026-11-20T08:59:00Z');
    await prisma.schedules.updateMany({
      where: { post_type_id: '1.1' },
      data: { cursor_at: beforeSlot },
    });

    const tSlot = new Date('2026-11-20T09:00:30Z');
    const summary = await runSchedulerTick({ db: prisma, resolvers, logger: silentLogger }, { now: tSlot });
    expect(summary.created).toBe(0);
    expect(summary.duplicates).toBe(1);

    const dupLog = await prisma.trigger_log.findFirst({
      where: {
        post_type_id: '1.1',
        outcome: 'duplicate',
        dedupe_key: '1.1:pt1-1:s20261120T0900Z',
      },
    });
    expect(dupLog).toBeDefined();

    const count = await prisma.post_opportunities.count({
      where: { post_type_id: '1.1', dedupe_key: '1.1:pt1-1:s20261120T0900Z' },
    });
    expect(count).toBe(1);
  });

  it('5. Downtime handling: late slot within stale window creates opportunity; expired slot creates none; coalesced earlier slots', async () => {
    // 5a. Downtime within stale window: last tick Fri 08:00Z, next tick Fri 11:00Z (late by 7200s)
    // Clean earlier opportunities for test
    await prisma.post_opportunities.deleteMany({ where: { post_type_id: '1.1' } });
    await prisma.schedules.updateMany({
      where: { post_type_id: '1.1' },
      data: { cursor_at: new Date('2026-11-20T08:00:00Z') },
    });

    const t11 = new Date('2026-11-20T11:00:00Z');
    const lateSummary = await runSchedulerTick({ db: prisma, resolvers, logger: silentLogger }, { now: t11 });
    expect(lateSummary.created).toBe(1);

    const lateLog = await prisma.trigger_log.findFirstOrThrow({
      where: {
        post_type_id: '1.1',
        outcome: 'created',
        slot_at: new Date('2026-11-20T09:00:00Z'),
      },
    });
    expect((lateLog.detail as Record<string, unknown>).lateBySeconds).toBe(7200);

    // 5b. Downtime past stale window: last tick Fri Nov 20, next tick Tuesday Nov 24 (staleAfterMinutes = 1440 = 24h)
    // Slot was Nov 20 09:00Z, next tick Nov 24 10:00Z is 4 days later -> expired!
    await prisma.post_opportunities.deleteMany({ where: { post_type_id: '1.1' } });
    await prisma.schedules.updateMany({
      where: { post_type_id: '1.1' },
      data: { cursor_at: new Date('2026-11-20T08:00:00Z') },
    });

    const tTuesday = new Date('2026-11-24T10:00:00Z');
    const expiredSummary = await runSchedulerTick({ db: prisma, resolvers, logger: silentLogger }, { now: tTuesday });
    expect(expiredSummary.created).toBe(0);
    expect(expiredSummary.missed).toBe(1);

    const expiredLog = await prisma.trigger_log.findFirst({
      where: { post_type_id: '1.1', outcome: 'missed_expired' },
    });
    expect(expiredLog).toBeDefined();

    // 5c. Multiple slots with daily schedule & stale window = 5000: 1 created (latest) and missed_coalesced for others
    const coalescedType = 'test-coalesce';
    const baseDailyCfg = {
      ...configSet.configs[0]!.config,
      id: coalescedType,
      schedule: [{ kind: 'daily', time: '09:00' }],
      staleAfterMinutes: 5000,
    };
    const cHash = configHash(baseDailyCfg as typeof configSet.configs[0]['config']);
    await prisma.post_types.create({
      data: { id: coalescedType, name: 'Coalesce Test', enabled: true },
    });
    await prisma.post_configs.create({
      data: {
        post_type_id: coalescedType,
        version: 1,
        config_json: baseDailyCfg as unknown as Prisma.InputJsonValue,
        content_hash: cHash,
        file_hash: cHash,
        origin: 'file',
        is_active: true,
      },
    });

    // Anchor & cursor at Nov 20 08:00Z
    const tAnchor = new Date('2026-11-20T08:00:00Z');
    await runSchedulerTick({ db: prisma, resolvers, logger: silentLogger }, { now: tAnchor });

    // Tick Nov 23 10:00Z (3 daily slots: Nov 21 09:00Z, Nov 22 09:00Z, Nov 23 09:00Z)
    const t3Days = new Date('2026-11-23T10:00:00Z');
    const coalSummary = await runSchedulerTick({ db: prisma, resolvers, logger: silentLogger }, { now: t3Days });
    expect(coalSummary.created).toBe(1); // latest slot Nov 23
    expect(coalSummary.missed).toBe(2);  // earlier 2 slots coalesced

    const coalLog = await prisma.trigger_log.findFirst({
      where: { post_type_id: coalescedType, outcome: 'missed_coalesced' },
    });
    expect(coalLog).toBeDefined();
    expect(((coalLog!.detail as Record<string, unknown>).missedSlots as string[]).length).toBe(2);
  });

  it('6. Disabled: runtime override enabled:false makes row inactive/config_disabled, clearing resumes without backlog; post_type_disabled', async () => {
    // Set cursor to Thursday Nov 26 08:00Z
    await prisma.schedules.updateMany({
      where: { post_type_id: '1.1' },
      data: { cursor_at: new Date('2026-11-26T08:00:00Z') },
    });

    // Disable via override
    await setOverride(prisma, configSet, '1.1', { enabled: false }, 'admin');

    // Tick across Friday Nov 27
    const tFri = new Date('2026-11-27T10:00:00Z');
    const disSummary = await runSchedulerTick({ db: prisma, resolvers, logger: silentLogger }, { now: tFri });
    expect(disSummary.created).toBe(0);

    const schedDisabled = await prisma.schedules.findFirstOrThrow({
      where: { post_type_id: '1.1' },
    });
    expect(schedDisabled.state).toBe('inactive');
    expect(schedDisabled.inactive_reason).toBe('config_disabled');
    expect(schedDisabled.cursor_at.toISOString()).toBe(tFri.toISOString());

    // Clear override
    await clearOverride(prisma, configSet, '1.1', 'admin');

    // Tick across next Friday Dec 4: fires normally, no backlog of Nov 27
    const tNextFri = new Date('2026-12-04T10:00:00Z');
    const resumeSummary = await runSchedulerTick({ db: prisma, resolvers, logger: silentLogger }, { now: tNextFri });
    expect(resumeSummary.created).toBe(1);

    const schedActive = await prisma.schedules.findFirstOrThrow({
      where: { post_type_id: '1.1' },
    });
    expect(schedActive.state).toBe('active');
    expect(schedActive.inactive_reason).toBeNull();

    // Test post_types.enabled = false
    await prisma.post_types.update({
      where: { id: '1.1' },
      data: { enabled: false },
    });
    const ptDisSummary = await runSchedulerTick({ db: prisma, resolvers, logger: silentLogger }, { now: tNextFri });
    expect(ptDisSummary.created).toBe(0);

    const schedPtDis = await prisma.schedules.findFirstOrThrow({
      where: { post_type_id: '1.1' },
    });
    expect(schedPtDis.state).toBe('inactive');
    expect(schedPtDis.inactive_reason).toBe('post_type_disabled');

    // Re-enable post_types
    await prisma.post_types.update({
      where: { id: '1.1' },
      data: { enabled: true },
    });
  });

  it('7. Suspension: suspendSchedules prevents execution, auto-resumes after until without backlog, writes audit row', async () => {
    // Set cursor to Thursday Dec 10
    await prisma.schedules.updateMany({
      where: { post_type_id: '1.1' },
      data: { cursor_at: new Date('2026-12-10T08:00:00Z') },
    });

    // Suspend until Saturday Dec 12 00:00Z (covers Friday Dec 11)
    const until = new Date('2026-12-12T00:00:00Z');
    await suspendSchedules(prisma, {
      postTypeId: '1.1',
      until,
      reason: 'Editorial tournament blackout',
      actor: 'admin-user',
    });

    // Tick over Friday Dec 11
    const tFri = new Date('2026-12-11T10:00:00Z');
    const suspSummary = await runSchedulerTick({ db: prisma, resolvers, logger: silentLogger }, { now: tFri });
    expect(suspSummary.created).toBe(0);

    const schedSusp = await prisma.schedules.findFirstOrThrow({
      where: { post_type_id: '1.1' },
    });
    expect(schedSusp.state).toBe('inactive');
    expect(schedSusp.inactive_reason).toBe('suspended');

    // Tick after until: Sunday Dec 13
    const tSunday = new Date('2026-12-13T10:00:00Z');
    const autoResumeSummary = await runSchedulerTick({ db: prisma, resolvers, logger: silentLogger }, { now: tSunday });
    expect(autoResumeSummary.created).toBe(0); // missed Friday Dec 11 is not replayed

    // Hold deleted
    const hold = await prisma.schedule_holds.findUnique({
      where: { post_type_id: '1.1' },
    });
    expect(hold).toBeNull();

    // Audit log has schedule.resume by system
    const audit = await prisma.audit_log.findFirst({
      where: {
        target_id: '1.1',
        action: 'schedule.resume',
        actor: 'system',
      },
    });
    expect(audit).toBeDefined();

    const schedResumed = await prisma.schedules.findFirstOrThrow({
      where: { post_type_id: '1.1' },
    });
    expect(schedResumed.state).toBe('active');
    expect(schedResumed.inactive_reason).toBeNull();
  });

  it('8. Phase switch: stub resolver switches to tournament (weekly inactive/phase_inactive) and resumes in post_tournament', async () => {
    let stubPhase: string | null = 'tournament';
    const phaseResolvers = new ContextResolvers();
    phaseResolvers.register('1.1', {
      async resolve() {
        return {
          kind: 'ready',
          context: {
            phase: stubPhase,
            subject: { eventRefs: {} },
            eventKey: 'pt1-1',
          },
        };
      },
    });

    // Tick in tournament phase: weekly schedule row becomes inactive/phase_inactive
    const tFri = new Date('2026-12-18T10:00:00Z');
    const tourSummary = await runSchedulerTick({ db: prisma, resolvers: phaseResolvers, logger: silentLogger }, { now: tFri });
    expect(tourSummary.created).toBe(0);

    const weeklyRow = await prisma.schedules.findFirstOrThrow({
      where: { post_type_id: '1.1', rule_key: 'base|UTC|weekly|fri|09:00' },
    });
    expect(weeklyRow.state).toBe('inactive');
    expect(weeklyRow.inactive_reason).toBe('phase_inactive');

    // Switch stub back to post_tournament (which keeps or re-enables schedule)
    stubPhase = 'post_tournament';
    const tNextFri = new Date('2026-12-25T10:00:00Z');
    const postTourSummary = await runSchedulerTick({ db: prisma, resolvers: phaseResolvers, logger: silentLogger }, { now: tNextFri });
    expect(postTourSummary.created).toBe(1);

    const opp = await prisma.post_opportunities.findFirstOrThrow({
      where: {
        post_type_id: '1.1',
        scheduled_for: new Date('2026-12-25T09:00:00Z'),
      },
    });
    expect(opp.phase).toBe('post_tournament');
  });

  it('9. Resolver hold: row inactive/held_for_review, nothing created, releasing resumes', async () => {
    let stubHold = true;
    const holdResolvers = new ContextResolvers();
    holdResolvers.register('1.1', {
      async resolve() {
        if (stubHold) {
          return { kind: 'hold', code: 'test_hold', reason: 'Review required' };
        }
        return {
          kind: 'ready',
          context: {
            phase: null,
            subject: { eventRefs: {} },
            eventKey: 'pt1-1',
          },
        };
      },
    });

    const tFri = new Date('2027-01-01T10:00:00Z');
    const holdSummary = await runSchedulerTick({ db: prisma, resolvers: holdResolvers, logger: silentLogger }, { now: tFri });
    expect(holdSummary.created).toBe(0);

    const schedHold = await prisma.schedules.findFirstOrThrow({
      where: { post_type_id: '1.1', rule_key: 'base|UTC|weekly|fri|09:00' },
    });
    expect(schedHold.state).toBe('inactive');
    expect(schedHold.inactive_reason).toBe('held_for_review');

    // Release hold
    stubHold = false;
    const tNextFri = new Date('2027-01-08T10:00:00Z');
    const resumeSummary = await runSchedulerTick({ db: prisma, resolvers: holdResolvers, logger: silentLogger }, { now: tNextFri });
    expect(resumeSummary.created).toBe(1);

    const schedActive = await prisma.schedules.findFirstOrThrow({
      where: { post_type_id: '1.1', rule_key: 'base|UTC|weekly|fri|09:00' },
    });
    expect(schedActive.state).toBe('active');
    expect(schedActive.inactive_reason).toBeNull();
  });

  it('10. DST end-to-end: America/New_York weekly rule fires at 13:00Z on Oct 30 and 14:00Z on Nov 6 2026', async () => {
    const nyPostType = 'test-dst-ny';
    const nyConfig = {
      ...configSet.configs[0]!.config,
      id: nyPostType,
      timezone: 'America/New_York',
      schedule: [{ kind: 'weekly', day: 'fri', time: '09:00' }],
      phases: [],
    };
    const nyHash = configHash(nyConfig as typeof configSet.configs[0]['config']);
    await prisma.post_types.create({
      data: { id: nyPostType, name: 'DST NY Test', enabled: true },
    });
    await prisma.post_configs.create({
      data: {
        post_type_id: nyPostType,
        version: 1,
        config_json: nyConfig as unknown as Prisma.InputJsonValue,
        content_hash: nyHash,
        file_hash: nyHash,
        origin: 'file',
        is_active: true,
      },
    });

    const nyResolvers = new ContextResolvers();

    // 1. Anchor & cursor on Oct 25 2026
    const tAnchor = new Date('2026-10-25T00:00:00Z');
    await runSchedulerTick({ db: prisma, resolvers: nyResolvers, logger: silentLogger }, { now: tAnchor });

    // 2. Tick after Friday Oct 30 09:00 EDT (13:00Z)
    const tOct30 = new Date('2026-10-30T15:00:00Z');
    const octSummary = await runSchedulerTick({ db: prisma, resolvers: nyResolvers, logger: silentLogger }, { now: tOct30 });
    expect(octSummary.created).toBe(1);

    const oppOct = await prisma.post_opportunities.findFirstOrThrow({
      where: { post_type_id: nyPostType, dedupe_key: { contains: 's20261030' } },
    });
    expect(oppOct.scheduled_for?.toISOString()).toBe('2026-10-30T13:00:00.000Z');

    // 3. Tick after Friday Nov 6 09:00 EST (14:00Z) (DST changed Nov 1)
    const tNov6 = new Date('2026-11-06T15:00:00Z');
    const novSummary = await runSchedulerTick({ db: prisma, resolvers: nyResolvers, logger: silentLogger }, { now: tNov6 });
    expect(novSummary.created).toBe(1);

    const oppNov = await prisma.post_opportunities.findFirstOrThrow({
      where: { post_type_id: nyPostType, dedupe_key: { contains: 's20261106' } },
    });
    expect(oppNov.scheduled_for?.toISOString()).toBe('2026-11-06T14:00:00.000Z');
  });
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
