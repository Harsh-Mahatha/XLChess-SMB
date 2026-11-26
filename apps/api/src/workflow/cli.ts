/* eslint-disable no-console -- command-line tool */
import { parseArgs } from 'node:util';
import { loadConfigSet, syncConfigs, syncSources } from '../config/index.js';
import { getDb } from '../db/client.js';
import { loadEnv } from '../env.js';
import { createLogger } from '../logger.js';
import { InMemoryObjectStore, SupabaseObjectStore, type ObjectStore } from '../storage/index.js';
import { ResumeError, resumeOpportunity } from './resume.js';
import { createWorkflowDeps } from './factory.js';
import { runAvailableJobs } from './runner.js';
import { runWorkflowTick } from './tick.js';

/**
 * Developer and operator tool for the workflow (module 1.17).
 *   npm run workflow:tick                      one orchestrator pass (corrections, stale work, lease reaping, advance)
 *   npm run workflow:run [-- --budget 20]      run queued jobs until none is runnable
 *   npm run workflow:status [-- --opportunity <id>]   counts, and what is stuck or failed
 *   npm run workflow:retry -- --opportunity <id>      retry a failed opportunity from the step that failed
 * Needs DATABASE_URL. `tick` and `run` also need SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or --store memory
 * against a throwaway database).
 */
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    budget: { type: 'string', default: '20' },
    opportunity: { type: 'string' },
    store: { type: 'string', default: 'supabase' },
  },
});
const command = positionals[0] ?? 'status';
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set');
  process.exit(2);
}

const env = loadEnv();
const db = await getDb();

function objectStore(): ObjectStore {
  if (values.store === 'memory') return new InMemoryObjectStore();
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are needed (or use --store memory)');
    process.exit(2);
  }
  return new SupabaseObjectStore({
    url: env.SUPABASE_URL,
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
  });
}

async function deps() {
  const configSet = loadConfigSet();
  await syncSources(db, configSet.sources, 'workflow-cli');
  await syncConfigs(db, configSet, 'workflow-cli');
  return createWorkflowDeps({
    db,
    store: objectStore(),
    configSet,
    env,
    logger: createLogger(env),
  });
}

try {
  if (command === 'tick') {
    console.log(JSON.stringify(await runWorkflowTick(await deps()), null, 2));
  } else if (command === 'run') {
    const out = await runAvailableJobs(await deps(), {
      budget: Number(values.budget),
      concurrency: env.SMB_RUNNER_CONCURRENCY,
    });
    for (const o of out)
      console.log(`${o.kind} ${o.jobId} ${o.outcome}${o.error ? `: ${o.error}` : ''}`);
    console.log(`${out.length} job(s) run`);
  } else if (command === 'retry') {
    if (!values.opportunity) {
      console.error('usage: workflow:retry -- --opportunity <id>');
      process.exit(2);
    }
    const r = await resumeOpportunity(db, values.opportunity, 'cli');
    console.log(
      `resumed at ${r.step}; requeued: ${r.requeued.map((j) => j.kind).join(', ') || 'none'}`,
    );
  } else if (command === 'status') {
    const jobs = await db.jobs.groupBy({
      by: ['kind', 'status'],
      _count: true,
      ...(values.opportunity && { where: { opportunity_id: values.opportunity } }),
    });
    console.log('jobs:');
    for (const j of jobs) console.log(`  ${j.kind.padEnd(24)} ${j.status.padEnd(10)} ${j._count}`);
    const stuck = await db.post_opportunities.findMany({
      where: {
        ...(values.opportunity
          ? { id: values.opportunity }
          : { status: { in: ['failed', 'skipped'] } }),
      },
      orderBy: { updated_at: 'desc' },
      take: 20,
    });
    console.log('opportunities:');
    for (const o of stuck) {
      console.log(
        `  ${o.id} ${o.status}${o.failed_step ? ` at ${o.failed_step}` : ''}${o.failure_reason ? `: ${o.failure_reason}` : ''}`,
      );
    }
  } else {
    console.error('usage: workflow tick | run | status | retry');
    process.exit(2);
  }
} catch (err) {
  console.error(err instanceof ResumeError ? `${err.code}: ${err.message}` : err);
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
