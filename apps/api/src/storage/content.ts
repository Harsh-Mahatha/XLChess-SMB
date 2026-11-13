import { createHash } from 'node:crypto';

/** Content hashing and file-type checks for stored media (modules 1.8 and 1.9). */

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function sha1Hex(bytes: Uint8Array): string {
  return createHash('sha1').update(bytes).digest('hex');
}

export const IMAGE_EXTENSIONS = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
} as const;
export type ImageMime = keyof typeof IMAGE_EXTENSIONS;

/** The real type of an image from its first bytes, ignoring whatever the server or the file name claims. */
export function sniffImageMime(bytes: Uint8Array): ImageMime | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 8 &&
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => bytes[i] === b)
  ) {
    return 'image/png';
  }
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return undefined;
}

/** Content-addressed object path: the name is the hash of the bytes, so it proves which file it holds. */
export function contentPath(sha256: string, extension: string): string {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('contentPath needs a lowercase sha-256 hex');
  if (!/^[a-z0-9]{1,8}$/.test(extension)) throw new Error('invalid file extension');
  return `${sha256}.${extension}`;
}
