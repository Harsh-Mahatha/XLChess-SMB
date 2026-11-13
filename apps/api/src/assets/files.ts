import type { ObjectStore } from '../storage/index.js';
import { sha256Hex } from '../storage/index.js';

/** The columns of a media_assets row that file handling needs. */
export interface StoredFile {
  id: string;
  bucket: string;
  path: string;
  sha256: string;
}

export class AssetFileError extends Error {
  constructor(
    readonly code: 'file_missing' | 'hash_mismatch' | 'path_mismatch',
    message: string,
  ) {
    super(message);
    this.name = 'AssetFileError';
  }
}

/**
 * Reads an asset's file and proves it is the file the database row describes: the bytes hash to the recorded
 * sha-256, and (because paths are content-addressed) the file name is that same hash. Throws otherwise.
 */
export async function readVerified(store: ObjectStore, asset: StoredFile): Promise<Uint8Array> {
  const bytes = await store.get(asset.bucket, asset.path);
  if (!bytes) {
    throw new AssetFileError('file_missing', `${asset.bucket}/${asset.path} is not in storage`);
  }
  const actual = sha256Hex(bytes);
  if (actual !== asset.sha256) {
    throw new AssetFileError(
      'hash_mismatch',
      `${asset.bucket}/${asset.path} hashes to ${actual}, the record says ${asset.sha256}`,
    );
  }
  if (asset.bucket !== 'evidence' && !asset.path.startsWith(`${asset.sha256}.`)) {
    throw new AssetFileError(
      'path_mismatch',
      `${asset.bucket}/${asset.path} is not named after its content hash`,
    );
  }
  return bytes;
}
