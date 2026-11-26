import { PrismaClient } from '@prisma/client';
import { pino } from 'pino';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, inject } from 'vitest';
import { StubProvider, type ChannelsRegistry, type SourcesRegistry } from '@smb/shared';
import { loadConfigSet } from '../../../apps/api/src/config/loader.js';
import { syncConfigs } from '../../../apps/api/src/config/sync.js';
import { syncSources } from '../../../apps/api/src/config/sources-sync.js';
import { loadTemplates } from '../../../apps/api/src/graphics/registry.js';
import {
  claimJob,
  completeJob,
  enqueueJob,
  failJob,
  heartbeatJob,
  reapExpiredLeases,
} from '../../../apps/api/src/jobs/index.js';
import { loadEnv } from '../../../apps/api/src/env.js';
import { publishDue } from '../../../apps/api/src/publishing/index.js';
import {
  approveRevision,
  editCandidate,
  requestRevision,
  transitionOpportunity,
} from '../../../apps/api/src/review/index.js';
import { InMemoryObjectStore } from '../../../apps/api/src/storage/index.js';
import {
  advanceOpportunity,
  renderForRevision,
  resumeOpportunity,
  runAvailableJobs,
  runWorkflowTick,
  type WorkflowDeps,
} from '../../../apps/api/src/workflow/index.js';
import { ID, freshDb, rows } from './harness.js';

let pgc: pg.Client;
let prisma: PrismaClient;
let configId: string;
let channels: ChannelsRegistry;
let sources: SourcesRegistry;
let store: InMemoryObjectStore;
let clock: Date;
let putFailures = 0;
let counter = 0;

const logger = pino({ level: 'silent' });

/** The store fails its next `putFailures` writes: a render that cannot save its file. */
function flakyStore(): InMemoryObjectStore {
  return Object.assign(Object.create(store) as InMemoryObjectStore, {
    put: async (...args: Parameters<InMemoryObjectStore['put']>) => {
      if (putFailures > 0) {
        putFailures -= 1;
        throw new Error('storage is unavailable');
      }
      return store.put(...args);
    },
  });
}

const deps = (over: Partial<WorkflowDeps> = {}): WorkflowDeps => ({
  db: prisma,
  store: flakyStore(),
  channels,
  logger,
  gateway: { fetch: async () => [] } as unknown as WorkflowDeps['gateway'],
  sources,
  templates: loadTemplates(),
  imageRuntimes: new Map(),
  downloader: {} as WorkflowDeps['downloader'],
  provider: new StubProvider(),
  now: () => clock,
  ...over,
});

const advanceClock = (minutes: number): void => {
  clock = new Date(clock.getTime() + minutes * 60_000);
};

const status = async (id: string): Promise<string> =>
  (
    await rows<{ status: string }>(pgc, 'select status from smb.post_opportunities where id = $1', [
      id,
    ])
  )[0]!.status;
const count = async (sql: string, params: unknown[]): Promise<number> =>
  Number((await rows<{ n: string }>(pgc, sql, params))[0]!.n);

/** An opportunity that has reached research with a complete package already stored (the sources are not under test). */
async function researched(extra: { notAfter?: Date; eventId?: string } = {}): Promise<string> {
  const n = ++counter;
  const [o] = await rows<{ id: string }>(
    pgc,
    `insert into smb.post_opportunities (post_type_id, post_config_id, dedupe_key, trigger_kind, phase, status, not_after,
                                         trigger_event_id, trigger_event_version)
     values ('1.1', $1, $2, 'manual', 'tournament', 'researching', $3, $4, $5) returning id`,
    [
      configId,
      `test:1.17:${n}`,
      extra.notAfter ?? null,
      extra.eventId ?? null,
      extra.eventId ? 1 : null,
    ],
  );
  const summary = {
    requiredFacts: [],
    phase: 'tournament',
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
  const claims = [
    {
      key: 'game.result',
      value: { result: '1-0', white: 'Gukesh D', black: 'Sindarov J', round: String(n) },
      ago: 30,
    },
    {
      key: 'match.situation',
      value: { leader: 'Gukesh D', tied: false, margin: 1, roundsRemaining: 11, totalRounds: 14 },
      ago: 30,
    },
    {
      key: 'next_game',
      value: { name: `Round ${n + 1}`, startsAt: '2030-01-01T00:00:00Z' },
      ago: null,
    },
  ];
  for (const c of claims) {
    const [claim] = await rows<{ id: string }>(
      pgc,
      `insert into smb.research_claims (package_id, claim_key, description, value, verification, confidence, event_time)
       values ($1, $2, $2, $3::jsonb, $4, 0.9, $5) returning id`,
      [
        p!.id,
        c.key,
        JSON.stringify(c.value),
        c.key === 'next_game' ? 'single_source' : 'verified',
        c.ago === null ? null : new Date(Date.now() - c.ago * 60_000),
      ],
    );
    await pgc.query(
      'insert into smb.research_claim_sources (claim_id, source_record_id) values ($1, $2)',
      [claim!.id, ID.sourceRecord1],
    );
  }
  return o!.id;
}

/** Runs the queue until nothing is runnable, moving the clock past retry delays. */
async function drain(opportunity: string, rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    const d = deps();
    await advanceOpportunity(d, opportunity);
    const ran = await runAvailableJobs(d, { budget: 10 });
    if (ran.length === 0) {
      advanceClock(30); // past any retry delay; if still nothing is runnable we are done
      const again = await runAvailableJobs(deps(), { budget: 10 });
      if (again.length === 0) return;
    }
  }
}

beforeAll(async () => {
  pgc = await freshDb();
  prisma = new PrismaClient({ datasourceUrl: `${inject('dbUrl')}?schema=smb` });
  const set = loadConfigSet();
  channels = set.channels;
  sources = set.sources;
  await syncSources(prisma, set.sources);
  await syncConfigs(prisma, set);
  const [active] = await rows<{ id: string }>(
    pgc,
    "select id from smb.post_configs where post_type_id = '1.1' and is_active",
  );
  configId = active!.id;
  store = new InMemoryObjectStore();
  // Ahead of the database clock, so jobs queued during a test are always runnable by the test clock.
  clock = new Date(Date.now() + 3600_000);
});
afterAll(async () => {
  await prisma.$disconnect();
  await pgc.end();
});

describe('the job queue', () => {
  // Other tests leave jobs behind; these tests claim by kind, so start from an empty queue.
  beforeEach(async () => {
    await pgc.query(
      "update smb.jobs set status = 'cancelled', lease_id = null, leased_by = null, lease_expires_at = null where status in ('queued', 'leased')",
    );
  });

  it('does not queue the same key or the same active step twice', async () => {
    const opp = await researched();
    const a = await enqueueJob(prisma, {
      kind: 'story_select',
      opportunityId: opp,
      idempotencyKey: `k:${opp}`,
    });
    const b = await enqueueJob(prisma, {
      kind: 'story_select',
      opportunityId: opp,
      idempotencyKey: `k:${opp}`,
    });
    const c = await enqueueJob(prisma, {
      kind: 'story_select',
      opportunityId: opp,
      idempotencyKey: `other:${opp}`,
    });
    expect(a.created).toBe(true);
    expect(b).toMatchObject({ created: false, job: { id: a.job.id } });
    expect(c).toMatchObject({ created: false, job: { id: a.job.id } });
  });

  it('gives a job to exactly one of two runners claiming at once', async () => {
    const opp = await researched();
    await enqueueJob(prisma, {
      kind: 'research_build',
      opportunityId: opp,
      idempotencyKey: `race:${opp}`,
      priority: 1,
    });
    const claims = await Promise.all(
      [1, 2, 3, 4].map(() =>
        claimJob(prisma, {
          lane: 'server',
          kinds: ['research_build'],
          leaseSeconds: 60,
          now: clock,
        }),
      ),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  it('answers a duplicate complete with the first outcome and refuses a complete on a lost lease', async () => {
    const opp = await researched();
    await enqueueJob(prisma, {
      kind: 'assets_purge',
      opportunityId: opp,
      idempotencyKey: `dup:${opp}`,
      priority: 1,
    });
    const job = (await claimJob(prisma, {
      lane: 'server',
      kinds: ['assets_purge'],
      leaseSeconds: 60,
      now: clock,
    }))!;
    expect(await completeJob(prisma, job.id, job.lease_id!, { ok: 1 })).toEqual({
      outcome: 'completed',
    });
    expect(await completeJob(prisma, job.id, job.lease_id!, { ok: 2 })).toEqual({
      outcome: 'already_completed',
    });
    const stored = await prisma.jobs.findUniqueOrThrow({ where: { id: job.id } });
    expect(stored.result).toEqual({ ok: 1 });

    await enqueueJob(prisma, {
      kind: 'assets_purge',
      opportunityId: opp,
      idempotencyKey: `lost:${opp}`,
      priority: 1,
    });
    const lost = (await claimJob(prisma, {
      lane: 'server',
      kinds: ['assets_purge'],
      leaseSeconds: 1,
      now: clock,
    }))!;
    const later = new Date(clock.getTime() + 120_000);
    expect((await reapExpiredLeases(prisma, later)).map((r) => r.id)).toEqual([lost.id]);
    expect(await completeJob(prisma, lost.id, lost.lease_id!, {})).toEqual({
      outcome: 'lease_lost',
    });
    expect(await heartbeatJob(prisma, lost.id, lost.lease_id!, { leaseSeconds: 60 })).toBe(false);
  });

  it('retries with a delay, then stops as dead when attempts run out, and stops a permanent failure at once', async () => {
    const opp = await researched();
    await enqueueJob(prisma, {
      kind: 'research_build',
      opportunityId: opp,
      idempotencyKey: `r:${opp}`,
      maxAttempts: 2,
      priority: 1,
    });
    const first = (await claimJob(prisma, {
      lane: 'server',
      kinds: ['research_build'],
      leaseSeconds: 60,
      now: clock,
    }))!;
    const requeued = await failJob(prisma, first.id, first.lease_id!, {
      code: 'net',
      message: 'down',
      retryable: true,
      retryInSeconds: 120,
      now: clock,
    });
    expect(requeued.outcome).toBe('requeued');
    expect(
      await claimJob(prisma, {
        lane: 'server',
        kinds: ['research_build'],
        leaseSeconds: 60,
        now: clock,
      }),
    ).toBeNull();
    advanceClock(5);
    const second = (await claimJob(prisma, {
      lane: 'server',
      kinds: ['research_build'],
      leaseSeconds: 60,
      now: clock,
    }))!;
    expect(second.attempts).toBe(2);
    expect(
      (
        await failJob(prisma, second.id, second.lease_id!, {
          code: 'net',
          message: 'down',
          retryable: true,
          now: clock,
        })
      ).outcome,
    ).toBe('dead');

    await enqueueJob(prisma, {
      kind: 'story_select',
      opportunityId: opp,
      idempotencyKey: `p:${opp}`,
      priority: 1,
    });
    const perm = (await claimJob(prisma, {
      lane: 'server',
      kinds: ['story_select'],
      leaseSeconds: 60,
      now: clock,
    }))!;
    expect(
      (
        await failJob(prisma, perm.id, perm.lease_id!, {
          code: 'bad',
          message: 'no',
          retryable: false,
          now: clock,
        })
      ).outcome,
    ).toBe('failed');
  });
});

describe('the workflow', () => {
  it('takes a researched opportunity through story, candidates and graphics to review', async () => {
    const opp = await researched();
    await drain(opp);
    expect(await status(opp)).toBe('awaiting_review');
    expect(
      await count('select count(*) n from smb.post_candidates where opportunity_id = $1', [opp]),
    ).toBe(3);
    expect(
      await count(
        "select count(*) n from smb.jobs where opportunity_id = $1 and kind = 'graphics_render' and status = 'succeeded'",
        [opp],
      ),
    ).toBe(3);
    expect(
      await count(
        'select count(*) n from smb.candidate_renders r join smb.post_candidates c on c.id = r.candidate_id where c.opportunity_id = $1',
        [opp],
      ),
    ).toBe(3);
    expect(
      await count('select count(*) n from smb.research_packages where opportunity_id = $1', [opp]),
    ).toBe(1);
  });

  it('is safe to advance again and again: nothing is queued twice', async () => {
    const opp = await researched();
    for (let i = 0; i < 4; i++) await advanceOpportunity(deps(), opp);
    expect(
      await count(
        "select count(*) n from smb.jobs where opportunity_id = $1 and kind = 'story_select'",
        [opp],
      ),
    ).toBe(1);
  });

  it('recovers a job whose runner died: the lease expires, the job runs again, and nothing is stored twice', async () => {
    const opp = await researched();
    await advanceOpportunity(deps(), opp);
    const taken = (await claimJob(prisma, {
      lane: 'server',
      kinds: ['story_select'],
      leaseSeconds: 30,
      now: clock,
    }))!;
    expect(taken.attempts).toBe(1);
    // The runner never reports back. Time passes and the tick reaps the lease.
    advanceClock(10);
    const tick = await runWorkflowTick(deps());
    expect(tick.reaped.map((r) => r.id)).toContain(taken.id);
    await drain(opp);
    expect(await status(opp)).toBe('awaiting_review');
    const job = await prisma.jobs.findUniqueOrThrow({ where: { id: taken.id } });
    expect(job).toMatchObject({ status: 'succeeded', attempts: 2 });
    expect(
      await count('select count(*) n from smb.story_selections where opportunity_id = $1', [opp]),
    ).toBe(1);
    expect(
      await count('select count(*) n from smb.post_candidates where opportunity_id = $1', [opp]),
    ).toBe(3);
  });

  it('retries a failed render alone: research, selection and candidates are not run again', async () => {
    const opp = await researched();
    putFailures = 1; // the first file write fails
    await drain(opp);
    putFailures = 0;
    expect(await status(opp)).toBe('awaiting_review');
    const renders = await rows<{ attempts: number }>(
      pgc,
      "select attempts from smb.jobs where opportunity_id = $1 and kind = 'graphics_render'",
      [opp],
    );
    expect(renders.some((r) => r.attempts === 2)).toBe(true);
    expect(
      await count(
        "select count(*) n from smb.jobs where opportunity_id = $1 and kind in ('research_build','story_select','candidates_generate')",
        [opp],
      ),
    ).toBe(2);
    expect(
      await count('select count(*) n from smb.post_candidates where opportunity_id = $1', [opp]),
    ).toBe(3);
  });

  it('stops in failed when a step runs out of attempts, then resumes only that step', async () => {
    const opp = await researched();
    putFailures = 1000; // every render fails
    await drain(opp, 25);
    expect(await status(opp)).toBe('failed');
    const failed = await prisma.post_opportunities.findUniqueOrThrow({ where: { id: opp } });
    expect(failed.failed_step).toBe('generating');
    expect(failed.failure_reason).toMatch(/graphics_render/);
    const candidatesBefore = await count(
      'select count(*) n from smb.post_candidates where opportunity_id = $1',
      [opp],
    );

    putFailures = 0; // storage is back
    const resumed = await resumeOpportunity(prisma, opp, 'admin:test');
    expect(resumed.step).toBe('generating');
    expect(resumed.requeued.every((r) => r.kind === 'graphics_render')).toBe(true);
    await drain(opp);
    expect(await status(opp)).toBe('awaiting_review');
    expect(
      await count('select count(*) n from smb.post_candidates where opportunity_id = $1', [opp]),
    ).toBe(candidatesBefore);
    expect(
      await count('select count(*) n from smb.research_packages where opportunity_id = $1', [opp]),
    ).toBe(1);
    await expect(resumeOpportunity(prisma, opp, 'admin:test')).rejects.toMatchObject({
      code: 'not_failed',
    });
  });

  it('skips an opportunity that went stale before review, and cancels its waiting jobs', async () => {
    const opp = await researched({ notAfter: new Date(clock.getTime() + 60_000) });
    await advanceOpportunity(deps(), opp);
    advanceClock(120);
    const tick = await runWorkflowTick(deps());
    expect(tick.staleSkipped).toContain(opp);
    expect(await status(opp)).toBe('skipped');
    expect(
      await count(
        "select count(*) n from smb.jobs where opportunity_id = $1 and status in ('queued','leased')",
        [opp],
      ),
    ).toBe(0);
  });

  it('lets only one tick run at a time', async () => {
    const holder = await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`select pg_advisory_xact_lock(hashtext('smb.workflow.tick'))`;
        return runWorkflowTick(deps());
      },
      { timeout: 20_000 },
    );
    expect(holder.ran).toBe(false);
    expect((await runWorkflowTick(deps())).ran).toBe(true);
  });

  it('queues one asset purge per day', async () => {
    await runWorkflowTick(deps());
    await runWorkflowTick(deps());
    expect(
      await count(
        "select count(*) n from smb.jobs where kind = 'assets_purge' and idempotency_key = $1",
        [`assets_purge:${clock.toISOString().slice(0, 10)}`],
      ),
    ).toBe(1);
  });
});

describe('corrections', () => {
  it('sends an unpublished opportunity back to research when its event was corrected, and withdraws the approval', async () => {
    const [ev] = await rows<{ id: string }>(
      pgc,
      `insert into smb.detected_events (identity_key, kind, post_type_id, detector_id, payload, material_hash)
       values ('test:1.17:event', 'game_completed', '1.1', 'test', '{}'::jsonb, $1) returning id`,
      ['a'.repeat(64)],
    );
    const opp = await researched({ eventId: ev!.id });
    await drain(opp);
    expect(await status(opp)).toBe('awaiting_review');

    const cand = await prisma.post_candidates.findFirstOrThrow({
      where: { opportunity_id: opp, slot: 'A' },
      include: { post_revisions: { orderBy: { revision_no: 'desc' }, take: 1 } },
    });
    const rev = cand.post_revisions[0]!;
    await approveRevision(
      { db: prisma, store, channels, publishMode: 'dry_run', now: () => clock },
      { userId: 'reviewer-1' },
      {
        revisionId: rev.id,
        contentHash: rev.content_hash,
        channels: ['x'],
        acknowledgeFailedChecks: true,
      },
    );
    expect(await status(opp)).toBe('approved');
    expect(
      await count(
        "select count(*) n from smb.publications p join smb.review_actions a on a.id = p.approval_id where a.opportunity_id = $1 and p.status = 'pending'",
        [opp],
      ),
    ).toBeGreaterThan(0);

    // The result was corrected after the post was approved.
    await pgc.query(
      'update smb.detected_events set version = 2, corrected_at = now() where id = $1',
      [ev!.id],
    );
    const tick = await runWorkflowTick(deps());
    expect(tick.corrected).toMatchObject([
      { opportunityId: opp, from: 'approved', approvalWithdrawn: true },
    ]);
    expect(
      await count(
        "select count(*) n from smb.publications p join smb.review_actions a on a.id = p.approval_id where a.opportunity_id = $1 and p.status = 'pending'",
        [opp],
      ),
    ).toBe(0);
    const after = await prisma.post_opportunities.findUniqueOrThrow({ where: { id: opp } });
    expect(after).toMatchObject({ status: 'researching', trigger_event_version: 2 });
    expect(
      await count('select count(*) n from smb.post_opportunities where trigger_event_id = $1', [
        ev!.id,
      ]),
    ).toBe(1);
    // And a second tick does not correct it again.
    expect((await runWorkflowTick(deps())).corrected).toHaveLength(0);
  });

  it('leaves a published post alone', async () => {
    const [ev] = await rows<{ id: string }>(
      pgc,
      `insert into smb.detected_events (identity_key, kind, post_type_id, detector_id, payload, material_hash)
       values ('test:1.17:event2', 'game_completed', '1.1', 'test', '{}'::jsonb, $1) returning id`,
      ['b'.repeat(64)],
    );
    const opp = await researched({ eventId: ev!.id });
    await pgc.query("update smb.post_opportunities set status = 'published' where id = $1", [opp]);
    await pgc.query(
      'update smb.detected_events set version = 2, corrected_at = now() where id = $1',
      [ev!.id],
    );
    expect((await runWorkflowTick(deps())).corrected).toHaveLength(0);
    expect(await status(opp)).toBe('published');
  });
});

describe('review actions that need the workflow', () => {
  const actor = { userId: 'reviewer-1' };
  const ctx = () => ({
    db: prisma,
    store,
    channels,
    publishMode: 'dry_run' as const,
    now: () => clock,
  });

  async function inReview(): Promise<string> {
    const opp = await researched();
    await drain(opp);
    expect(await status(opp)).toBe('awaiting_review');
    return opp;
  }

  it('writes a new set of candidates and graphics when the reviewer asks for another try', async () => {
    const opp = await inReview();
    const res = await transitionOpportunity(ctx(), actor, opp, 'regenerate', {
      feedback: 'Lead with the score, please',
      feedbackTags: ['too_long'],
    });
    expect(res.jobId).not.toBeNull();
    expect(await status(opp)).toBe('generating');
    await drain(opp);
    expect(await status(opp)).toBe('awaiting_review');
    expect(
      await count(
        'select count(distinct generation_cycle) n from smb.post_candidates where opportunity_id = $1',
        [opp],
      ),
    ).toBe(2);
    const newest = await rows<{ id: string }>(
      pgc,
      `select id from smb.post_candidates where opportunity_id = $1
         and generation_cycle = (select max(generation_cycle) from smb.post_candidates where opportunity_id = $1)`,
      [opp],
    );
    expect(newest).toHaveLength(3);
    expect(
      await count(
        'select count(*) n from smb.candidate_renders where candidate_id = any($1::uuid[])',
        [newest.map((c) => c.id)],
      ),
    ).toBe(3);
    // The request's own job ran; the orchestrator queued no second generation for it.
    expect(
      await count(
        "select count(*) n from smb.jobs where opportunity_id = $1 and kind = 'candidates_generate'",
        [opp],
      ),
    ).toBe(2);
  });

  it('runs a rewrite request from the queue and leaves the opportunity in review', async () => {
    const opp = await inReview();
    const cand = await prisma.post_candidates.findFirstOrThrow({
      where: { opportunity_id: opp, slot: 'B' },
      include: { post_revisions: { orderBy: { revision_no: 'desc' }, take: 1 } },
    });
    const req = await requestRevision(ctx(), actor, cand.id, {
      baseRevisionId: cand.post_revisions[0]!.id,
      feedback: 'Shorter and calmer',
    });
    expect(req.jobId).not.toBeNull();
    await runAvailableJobs(deps(), { budget: 5 });
    const job = await prisma.jobs.findUniqueOrThrow({ where: { id: req.jobId! } });
    expect(job.status).toBe('succeeded');
    expect(
      await count('select count(*) n from smb.post_revisions where candidate_id = $1', [cand.id]),
    ).toBe(2);
    expect(await status(opp)).toBe('awaiting_review');
  });

  it('makes a new graphic straight away when an edit changes the headline', async () => {
    const opp = await inReview();
    const cand = await prisma.post_candidates.findFirstOrThrow({
      where: { opportunity_id: opp, slot: 'A' },
      include: { post_revisions: { orderBy: { revision_no: 'desc' }, take: 1 } },
    });
    const base = cand.post_revisions[0]!;
    const d = deps();
    const edited = await editCandidate(
      {
        ...ctx(),
        rerender: async (candidateId, revisionId) => {
          const r = await renderForRevision(d, candidateId, revisionId);
          if (!r.rendered) throw new Error(r.reason);
        },
      },
      actor,
      cand.id,
      { baseRevisionId: base.id, headline: 'A different headline', changeKind: 'creative' },
    );
    expect(edited).toMatchObject({ graphicStale: false, graphicRegenerated: true });
    expect(
      await count(
        'select count(*) n from smb.candidate_renders where candidate_id = $1 and revision_id = $2',
        [cand.id, edited.revisionId],
      ),
    ).toBe(1);
  });

  it('starts research again when the reviewer asks for more of it', async () => {
    const opp = await inReview();
    await transitionOpportunity(ctx(), actor, opp, 'request_research', {
      feedback: 'Check the clock times',
    });
    expect(await status(opp)).toBe('researching');
    await advanceOpportunity(deps(), opp);
    const jobs = await rows<{ idempotency_key: string; status: string }>(
      pgc,
      "select idempotency_key, status from smb.jobs where opportunity_id = $1 and kind = 'research_build' order by created_at",
      [opp],
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.status).toBe('queued');
  });
});

describe('an approval is never lost to a retry', () => {
  it('leaves an approved post, its approval and its publication alone through ticks and publishing runs', async () => {
    const opp = await researched();
    await drain(opp);
    const cand = await prisma.post_candidates.findFirstOrThrow({
      where: { opportunity_id: opp, slot: 'A' },
      include: { post_revisions: { orderBy: { revision_no: 'desc' }, take: 1 } },
    });
    const rev = cand.post_revisions[0]!;
    await approveRevision(
      { db: prisma, store, channels, publishMode: 'dry_run', now: () => clock },
      { userId: 'reviewer-1' },
      {
        revisionId: rev.id,
        contentHash: rev.content_hash,
        channels: ['x'],
        acknowledgeFailedChecks: true,
      },
    );
    const before = await count(
      'select count(*) n from smb.review_actions where opportunity_id = $1 and action = $2::smb.review_action_type',
      [opp, 'approve'],
    );

    for (let i = 0; i < 3; i++) await runWorkflowTick(deps());
    const publishDeps = {
      db: prisma,
      store,
      channels,
      env: loadEnv({ NODE_ENV: 'test' }),
      modeOf: async () => 'dry_run' as const,
      publishers: {},
      logger,
      now: () => clock,
    };
    await publishDue(publishDeps, { limit: 10 });
    await publishDue(publishDeps, { limit: 10 });

    expect(
      await count(
        'select count(*) n from smb.review_actions where opportunity_id = $1 and action = $2::smb.review_action_type',
        [opp, 'approve'],
      ),
    ).toBe(before);
    // Dry run records what would have been posted, once, however many times the publisher runs.
    expect(
      await count(
        "select count(*) n from smb.publications p join smb.review_actions a on a.id = p.approval_id where a.opportunity_id = $1 and p.status = 'dry_run_recorded'",
        [opp],
      ),
    ).toBe(1);
    expect(
      await count(
        'select count(*) n from smb.publications p join smb.review_actions a on a.id = p.approval_id where a.opportunity_id = $1',
        [opp],
      ),
    ).toBe(1);
  });
});
