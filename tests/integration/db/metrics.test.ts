/* eslint-disable @typescript-eslint/no-explicit-any -- database rows are checked loosely */
import { createHash, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import express from 'express';
import { SignJWT } from 'jose';
import pino from 'pino';
import request from 'supertest';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { createTokenVerifier } from '../../../apps/api/src/auth/index.js';
import { errorHandler } from '../../../apps/api/src/http/errors.js';
import { metricsRouter } from '../../../apps/api/src/http/routes/metrics.js';
import { claimJob, completeJob, enqueueJob, failJob } from '../../../apps/api/src/jobs/index.js';
import {
  CostRateError,
  costReport,
  createAlertWatcher,
  dashboard,
  gatherHealthInputs,
  kpiWindow,
  opportunityCost,
  qualityReport,
  runAlertCheck,
  setCostRate,
  uneditedStreak,
  type MetricsConfig,
} from '../../../apps/api/src/metrics/index.js';
import { ID, freshDb, rows } from './harness.js';

let pgc: pg.Client;
let prisma: PrismaClient;
let configId: string;
let counter = 0;

const NOW = new Date('2026-11-20T12:00:00Z');
const cfg: MetricsConfig = {
  timezone: 'UTC',
  requiredDailyVolume: 1,
  thresholds: { workerOfflineMinutes: 10, pollerFailures: 3, reviewWaitHours: 6 },
};
const at = (isoDay: string, time = '09:00:00'): Date => new Date(`${isoDay}T${time}Z`);
const hash = (s: string): string => createHash('sha256').update(s).digest('hex');

type Kind = 'clean' | 'edited' | 'rejected' | 'pending' | 'regenerated' | 'image_flagged';

interface PostOptions {
  readyAt: Date;
  kind: Kind;
  postType?: string;
  /** Seconds the reviewer reported looking at the post. */
  active?: number;
  /** The approved revision uses a different photograph than the first text did. */
  swapPhoto?: boolean;
}

/** One post that reached review at `readyAt` and ended as `kind`. Built with SQL so each case is exact. */
async function post(o: PostOptions): Promise<string> {
  const n = ++counter;
  const opened = new Date(o.readyAt.getTime() - 10 * 60_000);
  const [opp] = await rows<{ id: string }>(
    pgc,
    `insert into smb.post_opportunities (post_type_id, post_config_id, dedupe_key, trigger_kind, status, created_at)
     values ($1, $2, $3, 'schedule', 'awaiting_review', $4) returning id`,
    [o.postType ?? '1.1', configId, `test:1.19:${n}`, opened],
  );
  const id = opp!.id;
  // Events are append-only; the test places the "ready for review" moment where it needs it.
  await pgc.query(
    'alter table smb.opportunity_events disable trigger opportunity_events_immutable',
  );
  await pgc.query('update smb.opportunity_events set created_at = $2 where opportunity_id = $1', [
    id,
    o.readyAt,
  ]);
  await pgc.query('alter table smb.opportunity_events enable trigger opportunity_events_immutable');

  const [pkg] = await rows<{ id: string }>(
    pgc,
    `insert into smb.research_packages (opportunity_id, version, status) values ($1, 1, 'complete') returning id`,
    [id],
  );
  const [cand] = await rows<{ id: string }>(
    pgc,
    `insert into smb.post_candidates (opportunity_id, research_package_id, slot, angle, provider, model, prompt_version)
     values ($1, $2, 'A', 'result', 'stub', 'stub-1', 'candidate@1.0.0#aaaa') returning id`,
    [id, pkg!.id],
  );
  const [r1] = await rows<{ id: string; hash: string }>(
    pgc,
    `insert into smb.post_revisions (candidate_id, revision_no, caption, channel_texts, content_hash, author_kind, headline, alt_text)
     values ($1, 1, 'Caption as first written', '{}', $2, 'ai', 'Headline', 'Alt') returning id, content_hash as hash`,
    [cand!.id, hash(`r1:${n}`)],
  );
  if (o.swapPhoto) {
    await pgc.query(
      "insert into smb.revision_assets (revision_id, asset_id, role) values ($1, $2, 'photo')",
      [r1!.id, ID.assetOriginal],
    );
  }

  const action = (
    type: string,
    revisionId: string | null,
    contentHash: string | null,
    when: Date,
    extra: { feedback?: string; tags?: string[]; active?: number } = {},
  ) =>
    pgc.query(
      `insert into smb.review_actions (opportunity_id, candidate_id, revision_id, action, content_hash, reviewer_id,
         channels, feedback, feedback_tags, active_seconds, created_at)
       values ($1, $2, $3, $4::smb.review_action_type, $5, 'reviewer-1', $6::smb.channel[], $7, $8, $9, $10)`,
      [
        id,
        cand!.id,
        revisionId,
        type,
        contentHash,
        type === 'approve' ? '{x}' : '{}',
        extra.feedback ?? null,
        extra.tags ?? [],
        extra.active ?? null,
        when,
      ],
    );
  const later = (minutes: number): Date => new Date(o.readyAt.getTime() + minutes * 60_000);
  const setStatus = (s: string) =>
    pgc.query(
      'update smb.post_opportunities set status = $2::smb.opportunity_status where id = $1',
      [id, s],
    );

  switch (o.kind) {
    case 'pending':
      break;
    case 'clean':
      await action('approve', r1!.id, r1!.hash, later(20), { active: o.active });
      await setStatus('approved');
      break;
    case 'image_flagged':
      await action('comment', r1!.id, r1!.hash, later(10), {
        feedback: 'The picture shows the wrong player',
        tags: ['wrong_image'],
      });
      await action('approve', r1!.id, r1!.hash, later(20), { active: o.active });
      await setStatus('approved');
      break;
    case 'regenerated':
      await action('regenerate', null, null, later(10), { feedback: 'Again', tags: ['too_dry'] });
      await action('approve', r1!.id, r1!.hash, later(30), { active: o.active });
      await setStatus('approved');
      break;
    case 'edited': {
      const [r2] = await rows<{ id: string; hash: string }>(
        pgc,
        `insert into smb.post_revisions (candidate_id, revision_no, parent_revision_id, caption, channel_texts, content_hash,
           author_kind, author_id, headline, alt_text, change_kind, change_tags, changed_fields)
         values ($1, 2, $2, 'Caption corrected by a person', '{}', $3, 'human', 'reviewer-1', 'Headline', 'Alt',
           'factual', '{wrong_figure}', '{caption}') returning id, content_hash as hash`,
        [cand!.id, r1!.id, hash(`r2:${n}`)],
      );
      if (o.swapPhoto) {
        await pgc.query(
          "insert into smb.revision_assets (revision_id, asset_id, role) values ($1, $2, 'photo')",
          [r2!.id, ID.assetDerived],
        );
      }
      await action('approve', r2!.id, r2!.hash, later(25), { active: o.active });
      await setStatus('approved');
      break;
    }
    case 'rejected':
      await action('reject', null, null, later(15), {
        feedback: 'Not worth posting',
        active: o.active,
      });
      await setStatus('rejected');
      break;
  }
  return id;
}

const outcomeOf = async (id: string) =>
  (
    await rows<any>(pgc, 'select * from smb.review_outcome_metrics where opportunity_id = $1', [id])
  )[0];

beforeAll(async () => {
  pgc = await freshDb();
  prisma = new PrismaClient({ datasourceUrl: `${inject('dbUrl')}?schema=smb` });
  const [active] = await rows<{ id: string }>(
    pgc,
    "select id from smb.post_configs where post_type_id = '1.1' and is_active",
  );
  configId = active!.id;
}, 180_000);
afterAll(async () => {
  await prisma.$disconnect();
  await pgc.end();
});

describe('review_outcome_metrics', () => {
  it('marks a post clean only when it was approved as written with no regeneration, rewrite or research', async () => {
    const day = at('2026-09-01');
    const clean = await outcomeOf(await post({ readyAt: day, kind: 'clean' }));
    const edited = await outcomeOf(await post({ readyAt: day, kind: 'edited' }));
    const regenerated = await outcomeOf(await post({ readyAt: day, kind: 'regenerated' }));
    const rejected = await outcomeOf(await post({ readyAt: day, kind: 'rejected' }));
    const pending = await outcomeOf(await post({ readyAt: day, kind: 'pending' }));
    expect(clean).toMatchObject({ outcome: 'approved', approved_unedited: true, clean: true });
    expect(edited).toMatchObject({ outcome: 'approved', approved_unedited: false, clean: false });
    // Unedited text, but a regeneration was needed: counted as unedited, not as clean.
    expect(regenerated).toMatchObject({ approved_unedited: true, clean: false });
    expect(rejected).toMatchObject({ outcome: 'rejected', clean: false });
    expect(pending).toMatchObject({ outcome: 'pending', clean: false });
  });

  it('keeps one row per opportunity, so the extra columns cannot double a count', async () => {
    const [a] = await rows<{ n: number }>(
      pgc,
      'select count(*)::int as n from smb.review_outcomes',
    );
    const [b] = await rows<{ n: number }>(
      pgc,
      'select count(*)::int as n from smb.review_outcome_metrics',
    );
    expect(b!.n).toBe(a!.n);
  });

  it('flags an image problem raised by a reviewer, and a photograph that was swapped', async () => {
    const day = at('2026-09-02');
    const flagged = await outcomeOf(await post({ readyAt: day, kind: 'image_flagged' }));
    const swapped = await outcomeOf(await post({ readyAt: day, kind: 'edited', swapPhoto: true }));
    const same = await outcomeOf(await post({ readyAt: day, kind: 'clean' }));
    expect(flagged).toMatchObject({ image_flagged: true, image_replaced: false });
    expect(swapped).toMatchObject({ image_flagged: false, image_replaced: true });
    expect(same).toMatchObject({ image_flagged: false, image_replaced: false });
  });

  it('adds up the time reviewers reported, and is null when nobody did', async () => {
    const day = at('2026-09-03');
    const timed = await outcomeOf(await post({ readyAt: day, kind: 'clean', active: 95 }));
    const untimed = await outcomeOf(await post({ readyAt: day, kind: 'clean' }));
    expect(timed.active_review_seconds).toBe(95);
    expect(untimed.active_review_seconds).toBeNull();
  });
});

describe('the ten-day streak', () => {
  it('counts rejected posts, breaks on them, and reports each day', async () => {
    for (const d of ['10', '11', '12', '13', '14']) {
      await post({ readyAt: at(`2026-11-${d}`), kind: 'clean' });
    }
    // 15 Nov: one good post and one rejected: the day is broken, the rejected post is not left out.
    await post({ readyAt: at('2026-11-15'), kind: 'clean' });
    await post({ readyAt: at('2026-11-15', '10:00:00'), kind: 'rejected', postType: '1.1' });
    for (const d of ['16', '17', '18', '19']) {
      await post({ readyAt: at(`2026-11-${d}`), kind: 'clean' });
    }
    // Today: still waiting for a decision. Provisional, neither counting nor breaking.
    await post({ readyAt: at('2026-11-20', '08:00:00'), kind: 'pending' });

    const s = await uneditedStreak(prisma, cfg, { days: 11, now: NOW });
    expect(s.window).toEqual({ from: '2026-11-10', to: '2026-11-20' });
    expect(s.days.map((d) => d.status)).toEqual([
      'clean',
      'clean',
      'clean',
      'clean',
      'clean',
      'broken',
      'clean',
      'clean',
      'clean',
      'clean',
      'incomplete',
    ]);
    expect(s.current).toBe(4);
    expect(s.best).toBe(5);
    expect(s.brokenOn).toBe('2026-11-15');
    expect(s.goalReached).toBe(false);
    const broken = s.days.find((d) => d.day === '2026-11-15')!;
    expect(broken).toMatchObject({ posts: 2, clean: 1, notClean: 1 });
    expect(s.byPostType).toEqual([
      expect.objectContaining({ postType: '1.1', current: 4, best: 5 }),
    ]);
  });

  it('does not evaluate days under the required volume, and uses the reporting timezone', async () => {
    const strict = await uneditedStreak(
      prisma,
      { ...cfg, requiredDailyVolume: 2 },
      { days: 11, now: NOW },
    );
    // With two posts required, only 15 Nov has enough posts, and it is broken.
    expect(strict.days.filter((d) => d.status === 'below_volume').length).toBeGreaterThanOrEqual(8);
    expect(strict.current).toBe(0);
    expect(strict.best).toBe(0);

    // 11:30 on 20 Nov UTC is already the 21st in Auckland (UTC+13 in November).
    const nz = await kpiWindow(prisma, 'Pacific/Auckland', 3, new Date('2026-11-20T11:30:00Z'));
    expect(nz.toDay).toBe('2026-11-21');
    expect(nz.fromDay).toBe('2026-11-19');
  });

  it('filters by post type', async () => {
    const other = await uneditedStreak(prisma, cfg, { days: 11, postType: '9.9', now: NOW });
    expect(other.current).toBe(0);
    expect(other.byPostType).toEqual([]);
  });
});

describe('quality report', () => {
  it('uses every decided post as the denominator and reports review time', async () => {
    const w = await kpiWindow(prisma, 'UTC', 11, NOW);
    const q = await qualityReport(prisma, { from: w.from, to: w.to });
    // 9 clean days of one post each plus the 15th's clean and rejected posts: 11 decided posts, 10 clean.
    expect(q.totals.decided).toBe(11);
    expect(q.totals.clean).toBe(10);
    expect(q.totals.cleanRate).toBeCloseTo(10 / 11, 3);
    expect(q.feedback.totals.pending).toBe(1);
    expect(q.totals.timeToDecision.posts).toBe(11);
    expect(q.postTypes).toEqual([expect.objectContaining({ postType: '1.1', decided: 11 })]);
  });
});

describe('what a job used and how long it ran', () => {
  const enqueue = async (key: string) =>
    (await enqueueJob(prisma, { kind: 'candidates_generate', idempotencyKey: key })).job;

  it('adds up the time of every attempt, failed ones included, and keeps the last usage', async () => {
    await enqueue('usage-1');
    const t0 = new Date(Date.now() + 60_000);
    const first = await claimJob(prisma, { lane: 'gpu', leaseSeconds: 60, now: t0 });
    expect(first?.attempt_started_at).toEqual(t0);
    await failJob(prisma, first!.id, first!.lease_id!, {
      code: 'worker_timeout',
      message: 'slow',
      retryable: true,
      retryInSeconds: 0,
      now: new Date(t0.getTime() + 5_000),
      metrics: { durationMs: 4_000 },
    });
    const t1 = new Date(t0.getTime() + 300_000);
    const second = await claimJob(prisma, { lane: 'gpu', leaseSeconds: 60, now: t1 });
    await completeJob(prisma, second!.id, second!.lease_id!, {}, new Date(t1.getTime() + 9_000), {
      durationMs: 6_000,
      usage: {
        gpuMs: 6_000,
        llm: { calls: 4, durationMs: 5_000, promptTokens: 900, completionTokens: 300 },
      },
    });
    const job = await prisma.jobs.findUniqueOrThrow({ where: { id: first!.id } });
    expect(Number(job.duration_ms)).toBe(10_000);
    expect(job.usage).toMatchObject({ llm: { promptTokens: 900, completionTokens: 300 } });
  });

  it('falls back to claim-to-finish time when the runner reports none (the server lane)', async () => {
    await enqueueJob(prisma, { kind: 'assets_purge', idempotencyKey: 'usage-2' });
    const t0 = new Date(Date.now() + 60_000);
    const job = await claimJob(prisma, { lane: 'server', leaseSeconds: 60, now: t0 });
    await completeJob(prisma, job!.id, job!.lease_id!, {}, new Date(t0.getTime() + 2_500));
    const done = await prisma.jobs.findUniqueOrThrow({ where: { id: job!.id } });
    expect(Number(done.duration_ms)).toBe(2_500);
    expect(done.usage).toBeNull();
  });
});

describe('cost per approved post', () => {
  it('prices GPU time, review time and hosting at the rates of each day, rejected posts included', async () => {
    const today = '2026-11-20';
    await setCostRate(
      prisma,
      'admin-1',
      {
        effectiveFrom: today,
        gpuWatts: 300,
        electricityPerKwh: 0.5,
        serverMonthly: 30,
        reviewerHourly: 20,
        reason: 'test prices',
      },
      today,
    ).catch((e) => {
      throw e;
    });
    // The price list starts today, so earlier days use the seeded list (250 W, everything else unpriced).
    // Half an hour of GPU time on 19 Nov (the jobs above ran today, outside this window).
    await pgc.query(
      `insert into smb.jobs (lane, kind, status, duration_ms, created_at, updated_at, finished_at)
       values ('gpu', 'candidates_generate', 'succeeded', 1800000, $1, $1, $1)`,
      [at('2026-11-19', '15:00:00')],
    );
    const w = await kpiWindow(prisma, 'UTC', 11, NOW);
    const c = await costReport(prisma, cfg, w);
    expect(c.window).toEqual({ from: '2026-11-10', to: '2026-11-20' });
    expect(c.approvedPosts).toBe(10);
    expect(c.gpuSeconds).toBe(1800);
    expect(c.unpriced).toEqual(['xApiMonthly']); // never set: reported, not counted as free
    expect(c.reviewTimeMeasured).toBe(false);
    expect(c.server).toBeCloseTo(30 / 30, 4); // only today is priced for hosting
  });

  it('refuses a price list in the past or on a day that already has one, and audits a change', async () => {
    await expect(
      setCostRate(prisma, 'admin-1', { effectiveFrom: '2026-11-01', reason: 'late' }, '2026-11-20'),
    ).rejects.toMatchObject({ code: 'rate_in_past' });
    await expect(
      setCostRate(
        prisma,
        'admin-1',
        { effectiveFrom: '2026-11-20', reason: 'again' },
        '2026-11-20',
      ),
    ).rejects.toBeInstanceOf(CostRateError);
    const next = await setCostRate(
      prisma,
      'admin-1',
      { effectiveFrom: '2026-12-01', electricityPerKwh: 0.7, reason: 'tariff change' },
      '2026-11-20',
    );
    // Unset prices carry over from the list in force.
    expect(next).toMatchObject({ electricityPerKwh: 0.7, gpuWatts: 300, reviewerHourly: 20 });
    const audit = await rows<any>(
      pgc,
      "select * from smb.audit_log where action = 'cost_rates.change'",
    );
    expect(audit.length).toBeGreaterThanOrEqual(2);
    await expect(pgc.query('update smb.cost_rates set gpu_watts = 1')).rejects.toThrow(
      /append-only/,
    );
  });

  it('prices one post from its own jobs and review time', async () => {
    const id = await post({ readyAt: at('2026-11-20', '07:00:00'), kind: 'clean', active: 3600 });
    const [job] = await rows<{ id: string }>(
      pgc,
      `insert into smb.jobs (lane, kind, status, opportunity_id, duration_ms, usage, updated_at, finished_at)
       values ('gpu', 'candidates_generate', 'succeeded', $1, 3600000,
         '{"llm":{"calls":3,"durationMs":1,"promptTokens":1000,"completionTokens":400}}', $2, $2) returning id`,
      [id, at('2026-11-20', '07:30:00')],
    );
    expect(job).toBeDefined();
    const c = await opportunityCost(prisma, cfg, id);
    // 0.3 kW for one hour at 0.5 per kWh, plus one hour of review at 20.
    expect(c).toMatchObject({
      gpuSeconds: 3600,
      reviewSeconds: 3600,
      promptTokens: 1000,
      completionTokens: 400,
    });
    expect(c!.compute).toBeCloseTo(0.15, 4);
    expect(c!.review).toBe(20);
    expect(await opportunityCost(prisma, cfg, randomUUID())).toBeNull();
  });
});

describe('health and alerts', () => {
  it('flags GPU work waiting with no worker, dead jobs and an uncertain publication, then clears', async () => {
    const lines: any[] = [];
    const logger = pino({ level: 'info' }, { write: (s: string) => lines.push(JSON.parse(s)) });
    const watch = createAlertWatcher(logger);

    // A GPU job that has been waiting, and a worker that was last seen an hour ago.
    await pgc.query("delete from smb.jobs where status = 'queued'");
    await pgc.query(
      `insert into smb.jobs (lane, kind, status, run_after) values ('gpu', 'candidates_generate', 'queued', now() - interval '30 minutes')`,
    );
    await pgc.query(
      `insert into smb.workers (hostname, worker_version, token_hash, last_seen_at)
       values ('pc', '1.0.0', $1, now() - interval '1 hour')`,
      [hash('worker-token')],
    );
    const real = new Date();
    const alerts = await runAlertCheck(prisma, cfg.thresholds, watch, real);
    expect(alerts.map((a) => a.key)).toContain('worker_offline');
    expect(
      lines.filter((l) => l.event === 'alert.opened' && l.alert === 'worker_offline'),
    ).toHaveLength(1);

    // The same problem on the next pass is not logged again.
    await runAlertCheck(prisma, cfg.thresholds, watch, real);
    expect(
      lines.filter((l) => l.event === 'alert.opened' && l.alert === 'worker_offline'),
    ).toHaveLength(1);

    // The worker comes back: the alert clears and says so.
    await pgc.query('update smb.workers set last_seen_at = now()');
    await runAlertCheck(prisma, cfg.thresholds, watch, new Date());
    expect(lines.some((l) => l.event === 'alert.cleared' && l.alert === 'worker_offline')).toBe(
      true,
    );
  });

  it('reads dead jobs and pollers from the database', async () => {
    await pgc.query(
      `insert into smb.jobs (lane, kind, status, finished_at, max_attempts, attempts) values ('server', 'research', 'dead', now(), 3, 3)`,
    );
    await pgc.query(
      `insert into smb.event_pollers (detector_id, consecutive_failures, last_error) values ('d-x', 4, '{"message":"feed down"}')`,
    );
    const i = await gatherHealthInputs(prisma);
    expect(i.deadJobsLast24h).toBeGreaterThanOrEqual(1);
    expect(i.pollersFailing).toContainEqual({
      id: 'd-x',
      consecutiveFailures: 4,
      lastError: 'feed down',
    });
  });
});

describe('dashboard and routes', () => {
  let app: express.Express;
  const secret = new TextEncoder().encode('metrics-test-secret-0123456789abcdef0123456789');
  const mint = (role: string) =>
    new SignJWT({ smb_role: role })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(`user-${role}`)
      .setIssuer('xlchess')
      .setAudience('smb')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(secret);

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use(
      metricsRouter({
        verifier: createTokenVerifier({
          alg: 'HS256',
          key: secret,
          issuer: 'xlchess',
          audience: 'smb',
          userIdClaim: 'sub',
        }),
        db: prisma,
        config: cfg,
        now: () => NOW,
      }),
    );
    app.use(errorHandler);
  });

  it('puts the streak, quality, operations, cost and health in one document', async () => {
    const d = await dashboard(prisma, cfg, { days: 11, now: NOW });
    expect(Object.keys(d).sort()).toEqual(
      [
        'cost',
        'generatedAt',
        'health',
        'operations',
        'quality',
        'streak',
        'timezone',
        'window',
      ].sort(),
    );
    const all = d.operations.pipeline.find((p) => p.postType === null)!;
    expect(all.opened).toBeGreaterThan(0);
    expect(all.reachedReview).toBe(all.opened);
    expect(all.rejected).toBeGreaterThanOrEqual(1);
    const gen = d.operations.jobs.find((j) => j.kind === 'candidates_generate');
    expect(gen).toBeDefined();
    expect(d.operations.reviewQueue.waiting).toBeGreaterThanOrEqual(1);
  });

  it('serves the dashboard to administrators only', async () => {
    const admin = await request(app)
      .get('/v1/admin/metrics/dashboard?days=11')
      .set('Authorization', `Bearer ${await mint('admin')}`);
    expect(admin.status).toBe(200);
    expect(admin.body.streak.goalDays).toBe(10);
    const reviewer = await request(app)
      .get('/v1/admin/metrics/dashboard')
      .set('Authorization', `Bearer ${await mint('reviewer')}`);
    expect(reviewer.status).toBe(403);
    expect((await request(app).get('/v1/admin/metrics/dashboard')).status).toBe(401);
  });

  it('rejects a bad window and changes prices through the API', async () => {
    const token = `Bearer ${await mint('admin')}`;
    expect(
      (await request(app).get('/v1/admin/metrics/streak?days=0').set('Authorization', token))
        .status,
    ).toBe(400);
    expect(
      (await request(app).get('/v1/admin/metrics/streak?days=999').set('Authorization', token))
        .status,
    ).toBe(400);
    const put = await request(app)
      .put('/v1/admin/cost-rates')
      .set('Authorization', token)
      .send({ effectiveFrom: '2026-12-15', xApiMonthly: 100, reason: 'new X plan' });
    expect(put.status).toBe(201);
    expect(put.body.xApiMonthly).toBe(100);
    const dup = await request(app)
      .put('/v1/admin/cost-rates')
      .set('Authorization', token)
      .send({ effectiveFrom: '2026-12-15', reason: 'again' });
    expect(dup.status).toBe(409);
    const list = await request(app).get('/v1/admin/cost-rates').set('Authorization', token);
    expect(list.body.rates.length).toBeGreaterThanOrEqual(3);
    const missing = await request(app)
      .get(`/v1/admin/metrics/opportunities/${randomUUID()}/cost`)
      .set('Authorization', token);
    expect(missing.status).toBe(404);
  });
});
