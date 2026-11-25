/* eslint-disable no-console -- command-line tool */
import { parseArgs } from 'node:util';
import { PostTypeConfig, isTimedRule, occurrencesBetween, resolvePhase } from '@smb/shared';
import { getDb } from '../db/client.js';
import { loadEnv } from '../env.js';
import { createLogger } from '../logger.js';
import { ContextResolvers } from './context.js';
import { runSchedulerTick } from './tick.js';
import { championshipResolver } from '../championship/resolver.js';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    now: { type: 'string' },
    'post-type': { type: 'string' },
    days: { type: 'string', default: '14' },
    phase: { type: 'string' },
  },
});

const command = positionals[0] ?? 'status';
const env = loadEnv();
const logger = createLogger(env);
const db = await getDb();

try {
  if (command === 'tick') {
    const now = values.now ? new Date(values.now) : new Date();
    const resolvers = new ContextResolvers();
    resolvers.register('1.1', championshipResolver(db));
    const summary = await runSchedulerTick({ db, resolvers, logger }, { now });
    console.log(JSON.stringify(summary, null, 2));
  } else if (command === 'status') {
    const schedules = await db.schedules.findMany({
      orderBy: [{ post_type_id: 'asc' }, { rule_key: 'asc' }],
    });

    console.log(`\nSchedules (${schedules.length}):`);
    if (schedules.length > 0) {
      console.table(
        schedules.map((s) => ({
          postType: s.post_type_id,
          ruleKey: s.rule_key,
          state: s.state,
          reason: s.inactive_reason ?? '-',
          cursor: s.cursor_at.toISOString(),
          nextRun: s.next_run_at ? s.next_run_at.toISOString() : '-',
          lastOutcome: s.last_outcome ?? '-',
        })),
      );
    } else {
      console.log('No schedule rows found.');
    }

    const holds = await db.schedule_holds.findMany({
      orderBy: { post_type_id: 'asc' },
    });
    console.log(`\nActive Holds (${holds.length}):`);
    if (holds.length > 0) {
      console.table(
        holds.map((h) => ({
          postType: h.post_type_id,
          until: h.suspended_until ? h.suspended_until.toISOString() : 'indefinite',
          reason: h.reason,
          by: h.created_by,
        })),
      );
    } else {
      console.log('No active holds.');
    }
  } else if (command === 'preview') {
    const postTypeId = values['post-type'];
    if (!postTypeId) {
      console.error(
        'Usage: schedule:preview --post-type <id> [--days 14] [--phase <phase>] [--now <ISO>]',
      );
      process.exit(1);
    }

    const activeConfigRow = await db.post_configs.findFirst({
      where: { post_type_id: postTypeId, is_active: true },
    });
    if (!activeConfigRow) {
      console.error(`No active config found for post type "${postTypeId}".`);
      process.exit(1);
    }

    const config = PostTypeConfig.parse(activeConfigRow.config_json);
    const phase = values.phase ?? null;
    const effective = resolvePhase(config, phase);
    const timedRules = effective.schedule.filter(isTimedRule);

    const now = values.now ? new Date(values.now) : new Date();
    const days = Number.parseInt(values.days ?? '14', 10);
    const horizon = new Date(now.getTime() + days * 86_400_000);

    console.log(
      `Previewing slots for ${postTypeId} (phase: ${phase ?? 'base'}, tz: ${config.timezone})`,
    );
    console.log(`Window: ${now.toISOString()} to ${horizon.toISOString()} (${days} days)\n`);

    const previewRows: { rule: string; slotUtc: string; slotLocal: string }[] = [];
    for (const rule of timedRules) {
      const slots = occurrencesBetween(rule, config.timezone, now, horizon, now);
      for (const slot of slots) {
        previewRows.push({
          rule:
            rule.kind === 'weekly'
              ? `${rule.day} ${rule.time}`
              : rule.kind === 'daily'
                ? `daily ${rule.time}`
                : `every ${rule.everyMinutes}m`,
          slotUtc: slot.toISOString(),
          slotLocal: slot.toLocaleString('en-US', { timeZone: config.timezone }),
        });
      }
    }

    if (previewRows.length > 0) {
      console.table(previewRows);
    } else {
      console.log('No slots found in this time window.');
    }
  } else {
    console.error(`Unknown command "${command}". Available commands: tick, status, preview.`);
    process.exit(1);
  }
} finally {
  await db.$disconnect();
}
