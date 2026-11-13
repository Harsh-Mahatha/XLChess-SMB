import sharp from 'sharp';
import {
  INTEGRITY_THRESHOLDS,
  TRANSFORM_MIME,
  psnrFromMse,
  transformedSize,
  type PhotoTransform,
} from '@smb/shared';
import { MAX_INPUT_PIXELS } from '../images/inspect.js';

/**
 * The deterministic photo pipeline (module 1.9): orient -> crop -> rotate -> resize -> encode.
 * Each stage hands the next one raw 8-bit sRGB pixels, so the only lossy step is the final encode and the
 * result does not depend on the order Sharp happens to run its own operations in.
 */

export class TransformError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransformError';
  }
}

export interface RawImage {
  data: Buffer;
  width: number;
  height: number;
  channels: 3 | 4;
}

/** The software that produced a result; encoders can differ between versions and CPUs. */
export function engineInfo(): { sharp: string; vips: string } {
  return { sharp: sharp.versions.sharp ?? 'unknown', vips: sharp.versions.vips ?? 'unknown' };
}

export function sameEngine(
  a: Record<string, unknown> | undefined,
  b: Record<string, unknown> | undefined,
): boolean {
  return Boolean(a && b && a.sharp === b.sharp && a.vips === b.vips);
}

const asBuffer = (bytes: Uint8Array): Buffer =>
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

const rawOpts = (img: RawImage) => ({
  raw: { width: img.width, height: img.height, channels: img.channels },
  limitInputPixels: MAX_INPUT_PIXELS,
});

async function toRaw(pipeline: sharp.Sharp): Promise<RawImage> {
  const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels as 3 | 4 };
}

/** Decodes a file as a viewer sees it: camera rotation applied, sRGB, 8 bits per channel. */
export async function decodeOriented(bytes: Uint8Array): Promise<RawImage> {
  return toRaw(
    sharp(asBuffer(bytes), { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' })
      .rotate()
      .toColourspace('srgb'),
  );
}

/** Like `decodeOriented`, keeping just the three colour channels (for comparing pictures). */
export async function decodeRgb(bytes: Uint8Array): Promise<RawImage> {
  return toRaw(
    sharp(asBuffer(bytes), { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' })
      .rotate()
      .toColourspace('srgb')
      .removeAlpha(),
  );
}

export interface TransformOutput {
  bytes: Uint8Array;
  mime: (typeof TRANSFORM_MIME)[keyof typeof TRANSFORM_MIME];
  width: number;
  height: number;
}

/** Applies a permitted transform to the bytes of an image. Pure: the same input gives the same output. */
export async function applyTransform(
  source: Uint8Array,
  transform: PhotoTransform,
): Promise<TransformOutput> {
  let img = await decodeOriented(source);
  let expected: { width: number; height: number };
  try {
    expected = transformedSize(transform, img.width, img.height); // also checks the crop fits
  } catch (err) {
    throw new TransformError(err instanceof Error ? err.message : String(err));
  }

  if (transform.encode.format === 'jpeg' && img.channels === 4) {
    throw new TransformError(
      'the photo has transparency and cannot be saved as JPEG without flattening it',
    );
  }

  if (transform.crop) {
    const c = transform.crop;
    img = await toRaw(
      sharp(img.data, rawOpts(img)).extract({
        left: c.left,
        top: c.top,
        width: c.width,
        height: c.height,
      }),
    );
  }
  if (transform.rotate) {
    const bg = transform.rotate.background;
    img = await toRaw(
      sharp(img.data, rawOpts(img)).rotate(transform.rotate.degrees, {
        background: {
          r: parseInt(bg.slice(1, 3), 16),
          g: parseInt(bg.slice(3, 5), 16),
          b: parseInt(bg.slice(5, 7), 16),
          alpha: 1,
        },
      }),
    );
  }
  if (transform.resize) {
    const r = transform.resize;
    img = await toRaw(
      sharp(img.data, rawOpts(img)).resize(r.width, r.height, {
        fit: r.fit,
        kernel: 'lanczos3',
        withoutEnlargement: false,
      }),
    );
  }

  const enc = transform.encode;
  const out = sharp(img.data, rawOpts(img));
  let encoded: sharp.Sharp;
  if (enc.format === 'jpeg') {
    encoded = out.jpeg({ quality: enc.quality ?? 92, chromaSubsampling: '4:4:4', mozjpeg: false });
  } else if (enc.format === 'webp') {
    encoded = out.webp({ quality: enc.quality ?? 92 });
  } else {
    encoded = out.png({ compressionLevel: 9 });
  }
  // Metadata (including GPS and camera data) is never carried over: sharp drops it unless asked to keep it.
  const bytes = await encoded.toBuffer();
  // Right-angle turns and plain resizes must land exactly on the computed size; free angles can differ by a pixel.
  const exactSize = !transform.rotate || transform.rotate.degrees % 90 === 0;
  if (exactSize && (img.width !== expected.width || img.height !== expected.height)) {
    throw new TransformError(
      `expected ${expected.width}x${expected.height} but produced ${img.width}x${img.height}`,
    );
  }
  return {
    bytes: new Uint8Array(bytes),
    mime: TRANSFORM_MIME[enc.format],
    width: img.width,
    height: img.height,
  };
}

export interface PixelComparison {
  psnrDb: number;
  /** Mean absolute difference (0-255) of the block that differs most. */
  worstBlockMeanDiff: number;
  /** Largest share of strongly different pixels in any block. */
  worstBlockOutlierShare: number;
  /** Top-left corner of the worst block, to show a reviewer where to look. */
  worstBlockAt: { left: number; top: number };
  blocks: number;
}

/**
 * Compares two same-sized RGB(A) images over the colour channels. The whole-image PSNR catches global changes
 * (recolouring, softening); the per-block numbers catch local ones (a retouched face) that an average hides.
 */
export function comparePixels(a: RawImage, b: RawImage): PixelComparison {
  if (a.width !== b.width || a.height !== b.height) {
    throw new TransformError('images differ in size');
  }
  const { blockSize, maxBlockPixelDiff } = INTEGRITY_THRESHOLDS;
  const bx = Math.ceil(a.width / blockSize);
  const by = Math.ceil(a.height / blockSize);
  const sum = new Float64Array(bx * by);
  const count = new Uint32Array(bx * by);
  const outliers = new Uint32Array(bx * by);
  let sse = 0;
  for (let y = 0; y < a.height; y++) {
    const rowBlock = Math.floor(y / blockSize) * bx;
    for (let x = 0; x < a.width; x++) {
      const ia = (y * a.width + x) * a.channels;
      const ib = (y * b.width + x) * b.channels;
      const k = rowBlock + Math.floor(x / blockSize);
      let maxd = 0;
      for (let c = 0; c < 3; c++) {
        const d = Math.abs(a.data[ia + c]! - b.data[ib + c]!);
        sse += d * d;
        sum[k]! += d;
        if (d > maxd) maxd = d;
      }
      count[k]! += 1;
      if (maxd > maxBlockPixelDiff) outliers[k]! += 1;
    }
  }
  let worstMean = 0;
  let worstShare = 0;
  let worstIdx = 0;
  for (let k = 0; k < sum.length; k++) {
    const mean = sum[k]! / (count[k]! * 3);
    const share = outliers[k]! / count[k]!;
    if (mean > worstMean) {
      worstMean = mean;
      worstIdx = k;
    }
    if (share > worstShare) worstShare = share;
  }
  return {
    psnrDb: psnrFromMse(sse / (a.width * a.height * 3)),
    worstBlockMeanDiff: worstMean,
    worstBlockOutlierShare: worstShare,
    worstBlockAt: { left: (worstIdx % bx) * blockSize, top: Math.floor(worstIdx / bx) * blockSize },
    blocks: bx * by,
  };
}

/** Which failure codes a comparison earns under the integrity policy, if any. */
export function judgeComparison(c: PixelComparison): ('pixel_mismatch' | 'local_edit')[] {
  const t = INTEGRITY_THRESHOLDS;
  const codes: ('pixel_mismatch' | 'local_edit')[] = [];
  if (c.psnrDb < t.minPsnrDb) codes.push('pixel_mismatch');
  if (
    c.worstBlockMeanDiff > t.maxBlockMeanDiff ||
    c.worstBlockOutlierShare > t.maxBlockOutlierShare
  )
    codes.push('local_edit');
  return codes;
}
