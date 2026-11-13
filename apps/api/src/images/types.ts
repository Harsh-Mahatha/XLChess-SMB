import type { ImageCandidate, ImageSubject, SourceLimits } from '@smb/shared';
import type { HttpFetcher } from '../sources/types.js';

/**
 * An approved photo source (module 1.8). It finds photographs and reports, for each one, the licence facts
 * the provider publishes. Deciding whether a licence is acceptable is not its job: the shared licence rules do
 * that for every source the same way.
 */
export interface ImageSourceAdapter {
  readonly id: string;
  readonly adapterVersion: string;
  /** Hosts the original files may be downloaded from. Anything else is refused. */
  readonly downloadHosts: readonly string[];
  search(
    query: { subject: ImageSubject; limit: number },
    ctx: ImageAdapterContext,
  ): Promise<ImageCandidate[]>;
}

export interface ImageAdapterContext {
  http: HttpFetcher;
  limits: SourceLimits;
  baseUrl: string;
}
