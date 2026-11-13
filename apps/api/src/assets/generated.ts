import type { Prisma } from '@prisma/client';
import { SharpPhotoInspector, type PhotoInspector } from '../images/inspect.js';
import {
  BUCKETS,
  IMAGE_EXTENSIONS,
  contentPath,
  sha256Hex,
  type ObjectStore,
} from '../storage/index.js';
import type { AssetDeps } from './derive.js';

/** What the worker's image stage reports about a decorative image it generated from text. */
export interface GeneratedImage {
  bytes: Uint8Array;
  model: string;
  prompt: string;
  seed: number;
  /** `workflowFingerprint` of the ComfyUI workflow that ran. */
  workflowSha256: string;
  opportunityId?: string;
  jobId?: string;
}

export class GeneratedAssetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeneratedAssetError';
  }
}

export interface RegisteredGenerated {
  assetId: string;
  sha256: string;
  path: string;
  width: number;
  height: number;
  created: boolean;
}

/**
 * Stores an AI-made decorative image (a background or texture) as a `generated` asset (module 1.9).
 *
 * A generated asset records `input: 'text_only'`: the model received a prompt and noise, never a photograph.
 * The database refuses a generated asset with a parent, a source URL or any other input, and refuses to cut a
 * derived image from one, so AI output can sit beside a real photograph in a graphic but never replace it or be
 * passed off as it.
 */
export async function registerGeneratedAsset(
  deps: AssetDeps & { inspector?: PhotoInspector },
  img: GeneratedImage,
): Promise<RegisteredGenerated> {
  if (!img.prompt.trim())
    throw new GeneratedAssetError('a generated image needs its prompt on record');
  const facts = await (deps.inspector ?? new SharpPhotoInspector())
    .inspect(img.bytes)
    .catch((err: unknown) => {
      throw new GeneratedAssetError(
        `the generated file is not a usable image: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  const sha256 = sha256Hex(img.bytes);
  const path = contentPath(sha256, IMAGE_EXTENSIONS[facts.mime]);
  const store: ObjectStore = deps.store;
  await store.put(BUCKETS.generated, path, img.bytes, facts.mime);

  const existing = await deps.db.media_assets.findUnique({
    where: { bucket_path: { bucket: BUCKETS.generated, path } },
  });
  if (existing) {
    return {
      assetId: existing.id,
      sha256,
      path,
      width: existing.width!,
      height: existing.height!,
      created: false,
    };
  }
  const row = await deps.db.media_assets.create({
    data: {
      kind: 'generated',
      bucket: BUCKETS.generated,
      path,
      sha256,
      mime: facts.mime,
      size_bytes: img.bytes.byteLength,
      width: facts.width,
      height: facts.height,
      generation: {
        input: 'text_only',
        model: img.model,
        prompt: img.prompt,
        seed: img.seed,
        workflow: img.workflowSha256,
      } satisfies Prisma.InputJsonObject,
      opportunity_id: img.opportunityId,
      job_id: img.jobId,
    },
  });
  return {
    assetId: row.id,
    sha256,
    path,
    width: facts.width,
    height: facts.height,
    created: true,
  };
}
