import { parseArgs } from 'node:util';
import { getDb } from '../db/client.js';
import { dashboard, type MetricsConfig } from './index.js';

/**
 * Developer tool: the KPI dashboard in the terminal (module 1.19).
 *   npm run metrics:report -- [--days 30] [--post-type 1.1] [--json]
 * Reads SMB_KPI_TIMEZONE, SMB_KPI_REQUIRED_DAILY_VOLUME and the SMB_ALERT_* thresholds. Needs DATABASE_URL.
 */
const { values } = parseArgs({
  options: {
    days: { type: 'string', default: '30' },
    'post-type': { type: 'string' },
    json: { type: 'boolean', default: false },
  },
});
if (!process.env.DATABASE_URL) {
  process.stderr.write('DATABASE_URL is not set\n');
  process.exit(2);
}
const days = Number(values.days);
if (!Number.isInteger(days) || days < 1 || days > 366) {
  process.stderr.write('--days must be a whole number from 1 to 366\n');
  process.exit(2);
}
const num = (name: string, fallback: number): number => {
  const v = Number(process.env[name] ?? fallback);
  return Number.isFinite(v) ? v : fallback;
};
const config: MetricsConfig = {
  timezone: process.env.SMB_KPI_TIMEZONE ?? 'UTC',
  requiredDailyVolume: num('SMB_KPI_REQUIRED_DAILY_VOLUME', 1),
  thresholds: {
    workerOfflineMinutes: num('SMB_ALERT_WORKER_OFFLINE_MINUTES', 10),
    pollerFailures: num('SMB_ALERT_POLLER_FAILURES', 3),
    reviewWaitHours: num('SMB_ALERT_REVIEW_WAIT_HOURS', 6),
  },
};

const db = await getDb();
const d = await dashboard(db, config, { days, postType: values['post-type'] });

if (values.json) {
  process.stdout.write(`${JSON.stringify(d, null, 2)}\n`);
} else {
  const pct = (r: number | null): string => (r === null ? '-' : `${Math.round(r * 100)}%`);
  const mark = { clean: '#', broken: 'X', incomplete: '?', below_volume: '.' } as const;
  const s = d.streak;
  const q = d.quality;
  const c = d.cost;
  const out = process.stdout;
  out.write(`SMB KPIs, ${d.window.from} to ${d.window.to} (${d.timezone})\n\n`);
  out.write(
    `Unedited-approval streak: ${s.current} of ${s.goalDays} days` +
      `${s.goalReached ? ' (goal reached)' : ''}, best ${s.best}, needs ${s.requiredDailyVolume} post(s) a day\n`,
  );
  out.write(`  ${s.days.map((x) => mark[x.status]).join('')}   # clean  X broken  ? undecided  . under volume\n`);
  if (s.brokenOn) out.write(`  last broken on ${s.brokenOn}\n`);
  out.write(
    `\nQuality: decided ${q.totals.decided}, clean ${pct(q.totals.cleanRate)}, ` +
      `unedited ${pct(q.feedback.totals.uneditedApprovalRate)}, rejected ${pct(q.feedback.totals.rejectionRate)}, ` +
      `factual corrections ${pct(q.feedback.totals.factualCorrectionRate)}, ` +
      `image replacement ${pct(q.totals.imageReplacementRate)}\n`,
  );
  out.write(
    `  review time: median ${q.totals.activeReviewTime.medianSeconds ?? '-'} s active ` +
      `(${q.totals.activeReviewTime.posts} posts), ${q.totals.timeToDecision.medianSeconds ?? '-'} s to decision\n`,
  );
  for (const p of q.postTypes) {
    out.write(`  ${p.postType}: decided ${p.decided}, clean ${pct(p.cleanRate)}\n`);
  }
  const all = d.operations.pipeline.find((p) => p.postType === null);
  if (all) {
    out.write(
      `\nOperations: opened ${all.opened} (scheduled ${all.scheduled}), generated ${all.generated}, ` +
        `in review ${all.reachedReview}, approved ${all.approved}, published ${all.published}, failed ${all.failed}\n`,
    );
  }
  for (const j of d.operations.jobs) {
    out.write(
      `  ${j.kind.padEnd(24)} ${String(j.total).padStart(4)} jobs, failed ${j.failed + j.dead}, retried ${j.retried}, ` +
        `median ${j.medianSeconds ?? '-'} s\n`,
    );
  }
  out.write(
    `\nCost (${c.currency}): ${c.total} over ${c.window.from}..${c.window.to}, ` +
      `${c.perApprovedPost ?? '-'} per approved post (${c.approvedPosts} approved)\n` +
      `  compute ${c.compute}, review ${c.review}, hosting ${c.server}, X API ${c.xApi}` +
      `${c.unpriced.length > 0 ? `; not priced: ${c.unpriced.join(', ')}` : ''}\n`,
  );
  out.write(`\nHealth: ${d.health.ok ? 'no active problems' : `${d.health.alerts.length} problem(s)`}\n`);
  for (const a of d.health.alerts) out.write(`  [${a.severity}] ${a.message}\n`);
}
await db.$disconnect();
