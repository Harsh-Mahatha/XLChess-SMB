/* eslint-disable no-console -- command-line tool */
import { parseArgs } from 'node:util';
import { championshipDetector, championshipResolver } from '../championship/index.js';
import { loadConfigSet } from '../config/loader.js';
import { getDb } from '../db/client.js';
import { loadEnv } from '../env.js';
import { createLogger } from '../logger.js';
import { ContextResolvers } from '../scheduling/context.js';
import { PrismaSourceRecordStore, createSourceGateway } from '../sources/index.js';
import { runEventPoll } from './poll.js';
import { DetectorRegistry } from './registry.js';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    only: { type: 'string' },
    force: { type: 'boolean', default: false },
    now: { type: 'string' },
    id: { type: 'string' },
    identity: { type: 'string' },
    limit: { type: 'string', default: '20' },
  },
});

const command = positionals[0] ?? 'status';
const env = loadEnv();
const logger = createLogger(env);
const db = await getDb();

function detectorsFor() {
  const configSet = loadConfigSet();
  const resolvers = new ContextResolvers();
  resolvers.register('1.1', championshipResolver(db));
  const gateway = createSourceGateway(configSet.sources, new PrismaSourceRecordStore(db));
  return new DetectorRegistry().register(
    championshipDetector({
      db,
      gateway,
      registry: configSet.sources,
      resolvers,
      logger,
      stabilitySeconds: env.SMB_EVENTS_STABILITY_SECONDS,
    }),
  );
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : '-');

try {
  if (command === 'poll') {
    const now = values.now ? new Date(values.now) : undefined;
    if (now && Number.isNaN(now.getTime())) throw new Error(`Invalid --now: ${values.now}`);
    const summary = await runEventPoll(
      { db, detectors: detectorsFor(), logger },
      { now, only: values.only, force: values.force },
    );
    console.log(JSON.stringify(summary, null, 2));
  } else if (command === 'status') {
    const detectors = detectorsFor();
    const pollers = await db.event_pollers.findMany();
    const byId = new Map(pollers.map((p) => [p.detector_id, p]));
    console.log('Detectors:');
    for (const d of detectors.list()) {
      const p = byId.get(d.id);
      console.log(
        `  ${d.id}  ${p?.enabled === false ? 'PAUSED' : 'enabled'}  last=${p?.last_outcome ?? '-'} at ${iso(p?.last_run_at)}  ` +
          `success=${iso(p?.last_success_at)}  failures=${p?.consecutive_failures ?? 0}  next=${iso(p?.next_due_at)}`,
      );
      if (p?.last_error && p.consecutive_failures > 0) {
        console.log(`    last error: ${JSON.stringify(p.last_error)}`);
      }
    }
    const limit = Number.parseInt(values.limit ?? '20', 10);
    const events = await db.detected_events.findMany({
      orderBy: { first_seen_at: 'desc' },
      take: Number.isFinite(limit) && limit > 0 ? limit : 20,
    });
    console.log(`\nRecent events (${events.length}):`);
    for (const e of events) {
      console.log(
        `  ${iso(e.first_seen_at)}  ${e.identity_key}  v${e.version}  ${e.state}` +
          `${e.refusal_code ? ` (${e.refusal_code})` : ''}  seen=${e.seen_count}  opp=${e.opportunity_id ?? '-'}`,
      );
    }
  } else if (command === 'show') {
    if (!values.id && !values.identity) throw new Error('Give --id <uuid> or --identity <key>');
    const event = await db.detected_events.findFirst({
      where: values.id ? { id: values.id } : { identity_key: values.identity },
    });
    if (!event) {
      console.log('Event not found.');
      process.exitCode = 1;
    } else {
      const versions = await db.detected_event_versions.findMany({
        where: { event_id: event.id },
        orderBy: { version: 'asc' },
      });
      const opp = event.opportunity_id
        ? await db.post_opportunities.findUnique({
            where: { id: event.opportunity_id },
            select: { id: true, status: true, trigger_event_version: true },
          })
        : null;
      console.log(
        JSON.stringify(
          {
            event,
            opportunity: opp && {
              ...opp,
              stale: (opp.trigger_event_version ?? event.version) < event.version,
            },
            versions,
          },
          null,
          2,
        ),
      );
    }
  } else {
    console.error(`Unknown command "${command}". Use poll, status or show.`);
    process.exitCode = 2;
  }
} finally {
  await db.$disconnect();
}
