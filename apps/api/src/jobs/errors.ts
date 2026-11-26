import { AiError } from '@smb/shared';

/**
 * A step failed. `retryable` says whether running the same step again can help (the network, a source that was
 * down, a model that was still loading). A permanent failure is a gate that will keep saying no or a defect:
 * it stops the job at once and a person decides what to do.
 */
export class JobError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'JobError';
  }
}

export interface Classified {
  code: string;
  message: string;
  retryable: boolean;
}

/** Error classes that mean "the inputs are not ready or are wrong": waiting does not change them. */
const PERMANENT_NAMES = new Set([
  'StoryNotReadyError',
  'GenerationNotReadyError',
  'RevisionNotPossibleError',
  'ImageNotReadyError',
  'ZodError',
]);
/** Research that is not ready yet can become ready: the source may publish the missing fact. */
const RETRYABLE_NAMES = new Set(['ResearchNotReadyError', 'ImageDiscoveryError']);

/** Turns whatever a step threw into one of two outcomes. Unknown errors are retried: bounded attempts cap the cost. */
export function classifyError(err: unknown): Classified {
  if (err instanceof JobError) {
    return { code: err.code, message: err.message, retryable: err.retryable };
  }
  if (err instanceof AiError) {
    return { code: `ai_${err.code}`, message: err.message, retryable: err.retryable };
  }
  const name = err instanceof Error ? err.name : '';
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: unknown } | null)?.code;
  if (name === 'GraphicError' && typeof code === 'string') {
    // `verification_failed` is a defect. The rest mean the inputs need a person or a fallback (handled by the step).
    return { code: `graphic_${code}`, message, retryable: false };
  }
  if (PERMANENT_NAMES.has(name)) return { code: name, message, retryable: false };
  if (RETRYABLE_NAMES.has(name)) return { code: name, message, retryable: true };
  return { code: 'unexpected', message, retryable: true };
}
