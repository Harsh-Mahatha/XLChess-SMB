export type SourceErrorCode =
  | 'source_not_registered'
  | 'source_disabled'
  | 'source_not_approved'
  | 'unsupported_capability'
  | 'invalid_query'
  | 'rate_limited'
  | 'upstream_unavailable'
  | 'invalid_response'
  | 'not_found';

/**
 * Every source failure is thrown as one of these. A failed fetch is never turned into an empty
 * result, so a provider outage cannot be mistaken for "nothing happened" (and never becomes invented content).
 */
export class SourceError extends Error {
  constructor(
    readonly code: SourceErrorCode,
    readonly sourceId: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(`[${sourceId}] ${message}`);
    this.name = 'SourceError';
  }

  /** Worth retrying later (as opposed to a permanent refusal). */
  get transient(): boolean {
    return this.code === 'rate_limited' || this.code === 'upstream_unavailable';
  }
}
