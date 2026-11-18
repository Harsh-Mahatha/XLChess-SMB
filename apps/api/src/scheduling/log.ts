import type { Prisma } from '@prisma/client';
import type { TriggerOutcome } from './types.js';

export interface TriggerLogEntry {
  postTypeId: string;
  triggerKind: 'schedule' | 'event' | 'manual';
  outcome: TriggerOutcome;
  ruleKey?: string | null;
  slotAt?: Date | null;
  dedupeKey?: string | null;
  opportunityId?: string | null;
  reason: string;
  detail?: Record<string, unknown>;
}

export async function writeTriggerLog(
  tx: Prisma.TransactionClient,
  entry: TriggerLogEntry,
): Promise<void> {
  await tx.trigger_log.create({
    data: {
      post_type_id: entry.postTypeId,
      trigger_kind: entry.triggerKind,
      outcome: entry.outcome,
      rule_key: entry.ruleKey ?? null,
      slot_at: entry.slotAt ?? null,
      dedupe_key: entry.dedupeKey ?? null,
      opportunity_id: entry.opportunityId ?? null,
      reason: entry.reason,
      detail: (entry.detail ?? {}) as Prisma.InputJsonValue,
    },
  });
}
