import type { PrismaClient } from '@prisma/client';
import type { ContextResolver } from '../scheduling/context.js';

export function championshipResolver(db: PrismaClient): ContextResolver {
  return {
    async resolve({ postTypeId, db: txOrDb }) {
      const client = txOrDb ?? db;
      const cycle = await client.championship_cycles.findFirst({
        where: { post_type_id: postTypeId, is_current: true },
      });

      if (!cycle) {
        return {
          kind: 'hold',
          code: 'no_championship_record',
          reason:
            'No World Championship record is registered; register one with POST /v1/championships',
        };
      }

      const blocking = await client.championship_flags.findFirst({
        where: { cycle_id: cycle.id, status: 'open', severity: 'blocking' },
        orderBy: { opened_at: 'asc' },
      });
      if (blocking) {
        return {
          kind: 'hold',
          code: blocking.kind,
          reason: blocking.message,
        };
      }

      const sourceRefs = (cycle.source_event_refs ?? {}) as Record<string, string>;
      return {
        kind: 'ready',
        context: {
          phase: cycle.phase,
          subject: {
            eventRefs: { ...sourceRefs, D1: cycle.cycle_key },
          },
          eventKey: cycle.cycle_key,
        },
      };
    },
  };
}
