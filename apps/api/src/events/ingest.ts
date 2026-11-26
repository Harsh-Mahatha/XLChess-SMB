import type { Prisma, PrismaClient } from '@prisma/client';
import { DetectedEventPayload, materialHash } from '@smb/shared';
import type { Logger } from 'pino';
import { writeTriggerLog } from '../scheduling/log.js';
import { openOpportunityIn } from '../scheduling/open.js';
import type { OpenResult } from '../scheduling/types.js';
import { EventIdentityConflict, type IngestArgs, type IngestResult } from './types.js';

export interface IngestDeps {
  db: PrismaClient;
  now?: Date;
  logger?: Logger;
}

type Tx = Prisma.TransactionClient;
type EventRow = Awaited<ReturnType<Tx['detected_events']['findUniqueOrThrow']>>;

/**
 * The only writer of `smb.detected_events` (1.16 D1, D4, D5).
 *  - new identity: records version 1 and, when `trigger` is given, opens the opportunity in the same transaction;
 *  - same identity, same material facts: a replay. Counts it and opens nothing, unless the event has no
 *    opportunity yet (for example it was refused before its phase began), when it tries `trigger` again;
 *  - same identity, different facts: a correction. Needs `reason`, adds a version, never opens a second opportunity.
 * Locks: `smb.event:<identity>` then `smb.sched:<postType>`, always in that order.
 */
export async function ingestEvent(deps: IngestDeps, args: IngestArgs): Promise<IngestResult> {
  const now = deps.now ?? new Date();
  const payload = DetectedEventPayload.parse(args.payload);
  const hash = materialHash(payload);
  const identityKey = payload.identityKey;

  return deps.db.$transaction(async (tx) => {
    await tx.$executeRaw`select pg_advisory_xact_lock(hashtext(${'smb.event:' + identityKey}))`;
    const existing = await tx.detected_events.findUnique({ where: { identity_key: identityKey } });

    if (!existing) {
      const created = await tx.detected_events.create({
        data: {
          identity_key: identityKey,
          kind: payload.kind,
          post_type_id: args.postTypeId,
          detector_id: args.detectorId,
          payload: payload as unknown as Prisma.InputJsonValue,
          material_hash: hash,
          state: args.recordAs ?? 'recorded',
          first_seen_at: now,
          last_seen_at: now,
        },
      });
      await tx.detected_event_versions.create({
        data: {
          event_id: created.id,
          version: 1,
          payload: payload as unknown as Prisma.InputJsonValue,
          material_hash: hash,
          reason: 'first_seen',
          actor: args.actor,
          at: now,
        },
      });
      if (args.trigger && !args.recordAs) {
        const { row, open } = await openFor(tx, created, args, now);
        return result('created', row, open);
      }
      return result('created', created);
    }

    if (existing.material_hash === hash) {
      let row = await tx.detected_events.update({
        where: { id: existing.id },
        data: { last_seen_at: now, seen_count: { increment: 1 } },
      });
      if (row.opportunity_id) {
        await writeTriggerLog(tx, {
          postTypeId: row.post_type_id,
          triggerKind: 'event',
          outcome: 'duplicate',
          dedupeKey: null,
          opportunityId: row.opportunity_id,
          slotAt: now,
          reason: `Replay of ${identityKey} (v${row.version}); opportunity already exists`,
          detail: { identityKey, eventId: row.id, version: row.version, seenCount: row.seen_count },
        });
        return result('replay', row);
      }
      if (args.recordAs) {
        if (row.state !== args.recordAs) {
          row = await tx.detected_events.update({
            where: { id: row.id },
            data: { state: args.recordAs, refusal_code: null },
          });
        }
        return result('replay', row);
      }
      if (args.trigger && row.state !== 'stale_skipped') {
        const { row: opened, open } = await openFor(tx, row, args, now);
        return result('replay', opened, open);
      }
      return result('replay', row);
    }

    // Different facts for a known identity: only an explicit correction may change them (D5).
    if (!args.reason) throw new EventIdentityConflict(identityKey, existing.version);

    const version = existing.version + 1;
    const corrected = await tx.detected_events.update({
      where: { id: existing.id },
      data: {
        version,
        payload: payload as unknown as Prisma.InputJsonValue,
        material_hash: hash,
        corrected_at: now,
        last_seen_at: now,
        seen_count: { increment: 1 },
      },
    });
    await tx.detected_event_versions.create({
      data: {
        event_id: existing.id,
        version,
        payload: payload as unknown as Prisma.InputJsonValue,
        material_hash: hash,
        reason: args.reason,
        actor: args.actor,
        at: now,
      },
    });
    await tx.audit_log.create({
      data: {
        actor: args.actor,
        action: 'event.correct',
        target_type: 'detected_event',
        target_id: existing.id,
        details: {
          identityKey,
          fromVersion: existing.version,
          toVersion: version,
          reason: args.reason,
          opportunityId: existing.opportunity_id,
        },
      },
    });
    return {
      status: 'corrected',
      eventId: corrected.id,
      version,
      previousVersion: existing.version,
      state: corrected.state,
      opportunityId: corrected.opportunity_id,
    };
  });
}

async function openFor(
  tx: Tx,
  row: EventRow,
  args: IngestArgs,
  now: Date,
): Promise<{ row: EventRow; open: OpenResult }> {
  await tx.$executeRaw`select pg_advisory_xact_lock(hashtext(${'smb.sched:' + args.postTypeId}))`;
  const open = await openOpportunityIn(tx, args.trigger!, now);

  if (open.status === 'refused') {
    const updated = await tx.detected_events.update({
      where: { id: row.id },
      data: { state: 'refused', refusal_code: open.code },
    });
    return { row: updated, open };
  }

  // Link the opportunity to the event version it was built from. A duplicate opened before the
  // ledger existed (1.15) is linked too, but an opportunity already linked keeps its link.
  await tx.post_opportunities.updateMany({
    where: { id: open.opportunityId, trigger_event_id: null },
    data: { trigger_event_id: row.id, trigger_event_version: row.version },
  });
  const updated = await tx.detected_events.update({
    where: { id: row.id },
    data: { state: 'opportunity_created', opportunity_id: open.opportunityId, refusal_code: null },
  });
  return { row: updated, open };
}

function result(status: 'created' | 'replay', row: EventRow, open?: OpenResult): IngestResult {
  return {
    status,
    eventId: row.id,
    version: row.version,
    state: row.state,
    opportunityId: row.opportunity_id,
    ...(open ? { open } : {}),
  };
}
