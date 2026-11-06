import type { z } from 'zod';

/**
 * Provider-independent AI contract (module 1.7). The SMB pipeline only ever sees `AiProvider`;
 * a local Ollama model, a compatible API or the deterministic stub can be swapped without changing it.
 */

export interface AiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AiSettings {
  temperature?: number;
  seed?: number;
  /** Maximum tokens to generate. */
  maxTokens?: number;
  /** Context window requested from the runner. */
  numCtx?: number;
}

export interface AiTask<T> {
  /** Stage name: interpret, candidate, editorial, visual. */
  name: string;
  /** `id@semver#hash`, recorded on every generated candidate. */
  promptVersion: string;
  messages: AiMessage[];
  /** The output must parse against this. Providers return only validated output. */
  schema: z.ZodType<T, z.ZodTypeDef, unknown>;
  settings?: AiSettings;
  /**
   * The structured input the messages were rendered from. Real providers ignore it;
   * the stub reads it so tests do not have to parse prompt text.
   */
  input?: unknown;
}

export interface AiResult<T> {
  output: T;
  provider: string;
  model: string;
  settings: AiSettings;
  durationMs: number;
  promptTokens?: number;
  completionTokens?: number;
  /** True when the first answer was invalid and a repair attempt produced this one. */
  repaired: boolean;
}

export type AiErrorCode =
  'invalid_output' | 'timeout' | 'unavailable' | 'model_missing' | 'bad_response';

export class AiError extends Error {
  constructor(
    public readonly code: AiErrorCode,
    message: string,
    /** True when running the same task again may succeed (timeouts, a runner that is still loading). */
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'AiError';
  }
}

export interface AiProvider {
  readonly name: string;
  readonly model: string;
  generate<T>(task: AiTask<T>): Promise<AiResult<T>>;
}
