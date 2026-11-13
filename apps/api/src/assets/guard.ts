import type { PrismaClient } from '@prisma/client';
import type { AssetDeps } from './derive.js';
import { verifyDerived, verifyOriginal, verifyRegion } from './verify.js';

export class AssetIntegrityError extends Error {
  constructor(
    readonly assetId: string,
    readonly reason: string,
  ) {
    super(`Asset ${assetId} cannot be published: ${reason}`);
    this.name = 'AssetIntegrityError';
  }
}

/**
 * Why an asset's photographic integrity is not established, or null when it is. Reads the recorded checks
 * through `smb.asset_integrity_problem`, so it cannot differ from what the database says.
 */
export async function assetIntegrityProblem(
  db: PrismaClient,
  assetId: string,
): Promise<string | null> {
  const rows = await db.$queryRaw<{ problem: string | null }[]>`
    select smb.asset_integrity_problem(${assetId}::uuid) as problem`;
  return rows[0]?.problem ?? null;
}

/** Throws AssetIntegrityError for the first asset whose newest checks are missing or failed. */
export async function assertAssetsIntact(db: PrismaClient, assetIds: string[]): Promise<void> {
  for (const id of assetIds) {
    const problem = await assetIntegrityProblem(db, id);
    if (problem) throw new AssetIntegrityError(id, problem);
  }
}

/**
 * Runs the checks again against the files in Storage right now, for the assets (and the photographs behind
 * them) that are about to be published, then asserts. A recorded check only says the files were fine when it
 * ran; publishing (1.13) calls this so a file changed since then still stops the post.
 * A render's photograph area is re-checked with the area recorded by its last `region_match` check.
 */
export async function ensureAssetsIntact(deps: AssetDeps, assetIds: string[]): Promise<void> {
  for (const id of assetIds) {
    const asset = await deps.db.media_assets.findUnique({ where: { id } });
    if (!asset) throw new AssetIntegrityError(id, 'the asset does not exist');
    if (asset.kind === 'original') {
      await verifyOriginal(deps, id);
    } else if (asset.kind === 'derived') {
      await verifyDerived(deps, id);
    } else if (asset.kind === 'render' && asset.parent_asset_id) {
      const root = await deps.db.$queryRaw<{ id: string }[]>`
        select smb.asset_root(${id}::uuid)::text as id`;
      if (root[0]) await verifyOriginal(deps, root[0].id);
      const last = await deps.db.asset_integrity_checks.findFirst({
        where: { asset_id: id, check_kind: 'region_match' },
        orderBy: { checked_at: 'desc' },
      });
      const d = last?.detail as
        | {
            sourceId?: string;
            rect?: { left: number; top: number; width: number; height: number };
            fit?: 'inside' | 'cover';
          }
        | undefined;
      if (d?.sourceId && d.rect && d.fit) {
        await verifyRegion(deps, { renderId: id, sourceId: d.sourceId, rect: d.rect, fit: d.fit });
      }
    }
  }
  await assertAssetsIntact(deps.db, assetIds);
}
