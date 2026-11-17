import { parseArgs } from 'node:util';
import { getDb } from '../db/client.js';
import { feedbackCorrections, feedbackSummary, type OutcomeCounts } from './feedback.js';

/**
 * Developer tool: the acceptance and correction figures by post type (module 1.12).
 *   npm run feedback:report -- [--post-type 1.1] [--from 2026-11-01] [--to 2026-12-01] [--corrections] [--json]
 * `--corrections` also lists what reviewers changed and said. Needs DATABASE_URL.
 */
const { values } = parseArgs({
  options: {
    'post-type': { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
    corrections: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
  },
});
if (!process.env.DATABASE_URL) {
  process.stderr.write('DATABASE_URL is not set\n');
  process.exit(2);
}
const date = (name: 'from' | 'to'): Date | undefined => {
  const raw = values[name];
  if (!raw) return undefined;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    process.stderr.write(`--${name} is not a date: ${raw}\n`);
    process.exit(2);
  }
  return d;
};
const period = { from: date('from'), to: date('to'), postType: values['post-type'] };

const db = await getDb();
const summary = await feedbackSummary(db, period);
const corrections = values.corrections ? await feedbackCorrections(db, period) : undefined;

if (values.json) {
  process.stdout.write(`${JSON.stringify({ summary, corrections }, null, 2)}\n`);
} else {
  const pct = (r: number | null): string => (r === null ? '-' : `${Math.round(r * 100)}%`);
  const line = (label: string, c: OutcomeCounts): string =>
    `${label.padEnd(28)} reviewed ${String(c.reviewed).padStart(3)}  decided ${String(c.decided).padStart(3)}  ` +
    `unedited ${String(c.approvedUnedited).padStart(3)} (${pct(c.uneditedApprovalRate)})  first-pass ${pct(c.firstPassRate)}  ` +
    `rejected ${pct(c.rejectionRate)}  regen/post ${c.averageRegenerations ?? '-'}  ` +
    `edits ${c.humanEdits} (factual ${c.factualEdits}, creative ${c.creativeEdits}, unlabelled ${c.unclassifiedEdits})`;
  process.stdout.write(`${line('ALL POST TYPES', summary.totals)}\n`);
  for (const p of summary.postTypes) {
    process.stdout.write(`\n${line(`post type ${p.postType}`, p)}\n`);
    for (const v of p.byPromptVersion) process.stdout.write(`${line(`  ${v.promptVersion}`, v)}\n`);
    if (p.tags.length > 0) {
      process.stdout.write(
        `  tags: ${p.tags.map((t) => `${t.tag} x${t.count} [${t.category}]`).join(', ')}\n`,
      );
    }
    if (p.rejectedAngles.length > 0) {
      process.stdout.write(
        `  rejected angles: ${p.rejectedAngles.map((a) => `${a.angle} x${a.count}`).join(', ')}\n`,
      );
    }
  }
  if (corrections) {
    process.stdout.write(`\nEDITS (${corrections.edits.length})\n`);
    for (const e of corrections.edits) {
      process.stdout.write(
        `- ${e.at} ${e.postType} ${e.slot} [${e.kind ?? 'unlabelled'}] ${e.tags.join(',')} ${e.note ?? ''}\n`,
      );
      for (const c of e.changes) {
        process.stdout.write(
          `    ${c.field}\n      - ${c.before ?? ''}\n      + ${c.after ?? ''}\n`,
        );
      }
    }
    process.stdout.write(`\nFEEDBACK (${corrections.feedback.length})\n`);
    for (const f of corrections.feedback) {
      process.stdout.write(
        `- ${f.at} ${f.postType} ${f.action} ${f.tags.join(',')} ${f.feedback ?? ''}\n`,
      );
    }
  }
}
await db.$disconnect();
