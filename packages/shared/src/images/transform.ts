import { z } from 'zod';

/**
 * The only operations SMB may apply to a real photograph (module 1.9).
 *
 * Permitted: apply the camera's rotation, crop, rotate, resize and encode. Everything else (recolouring,
 * retouching, blur or sharpen, flips, compositing, any generative step) has no field here, and the schema is
 * strict, so it cannot be recorded or requested. The pipeline always runs in this fixed order:
 *
 *   orient (always) -> crop -> rotate -> resize -> encode
 *
 * Placing the result in a frame and arranging it with other design elements is graphic composition (1.10); the
 * composed render names the photograph as its parent and is checked region by region.
 */
export const TRANSFORM_SPEC_VERSION = 1;

const int = z.number().int();

export const CropStep = z
  .object({
    left: int.min(0),
    top: int.min(0),
    width: int.min(1),
    height: int.min(1),
  })
  .strict();
export type CropStep = z.infer<typeof CropStep>;

export const RotateStep = z
  .object({
    /** Clockwise. Any angle other than a multiple of 90 leaves corners that are filled with `background`. */
    degrees: z.number().min(-360).max(360),
    background: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .default('#000000'),
  })
  .strict();
export type RotateStep = z.infer<typeof RotateStep>;

export const RESIZE_FITS = ['inside', 'cover'] as const;
export const ResizeStep = z
  .object({
    width: int.min(1).max(8192),
    height: int.min(1).max(8192),
    /**
     * `inside` keeps the whole picture and its proportions. `cover` fills the box and trims the overflow
     * evenly (a centred crop). Stretching to a different shape is not offered.
     */
    fit: z.enum(RESIZE_FITS),
  })
  .strict();
export type ResizeStep = z.infer<typeof ResizeStep>;

export const ENCODE_FORMATS = ['jpeg', 'png', 'webp'] as const;
export const EncodeStep = z
  .object({
    format: z.enum(ENCODE_FORMATS),
    /** JPEG and WebP only. */
    quality: int.min(60).max(100).optional(),
  })
  .strict();
export type EncodeStep = z.infer<typeof EncodeStep>;

export const PhotoTransform = z
  .object({
    spec: z.literal(TRANSFORM_SPEC_VERSION),
    crop: CropStep.optional(),
    rotate: RotateStep.optional(),
    resize: ResizeStep.optional(),
    encode: EncodeStep,
  })
  .strict();
export type PhotoTransform = z.infer<typeof PhotoTransform>;
/** What a caller supplies; defaults (such as the rotation background) are filled in by `PhotoTransform.parse`. */
export type PhotoTransformInput = z.input<typeof PhotoTransform>;

/** The keys the database check `smb.transform_is_permitted` accepts. Keep in sync with the migration. */
export const TRANSFORM_KEYS = ['spec', 'crop', 'rotate', 'resize', 'encode'] as const;

export const TRANSFORM_MIME = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
} as const;

/**
 * Why a transform is not allowed, or an empty list when it is. Unknown steps, unknown fields and values out of
 * range are all reported. Use `PhotoTransform.parse` to get the normalised value.
 */
export function transformProblems(value: unknown): string[] {
  const r = PhotoTransform.safeParse(value);
  if (r.success) return [];
  return r.error.issues.map((i) => {
    const path = i.path.join('.') || 'transform';
    return i.code === 'unrecognized_keys'
      ? `${path}: step not permitted (${i.keys.join(', ')})`
      : `${path}: ${i.message}`;
  });
}

/**
 * The size of the result for a source of the given (already oriented) size, without touching any pixels.
 * Throws when the crop does not fit inside the source.
 */
export function transformedSize(
  t: PhotoTransform,
  orientedWidth: number,
  orientedHeight: number,
): { width: number; height: number } {
  let w = orientedWidth;
  let h = orientedHeight;
  if (t.crop) {
    if (t.crop.left + t.crop.width > w || t.crop.top + t.crop.height > h) {
      throw new Error(
        `crop ${t.crop.width}x${t.crop.height} at ${t.crop.left},${t.crop.top} is outside the ${w}x${h} photo`,
      );
    }
    w = t.crop.width;
    h = t.crop.height;
  }
  if (t.rotate) {
    const quarter = ((t.rotate.degrees % 180) + 180) % 180;
    if (quarter === 90) [w, h] = [h, w];
    else if (quarter !== 0) {
      const rad = (t.rotate.degrees * Math.PI) / 180;
      const c = Math.abs(Math.cos(rad));
      const s = Math.abs(Math.sin(rad));
      [w, h] = [Math.round(w * c + h * s), Math.round(w * s + h * c)];
    }
  }
  if (t.resize) {
    if (t.resize.fit === 'cover') return { width: t.resize.width, height: t.resize.height };
    const scale = Math.min(t.resize.width / w, t.resize.height / h);
    return {
      width: Math.max(1, Math.round(w * scale)),
      height: Math.max(1, Math.round(h * scale)),
    };
  }
  return { width: w, height: h };
}
