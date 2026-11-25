import type { Prisma } from '@prisma/client';
import type { FlagDraft, FlagKind } from '@smb/shared';
import { writeChampionshipLog } from './log.js';

function flagKey(kind: string, gameNumber: number | null | undefined): string {
  return `${kind}:${gameNumber ?? 0}`;
}

/**
 * Reconciles the open flags for a championship cycle against `drafts`:
 *  - opens drafts that are not yet open (logs `flag_opened`)
 *  - clears open `auto_clear` flags no longer present in `drafts` (logs `flag_cleared`)
 *  - never touches non-auto-clear flags (`result_corrected`)
 *
 * When `onlyKinds` is given (e.g. during a source outage), only flags of those kinds
 * are opened or cleared; all other open flags stay untouched.
 */
export async function reconcileFlags(
  tx: Prisma.TransactionClient,
  cycleId: string,
  drafts: FlagDraft[],
  now: Date,
  onlyKinds?: FlagKind[],
): Promise<{ opened: number; cleared: number }> {
  const openFlags = await tx.championship_flags.findMany({
    where: { cycle_id: cycleId, status: 'open' },
  });

  const openByKey = new Map(openFlags.map((f) => [flagKey(f.kind, f.game_number), f]));
  const desiredByKey = new Map<string, FlagDraft>();
  for (const d of drafts) {
    if (onlyKinds && !onlyKinds.includes(d.kind)) continue;
    desiredByKey.set(flagKey(d.kind, d.gameNumber), d);
  }

  let opened = 0;
  let cleared = 0;

  for (const [key, draft] of desiredByKey) {
    const existing = openByKey.get(key);
    if (!existing) {
      await tx.championship_flags.create({
        data: {
          cycle_id: cycleId,
          kind: draft.kind,
          severity: draft.severity,
          auto_clear: draft.autoClear,
          game_number: draft.gameNumber ?? null,
          message: draft.message,
          detail: (draft.detail ?? {}) as Prisma.InputJsonValue,
          status: 'open',
          opened_at: now,
        },
      });
      await writeChampionshipLog(tx, {
        cycleId,
        kind: 'flag_opened',
        actor: 'system',
        message: draft.message,
        detail: {
          flagKind: draft.kind,
          severity: draft.severity,
          gameNumber: draft.gameNumber ?? null,
          ...(draft.detail ?? {}),
        },
        at: now,
      });
      opened++;
    } else {
      await tx.championship_flags.update({
        where: { id: existing.id },
        data: {
          message: draft.message,
          detail: (draft.detail ?? {}) as Prisma.InputJsonValue,
        },
      });
    }
  }

  for (const existing of openFlags) {
    if (!existing.auto_clear) continue;
    if (onlyKinds && !onlyKinds.includes(existing.kind as FlagKind)) continue;
    const key = flagKey(existing.kind, existing.game_number);
    if (!desiredByKey.has(key)) {
      await tx.championship_flags.update({
        where: { id: existing.id },
        data: {
          status: 'resolved',
          resolved_at: now,
          resolved_by: 'system',
          resolution_note: 'Condition cleared automatically',
        },
      });
      await writeChampionshipLog(tx, {
        cycleId,
        kind: 'flag_cleared',
        actor: 'system',
        message: `Flag "${existing.kind}" cleared automatically`,
        detail: {
          flagId: existing.id,
          flagKind: existing.kind,
          gameNumber: existing.game_number,
        },
        at: now,
      });
      cleared++;
    }
  }

  return { opened, cleared };
}

/**
 * Opens or updates a manual-resolution flag (such as `result_corrected`) respecting the
 * `(cycle_id, kind, coalesce(game_number, 0)) where status = 'open'` uniqueness constraint.
 */
export async function openManualFlag(
  tx: Prisma.TransactionClient,
  cycleId: string,
  draft: FlagDraft,
  actor: string,
  now: Date,
): Promise<string> {
  const existing = await tx.championship_flags.findFirst({
    where: {
      cycle_id: cycleId,
      kind: draft.kind,
      game_number: draft.gameNumber ?? null,
      status: 'open',
    },
  });

  if (existing) {
    await tx.championship_flags.update({
      where: { id: existing.id },
      data: {
        message: draft.message,
        detail: (draft.detail ?? {}) as Prisma.InputJsonValue,
        opened_at: now,
      },
    });
    await writeChampionshipLog(tx, {
      cycleId,
      kind: 'flag_opened',
      actor,
      message: draft.message,
      detail: {
        flagId: existing.id,
        flagKind: draft.kind,
        gameNumber: draft.gameNumber ?? null,
        updatedExisting: true,
        ...(draft.detail ?? {}),
      },
      at: now,
    });
    return existing.id;
  }

  const created = await tx.championship_flags.create({
    data: {
      cycle_id: cycleId,
      kind: draft.kind,
      severity: draft.severity,
      auto_clear: draft.autoClear,
      game_number: draft.gameNumber ?? null,
      message: draft.message,
      detail: (draft.detail ?? {}) as Prisma.InputJsonValue,
      status: 'open',
      opened_at: now,
    },
  });
  await writeChampionshipLog(tx, {
    cycleId,
    kind: 'flag_opened',
    actor,
    message: draft.message,
    detail: {
      flagId: created.id,
      flagKind: draft.kind,
      gameNumber: draft.gameNumber ?? null,
      ...(draft.detail ?? {}),
    },
    at: now,
  });
  return created.id;
}
