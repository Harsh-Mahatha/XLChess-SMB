import type { PrismaClient } from '@prisma/client';

export class AssetLicenceError extends Error {
  constructor(
    readonly assetId: string,
    readonly reason: string,
  ) {
    super(`Asset ${assetId} cannot be published: ${reason}`);
    this.name = 'AssetLicenceError';
  }
}

/**
 * Why an asset may not enter a post, or null when it may. Asks the database rule that also blocks inserts into
 * revision_assets, so the check at publish time and at attach time cannot differ.
 */
export async function assetLicenceProblem(
  db: PrismaClient,
  assetId: string,
): Promise<string | null> {
  const rows = await db.$queryRaw<{ problem: string | null }[]>`
    select smb.asset_licence_problem(${assetId}::uuid) as problem`;
  return rows[0]?.problem ?? null;
}

/** Throws AssetLicenceError for the first asset that is not cleared. Publishing (1.13) calls this before posting. */
export async function assertAssetsLicensed(db: PrismaClient, assetIds: string[]): Promise<void> {
  for (const id of assetIds) {
    const problem = await assetLicenceProblem(db, id);
    if (problem) throw new AssetLicenceError(id, problem);
  }
}
