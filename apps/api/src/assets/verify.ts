import type { Prisma } from '@prisma/client';
import sharp from 'sharp';
import {
  INTEGRITY_POLICY_VERSION,
  INTEGRITY_THRESHOLDS,
  PhotoTransform,
  transformProblems,
  type IntegrityCheckKind,
  type IntegrityFailureCode,
  type IntegrityReport,
} from '@smb/shared';
import { sha256Hex } from '../storage/index.js';
import type { AssetDeps } from './derive.js';
import { AssetFileError, readVerified } from './files.js';
import {
  applyTransform,
  comparePixels,
  decodeOriented,
  decodeRgb,
  engineInfo,
  judgeComparison,
  sameEngine,
  type RawImage,
} from './pixels.js';

/**
 * Integrity checks (module 1.9). "Done when": source photo identity is preserved and verifiable by hash and
 * permitted-transform checks.
 *
 *  - `verifyOriginal`  the stored file is the file that was downloaded (hash, name, real size).
 *  - `verifyDerived`   a derived image is exactly what its recorded transform makes of its parent: the
 *                      transform is permitted, the parent is intact, and rebuilding it gives the same pixels.
 *  - `verifyRegion`    the photograph area of a finished graphic matches the photograph it was composed from.
 *
 * Every check is recorded in `asset_integrity_checks` (append-only); `smb.asset_integrity_problem()` reads them.
 */

type ReportDraft = {
  kind: IntegrityCheckKind;
  failures: IntegrityFailureCode[];
  detail: Record<string, unknown>;
};

async function record(deps: AssetDeps, assetId: string, d: ReportDraft): Promise<IntegrityReport> {
  const failures = [...new Set(d.failures)];
  await deps.db.asset_integrity_checks.create({
    data: {
      asset_id: assetId,
      check_kind: d.kind,
      passed: failures.length === 0,
      failures,
      detail: d.detail as Prisma.InputJsonValue,
      engine: engineInfo(),
      policy_version: INTEGRITY_POLICY_VERSION,
    },
  });
  return { assetId, kind: d.kind, passed: failures.length === 0, failures, detail: d.detail };
}

const fileFailure = (err: unknown): IntegrityFailureCode | undefined =>
  err instanceof AssetFileError ? err.code : undefined;

/** Reads a file and returns its bytes, or the failure and message explaining why not. */
async function read(
  deps: AssetDeps,
  asset: { id: string; bucket: string; path: string; sha256: string },
): Promise<{ bytes: Uint8Array } | { failure: IntegrityFailureCode; message: string }> {
  try {
    return { bytes: await readVerified(deps.store, asset) };
  } catch (err) {
    const code = fileFailure(err);
    if (code) return { failure: code, message: (err as Error).message };
    throw err;
  }
}

export async function verifyOriginal(deps: AssetDeps, assetId: string): Promise<IntegrityReport> {
  const asset = await deps.db.media_assets.findUniqueOrThrow({ where: { id: assetId } });
  if (asset.kind !== 'original')
    throw new Error(`asset ${assetId} is a ${asset.kind}, not an original`);
  const got = await read(deps, asset);
  if ('failure' in got) {
    return record(deps, assetId, {
      kind: 'original_hash',
      failures: [got.failure],
      detail: { message: got.message, expectedSha256: asset.sha256 },
    });
  }
  const failures: IntegrityFailureCode[] = [];
  const detail: Record<string, unknown> = { sha256: asset.sha256, bytes: got.bytes.byteLength };
  try {
    const img = await decodeOriented(got.bytes);
    detail.decoded = { width: img.width, height: img.height };
    if (asset.width !== img.width || asset.height !== img.height) {
      failures.push('dimension_mismatch');
      detail.recorded = { width: asset.width, height: asset.height };
    }
  } catch (err) {
    failures.push('not_an_image');
    detail.message = String(err);
  }
  return record(deps, assetId, { kind: 'original_hash', failures, detail });
}

export async function verifyDerived(deps: AssetDeps, assetId: string): Promise<IntegrityReport> {
  const asset = await deps.db.media_assets.findUniqueOrThrow({ where: { id: assetId } });
  if (asset.kind !== 'derived')
    throw new Error(`asset ${assetId} is a ${asset.kind}, not a derived image`);
  const kind = 'derived_rebuild' as const;
  const detail: Record<string, unknown> = {};

  // 1. The recorded transform must be a permitted one.
  const problems = transformProblems(asset.transform);
  if (problems.length > 0) {
    return record(deps, assetId, {
      kind,
      failures: ['transform_not_permitted'],
      detail: { problems },
    });
  }
  const transform = PhotoTransform.parse(asset.transform);

  // 2. The parent must be intact (an original by hash, a derived image by its own full check).
  const parent = await deps.db.media_assets.findUnique({
    where: { id: asset.parent_asset_id ?? '' },
  });
  if (!parent) {
    return record(deps, assetId, {
      kind,
      failures: ['parent_changed'],
      detail: { message: 'no parent' },
    });
  }
  const parentReport =
    parent.kind === 'original'
      ? await verifyOriginal(deps, parent.id)
      : await verifyDerived(deps, parent.id);
  if (!parentReport.passed) {
    return record(deps, assetId, {
      kind,
      failures: ['parent_changed'],
      detail: { parentId: parent.id, parentFailures: parentReport.failures },
    });
  }
  const parentFile = await read(deps, parent);
  if ('failure' in parentFile) {
    return record(deps, assetId, {
      kind,
      failures: ['parent_changed'],
      detail: { message: parentFile.message },
    });
  }

  // 3. The derived file itself must be the file that was recorded.
  const stored = await read(deps, asset);
  if ('failure' in stored) {
    return record(deps, assetId, {
      kind,
      failures: [stored.failure],
      detail: { message: stored.message, expectedSha256: asset.sha256 },
    });
  }

  // 4. Rebuild it from the parent. Same pixels bit for bit is the strongest proof; otherwise (another CPU or
  //    library version encodes slightly differently) the pictures must match within the policy tolerance.
  let rebuilt;
  try {
    rebuilt = await applyTransform(parentFile.bytes, transform);
  } catch (err) {
    return record(deps, assetId, {
      kind,
      failures: ['transform_not_permitted'],
      detail: { message: err instanceof Error ? err.message : String(err) },
    });
  }
  const rebuiltSha = sha256Hex(rebuilt.bytes);
  const creation = await deps.db.asset_integrity_checks.findFirst({
    where: { asset_id: assetId, check_kind: 'derived_rebuild' },
    orderBy: { checked_at: 'asc' },
  });
  detail.rebuiltSha256 = rebuiltSha;
  detail.sameEngine = sameEngine(
    creation?.engine as Record<string, unknown> | undefined,
    engineInfo(),
  );
  if (rebuiltSha === asset.sha256) {
    return record(deps, assetId, { kind, failures: [], detail: { ...detail, exact: true } });
  }

  const failures: IntegrityFailureCode[] = [];
  if (asset.width !== rebuilt.width || asset.height !== rebuilt.height)
    failures.push('dimension_mismatch');
  let a: RawImage;
  let b: RawImage;
  try {
    [a, b] = await Promise.all([decodeRgb(stored.bytes), decodeRgb(rebuilt.bytes)]);
  } catch (err) {
    return record(deps, assetId, {
      kind,
      failures: ['not_an_image'],
      detail: { ...detail, message: String(err) },
    });
  }
  if (a.width !== b.width || a.height !== b.height) {
    failures.push('dimension_mismatch');
    detail.sizes = { stored: [a.width, a.height], rebuilt: [b.width, b.height] };
  } else {
    const cmp = comparePixels(a, b);
    failures.push(...judgeComparison(cmp));
    Object.assign(detail, { exact: false, comparison: cmp, thresholds: INTEGRITY_THRESHOLDS });
  }
  return record(deps, assetId, { kind, failures, detail });
}

export interface RegionCheck {
  /** The finished graphic. */
  renderId: string;
  /** The photograph the graphic was composed from: the render's parent. */
  sourceId: string;
  /** Where the photograph sits in the graphic, in pixels. */
  rect: { left: number; top: number; width: number; height: number };
  /** How the template scaled the photograph into that area. */
  fit: 'inside' | 'cover';
}

/**
 * Checks that the photograph area of a render is the source photograph, only scaled into place. The same
 * block-wise test as a derived image is used, so retouching a face in the finished graphic is caught.
 * Compose renders with Sharp (module 1.10) so the scaling matches; a browser's own scaling needs a looser policy.
 */
export async function verifyRegion(deps: AssetDeps, check: RegionCheck): Promise<IntegrityReport> {
  const kind = 'region_match' as const;
  const render = await deps.db.media_assets.findUniqueOrThrow({ where: { id: check.renderId } });
  if (render.kind !== 'render')
    throw new Error(`asset ${check.renderId} is a ${render.kind}, not a render`);
  const detail: Record<string, unknown> = {
    sourceId: check.sourceId,
    rect: check.rect,
    fit: check.fit,
  };
  if (render.parent_asset_id !== check.sourceId) {
    return record(deps, check.renderId, {
      kind,
      failures: ['parent_changed'],
      detail: { ...detail, message: 'the render does not name this photograph as its parent' },
    });
  }
  const source = await deps.db.media_assets.findUniqueOrThrow({ where: { id: check.sourceId } });
  const [r, s] = await Promise.all([read(deps, render), read(deps, source)]);
  for (const got of [r, s]) {
    if ('failure' in got) {
      return record(deps, check.renderId, {
        kind,
        failures: [got.failure],
        detail: { ...detail, message: got.message },
      });
    }
  }
  const { rect } = check;
  const renderImg = await decodeRgb((r as { bytes: Uint8Array }).bytes);
  if (
    rect.left < 0 ||
    rect.top < 0 ||
    rect.left + rect.width > renderImg.width ||
    rect.top + rect.height > renderImg.height
  ) {
    return record(deps, check.renderId, {
      kind,
      failures: ['dimension_mismatch'],
      detail: { ...detail, renderSize: [renderImg.width, renderImg.height] },
    });
  }
  const region = await sharp(renderImg.data, {
    raw: { width: renderImg.width, height: renderImg.height, channels: renderImg.channels },
  })
    .extract(rect)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const sourceImg = await decodeRgb((s as { bytes: Uint8Array }).bytes);
  const expected = await sharp(sourceImg.data, {
    raw: { width: sourceImg.width, height: sourceImg.height, channels: sourceImg.channels },
  })
    .resize(rect.width, rect.height, { fit: check.fit, kernel: 'lanczos3' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (expected.info.width !== rect.width || expected.info.height !== rect.height) {
    // `inside` keeps proportions, so the photo may be smaller than the area; compare the part it covers.
    return record(deps, check.renderId, {
      kind,
      failures: ['dimension_mismatch'],
      detail: { ...detail, expected: [expected.info.width, expected.info.height] },
    });
  }
  const cmp = comparePixels(
    {
      data: region.data,
      width: region.info.width,
      height: region.info.height,
      channels: region.info.channels as 3 | 4,
    },
    {
      data: expected.data,
      width: expected.info.width,
      height: expected.info.height,
      channels: expected.info.channels as 3 | 4,
    },
  );
  Object.assign(detail, { comparison: cmp, thresholds: INTEGRITY_THRESHOLDS });
  return record(deps, check.renderId, { kind, failures: judgeComparison(cmp), detail });
}

/** Runs the check that fits the asset's kind. Renders need `verifyRegion` with their photo area. */
export async function verifyAsset(deps: AssetDeps, assetId: string): Promise<IntegrityReport> {
  const asset = await deps.db.media_assets.findUniqueOrThrow({
    where: { id: assetId },
    select: { kind: true },
  });
  if (asset.kind === 'original') return verifyOriginal(deps, assetId);
  if (asset.kind === 'derived') return verifyDerived(deps, assetId);
  throw new Error(`a ${asset.kind} asset has no standalone integrity check`);
}
