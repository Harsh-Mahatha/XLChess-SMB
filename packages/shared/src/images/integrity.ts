import { z } from 'zod';

/**
 * How closely a derived image must match what its recorded transform produces from the original (module 1.9).
 * The thresholds are versioned and stored with every check.
 */
export const INTEGRITY_POLICY_VERSION = 'integrity@1.0.0';

export const INTEGRITY_THRESHOLDS = {
  /** Whole-image PSNR in dB at or above which pixels count as the same picture (codec differences only). */
  minPsnrDb: 35,
  /** Side of the squares compared separately, so a local edit cannot hide in an average. */
  blockSize: 16,
  /** Largest mean absolute difference (0..255) any single block may have. */
  maxBlockMeanDiff: 6,
  /** Largest single-pixel difference (0..255) allowed in more than a few pixels of a block. */
  maxBlockPixelDiff: 40,
  /** A block may contain at most this share of pixels above `maxBlockPixelDiff` (edges of encoded images). */
  maxBlockOutlierShare: 0.1,
} as const;

export const INTEGRITY_CHECK_KINDS = ['original_hash', 'derived_rebuild', 'region_match'] as const;
export const IntegrityCheckKind = z.enum(INTEGRITY_CHECK_KINDS);
export type IntegrityCheckKind = z.infer<typeof IntegrityCheckKind>;

export const IntegrityFailureCode = z.enum([
  'file_missing',
  'hash_mismatch',
  'path_mismatch',
  'not_an_image',
  'dimension_mismatch',
  'transform_not_permitted',
  'parent_changed',
  'pixel_mismatch',
  'local_edit',
]);
export type IntegrityFailureCode = z.infer<typeof IntegrityFailureCode>;

export const IntegrityReport = z
  .object({
    assetId: z.string().uuid(),
    kind: IntegrityCheckKind,
    passed: z.boolean(),
    failures: z.array(IntegrityFailureCode),
    detail: z.record(z.unknown()),
  })
  .strict();
export type IntegrityReport = z.infer<typeof IntegrityReport>;

/** Peak signal-to-noise ratio in dB from the mean squared error of 8-bit samples. */
export function psnrFromMse(mse: number): number {
  if (mse <= 0) return Infinity;
  return 10 * Math.log10((255 * 255) / mse);
}
