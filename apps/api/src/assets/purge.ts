import type { AssetDeps } from './derive.js';

export interface PurgeResult {
  /** Rows the retention rules marked as deleted this run, by rule. */
  retention: { subject: string; affected: number }[];
  /** Files removed from Storage and rows stamped `purged_at`. */
  removed: number;
  /** The row was marked deleted but the file was already gone; the row is still stamped. */
  alreadyGone: number;
  /** Marked deleted but still protected (used by an approved or published post); left alone. */
  skippedProtected: string[];
  failed: { assetId: string; error: string }[];
}

/**
 * Applies the retention rules (module 1.2) and then removes the files of every asset they marked deleted
 * (module 1.9). Provenance rows are never deleted; only the file is. Anything used by an approved or
 * published revision, every ancestor of it and the licence evidence is protected twice: the database rules
 * never mark it, and this job checks again before removing a file.
 *
 * Safe to run repeatedly and on a schedule (1.17). A failed removal leaves `purged_at` empty so the next run
 * tries again.
 */
export async function purgeExpiredAssets(
  deps: AssetDeps,
  now: Date = new Date(),
): Promise<PurgeResult> {
  const rules = await deps.db.$queryRaw<{ subject: string; affected: bigint }[]>`
    select subject, affected from smb.apply_retention(${now}::timestamptz)`;
  const result: PurgeResult = {
    retention: rules.map((r) => ({ subject: r.subject, affected: Number(r.affected) })),
    removed: 0,
    alreadyGone: 0,
    skippedProtected: [],
    failed: [],
  };

  const protectedIds = new Set(
    (await deps.db.$queryRaw<{ id: string }[]>`select smb.protected_asset_ids()::text as id`).map(
      (r) => r.id,
    ),
  );
  const pending = await deps.db.media_assets.findMany({
    where: { deleted_at: { not: null }, purged_at: null, kind: { not: 'evidence' } },
    orderBy: { created_at: 'asc' },
  });
  for (const asset of pending) {
    if (protectedIds.has(asset.id)) {
      result.skippedProtected.push(asset.id);
      continue;
    }
    try {
      const existed = await deps.store.remove(asset.bucket, asset.path);
      await deps.db.media_assets.update({ where: { id: asset.id }, data: { purged_at: now } });
      if (existed) result.removed += 1;
      else result.alreadyGone += 1;
    } catch (err) {
      result.failed.push({
        assetId: asset.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}
