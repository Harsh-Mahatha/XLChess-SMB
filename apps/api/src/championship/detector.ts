import type { PrismaClient } from '@prisma/client';
import type { ChampionshipPhase, SourcesRegistry } from '@smb/shared';
import type { Logger } from 'pino';
import type { EventDetector } from '../events/types.js';
import type { ContextResolvers } from '../scheduling/context.js';
import type { SourceGateway } from '../sources/gateway.js';
import { CHAMPIONSHIP_DETECTOR_ID } from './emit.js';
import { syncCadenceMs } from './mapping.js';
import { syncChampionship } from './sync.js';

export interface ChampionshipDetectorDeps {
  db: PrismaClient;
  gateway: SourceGateway;
  registry?: SourcesRegistry;
  resolvers?: ContextResolvers;
  logger: Logger;
  stabilitySeconds?: number;
}

async function cadenceOf(db: PrismaClient, now: Date) {
  const cycle = await db.championship_cycles.findFirst({
    where: { post_type_id: '1.1', is_current: true },
  });
  if (!cycle) return { cycle: null, cadenceMs: null };
  const cadenceMs = syncCadenceMs(cycle.phase as ChampionshipPhase, cycle.scheduled_start, now, {
    nextRoundAt: cycle.next_round_at,
    anyRoundLive: cycle.any_round_live,
  });
  return { cycle, cadenceMs };
}

/** The World Championship (PT 1.1) feed sync of module 1.15, run as a 1.16 event detector. */
export function championshipDetector(deps: ChampionshipDetectorDeps): EventDetector {
  return {
    id: CHAMPIONSHIP_DETECTOR_ID,
    postTypeId: '1.1',
    mode: 'poll',

    async due({ now }) {
      const { cycle, cadenceMs } = await cadenceOf(deps.db, now);
      if (!cycle || cadenceMs === null) return { due: false, nextDueAt: null };
      if (!cycle.last_synced_at) return { due: true };
      const nextDueAt = new Date(cycle.last_synced_at.getTime() + cadenceMs);
      return nextDueAt <= now ? { due: true } : { due: false, nextDueAt };
    },

    async run({ now }) {
      const summary = await syncChampionship(deps, { now, force: true });
      if (summary.skipped === 'no_cycle') {
        return { outcome: 'skipped', cadenceMs: null, summary };
      }
      const { cadenceMs } = await cadenceOf(deps.db, now);
      if (summary.lastSyncStatus === 'source_error') {
        return {
          outcome: 'failed',
          cadenceMs: cadenceMs ?? 60_000,
          errors: [
            {
              sourceId: '*',
              capability: '*',
              code: 'all_calls_failed',
              message: `${summary.sourceErrors ?? 0} provider call(s) failed`,
            },
          ],
          summary,
        };
      }
      return {
        outcome: (summary.sourceErrors ?? 0) > 0 ? 'partial' : 'ok',
        cadenceMs,
        summary,
      };
    },
  };
}
