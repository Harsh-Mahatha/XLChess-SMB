import sharp from 'sharp';
import { sniffImageMime, type ImageMime } from '../storage/content.js';

/** Largest picture Sharp will decode, so a small file cannot expand into gigabytes (decompression bomb). */
export const MAX_INPUT_PIXELS = 100_000_000;

export type InspectionErrorCode =
  'not_an_image' | 'type_mismatch' | 'animated' | 'too_many_pixels' | 'undecodable';

export class PhotoInspectionError extends Error {
  constructor(
    readonly code: InspectionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PhotoInspectionError';
  }
}

/** What the file really is, read from its pixels and headers rather than taken from the provider. */
export interface PhotoFacts {
  mime: ImageMime;
  /** As a viewer shows it: the camera's rotation (EXIF orientation 1-8) is already applied. */
  width: number;
  height: number;
  /** EXIF orientation as stored, 1 when absent. */
  orientation: number;
}

export interface PhotoInspector {
  inspect(bytes: Uint8Array): Promise<PhotoFacts>;
}

const FORMAT_MIME: Record<string, ImageMime> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

/** Reads size and type with Sharp, and decodes the whole picture so a damaged file is refused now. */
export class SharpPhotoInspector implements PhotoInspector {
  async inspect(bytes: Uint8Array): Promise<PhotoFacts> {
    const sniffed = sniffImageMime(bytes);
    if (!sniffed) throw new PhotoInspectionError('not_an_image', 'not a JPEG, PNG or WebP image');
    const input = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const opts = { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' as const, animated: true };
    let meta: sharp.Metadata;
    try {
      meta = await sharp(input, opts).metadata();
      if (!meta.width || !meta.height) throw new Error('no dimensions');
      // Decode everything once: truncated or corrupt files fail here instead of later in a render.
      await sharp(input, { ...opts, animated: false })
        .raw()
        .toBuffer();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/pixel limit|exceeds/i.test(msg)) throw new PhotoInspectionError('too_many_pixels', msg);
      throw new PhotoInspectionError('undecodable', `the image could not be decoded: ${msg}`);
    }
    const mime = meta.format ? FORMAT_MIME[meta.format] : undefined;
    if (mime !== sniffed) {
      throw new PhotoInspectionError(
        'type_mismatch',
        `the header says ${sniffed} but the decoder found ${meta.format ?? 'unknown'}`,
      );
    }
    if ((meta.pages ?? 1) > 1) {
      throw new PhotoInspectionError('animated', 'animated or multi-frame images are not photos');
    }
    const orientation = meta.orientation ?? 1;
    const swap = orientation >= 5 && orientation <= 8;
    return {
      mime,
      width: swap ? meta.height! : meta.width,
      height: swap ? meta.width : meta.height!,
      orientation,
    };
  }
}
