import { enqueueJob, expireStaleJobs, reapExpiredLeases } from '../jobs/index.js';
import { advanceAll, type AdvanceResult } from './advance.js';
import { applyCorrections, skipStaleOpportunities, type CorrectionResult } from './corrections.js';
import { nowOf, type WorkflowDeps } from './types.js';

export interface TickResult {
  /** False when another API instance held the tick lock. Nothing ran. */
  ran: boolean;
  corrected: CorrectionResult[];
  staleSkipped: string[];
  reaped: { id: string; kind: string; status: string }[];
  expiredJobs: number;
  advanced: AdvanceResult[];
  errors: { opportunityId: string; error: string }[];
}

const dayKey = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * One pass of the orchestrator. Safe to run from every API instance: a transaction-scoped advisory lock lets one
 * instance work at a time, and every step is idempotent anyway.
 *
 *  1. Facts corrected after an opportunity was built send it back to research.
 *  2. Opportunities past their `not_after` are skipped as stale; their waiting jobs expire.
 *  3. Leases that stopped heartbeating are put back in the queue (or stopped when attempts are used up).
 *  4. Each opportunity still being built is advanced to the step it is missing.
 *  5. Today's asset purge is queued.
 */
export async function runWorkflowTick(deps: WorkflowDeps): Promise<TickResult> {
  const now = nowOf(deps);
  const empty: TickResult = {
    ran: false,
    corrected: [],
    staleSkipped: [],
    reaped: [],
    expiredJobs: 0,
    advanced: [],
    errors: [],
  };
  return deps.db.$transaction(
    async (tx) => {
      const lock = await tx.$queryRaw<{ locked: boolean }[]>`
        select pg_try_advisory_xact_lock(hashtext('smb.workflow.tick')) as locked`;
      if (!lock[0]?.locked) return empty;
      const corrected = await applyCorrections(deps.db, now);
      const staleSkipped = await skipStaleOpportunities(deps.db, now);
      const reaped = await reapExpiredLeases(deps.db, now);
      const expired = await expireStaleJobs(deps.db, now);
      const { results, errors } = await advanceAll(deps);
      await enqueueJob(deps.db, {
        kind: 'assets_purge',
        idempotencyKey: `assets_purge:${dayKey(now)}`,
        priority: 900,
        notAfter: new Date(now.getTime() + 24 * 3600 * 1000),
      });
      return {
        ran: true,
        corrected,
        staleSkipped,
        reaped,
        expiredJobs: expired.length,
        advanced: results,
        errors,
      };
    },
    { timeout: 10 * 60 * 1000, maxWait: 5000 },
  );
}
