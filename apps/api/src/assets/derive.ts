import type { Prisma, PrismaClient } from '@prisma/client';
import { INTEGRITY_POLICY_VERSION, PhotoTransform, type PhotoTransformInput } from '@smb/shared';
import {
  BUCKETS,
  IMAGE_EXTENSIONS,
  contentPath,
  sha256Hex,
  type ObjectStore,
} from '../storage/index.js';
import { AssetFileError, readVerified } from './files.js';
import { applyTransform, engineInfo, TransformError } from './pixels.js';

export interface AssetDeps {
  db: PrismaClient;
  store: ObjectStore;
}

export class DeriveError extends Error {
  constructor(
    readonly code:
      | 'parent_not_found'
      | 'parent_not_usable'
      | 'parent_file'
      | 'bad_transform'
      | 'transform_failed'
      | 'path_collision',
    message: string,
  ) {
    super(message);
    this.name = 'DeriveError';
  }
}

export interface DeriveRequest {
  /** An original photograph or another derived image. */
  parentId: string;
  transform: PhotoTransformInput;
  opportunityId?: string;
  jobId?: string;
}

export interface DerivedAsset {
  assetId: string;
  parentId: string;
  sha256: string;
  path: string;
  mime: string;
  width: number;
  height: number;
  /** False when an earlier call already made exactly this asset. */
  created: boolean;
}

type Db = Prisma.TransactionClient | PrismaClient;

/**
 * Makes a derived image from a stored photograph with a permitted transform and records it (module 1.9).
 *
 *  1. The parent's file is read back and its hash checked first, so a damaged or swapped original is never
 *     used as a source.
 *  2. The transform is validated against the permitted-steps schema.
 *  3. The result is stored content-addressed in the `derived` bucket, with the transform on its row and a first
 *     integrity check recording which Sharp/libvips made it.
 *
 * Asking again for the same parent and transform returns the stored asset.
 */
export async function deriveAsset(deps: AssetDeps, req: DeriveRequest): Promise<DerivedAsset> {
  const parsed = PhotoTransform.safeParse(req.transform);
  if (!parsed.success) {
    throw new DeriveError(
      'bad_transform',
      `transform not permitted: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'transform'}: ${i.message}`).join('; ')}`,
    );
  }
  const transform = parsed.data;

  const parent = await deps.db.media_assets.findUnique({ where: { id: req.parentId } });
  if (!parent) throw new DeriveError('parent_not_found', `asset ${req.parentId} does not exist`);
  if (parent.kind !== 'original' && parent.kind !== 'derived') {
    throw new DeriveError('parent_not_usable', `a ${parent.kind} asset cannot be a photo source`);
  }
  if (parent.deleted_at) {
    throw new DeriveError('parent_not_usable', 'the source photograph was deleted');
  }

  const transformJson = transform as unknown as Prisma.InputJsonValue;
  const prior = await deps.db.media_assets.findFirst({
    where: {
      kind: 'derived',
      parent_asset_id: parent.id,
      transform: { equals: transformJson },
      deleted_at: null,
    },
  });
  if (prior) return toResult(prior, false);

  let source: Uint8Array;
  try {
    source = await readVerified(deps.store, parent);
  } catch (err) {
    if (err instanceof AssetFileError) {
      throw new DeriveError('parent_file', `source photograph failed its check: ${err.message}`);
    }
    throw err;
  }

  let out;
  try {
    out = await applyTransform(source, transform);
  } catch (err) {
    if (err instanceof TransformError) throw new DeriveError('transform_failed', err.message);
    throw new DeriveError(
      'transform_failed',
      `the image could not be processed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const sha256 = sha256Hex(out.bytes);
  const path = contentPath(sha256, IMAGE_EXTENSIONS[out.mime]);
  await deps.store.put(BUCKETS.derived, path, out.bytes, out.mime);

  return deps.db.$transaction(async (tx) => {
    const existing = await tx.media_assets.findUnique({
      where: { bucket_path: { bucket: BUCKETS.derived, path } },
    });
    if (existing) {
      if (existing.parent_asset_id !== parent.id) {
        throw new DeriveError(
          'path_collision',
          `${path} already belongs to another asset (${existing.id})`,
        );
      }
      return toResult(existing, false);
    }
    const row = await tx.media_assets.create({
      data: {
        kind: 'derived',
        bucket: BUCKETS.derived,
        path,
        sha256,
        mime: out.mime,
        size_bytes: out.bytes.byteLength,
        width: out.width,
        height: out.height,
        parent_asset_id: parent.id,
        transform: transformJson,
        opportunity_id: req.opportunityId ?? parent.opportunity_id,
        job_id: req.jobId,
      },
    });
    await recordCreationCheck(tx, row.id, sha256, parent.sha256);
    if (parent.kind === 'original') {
      // The parent's file was just read back and matched its recorded hash.
      await tx.asset_integrity_checks.create({
        data: {
          asset_id: parent.id,
          check_kind: 'original_hash',
          passed: true,
          failures: [],
          detail: { sha256: parent.sha256, during: 'derive' },
          engine: engineInfo(),
          policy_version: INTEGRITY_POLICY_VERSION,
        },
      });
    }
    return toResult(row, true);
  });
}

async function recordCreationCheck(
  db: Db,
  assetId: string,
  outputSha256: string,
  parentSha256: string,
): Promise<void> {
  await db.asset_integrity_checks.create({
    data: {
      asset_id: assetId,
      check_kind: 'derived_rebuild',
      passed: true,
      failures: [],
      detail: { created: true, exact: true, outputSha256, parentSha256 },
      engine: engineInfo(),
      policy_version: INTEGRITY_POLICY_VERSION,
    },
  });
}

function toResult(
  row: {
    id: string;
    parent_asset_id: string | null;
    sha256: string;
    path: string;
    mime: string;
    width: number | null;
    height: number | null;
  },
  created: boolean,
): DerivedAsset {
  return {
    assetId: row.id,
    parentId: row.parent_asset_id!,
    sha256: row.sha256,
    path: row.path,
    mime: row.mime,
    width: row.width!,
    height: row.height!,
    created,
  };
}
