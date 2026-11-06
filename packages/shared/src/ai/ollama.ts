import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  AiError,
  type AiMessage,
  type AiProvider,
  type AiResult,
  type AiSettings,
  type AiTask,
} from './provider.js';

export interface OllamaOptions {
  /** Ollama listens on localhost only; the worker never exposes it. */
  baseUrl?: string;
  model: string;
  /** Per request, milliseconds. A cold 8B model can take a while to load. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  defaults?: AiSettings;
}

interface ChatResponse {
  message?: { content?: string };
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

const DEFAULT_URL = 'http://127.0.0.1:11434';

/**
 * Talks to a local Ollama server through `/api/chat` with structured output (`format` = JSON schema).
 * If the answer is not valid JSON or does not match the task's schema, it asks once more with the
 * validation error; a second failure is an `invalid_output` error, never a guessed result.
 */
export class OllamaProvider implements AiProvider {
  readonly name = 'ollama';
  readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly defaults: AiSettings;

  constructor(options: OllamaOptions) {
    this.model = options.model;
    this.baseUrl = (options.baseUrl ?? DEFAULT_URL).replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 300_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.defaults = options.defaults ?? {};
  }

  async generate<T>(task: AiTask<T>): Promise<AiResult<T>> {
    const started = this.now();
    const settings: AiSettings = { ...this.defaults, ...task.settings };
    const format = zodToJsonSchema(task.schema, { target: 'jsonSchema7', $refStrategy: 'none' });
    const messages: AiMessage[] = [...task.messages];
    let promptTokens = 0;
    let completionTokens = 0;
    let lastProblem = '';

    for (let attempt = 0; attempt < 2; attempt++) {
      const body = await this.chat(messages, format, settings);
      promptTokens += body.prompt_eval_count ?? 0;
      completionTokens += body.eval_count ?? 0;
      const content = body.message?.content ?? '';

      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch {
        lastProblem = 'the reply was not valid JSON';
        messages.push(
          { role: 'assistant', content },
          {
            role: 'user',
            content: `Your reply was not valid JSON. Reply with only the JSON object.`,
          },
        );
        continue;
      }
      const checked = task.schema.safeParse(parsed);
      if (checked.success) {
        return {
          output: checked.data,
          provider: this.name,
          model: this.model,
          settings,
          durationMs: this.now() - started,
          promptTokens,
          completionTokens,
          repaired: attempt > 0,
        };
      }
      lastProblem = checked.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      messages.push(
        { role: 'assistant', content },
        {
          role: 'user',
          content: `Your reply did not match the required schema: ${lastProblem}. Reply with only the corrected JSON object.`,
        },
      );
    }
    throw new AiError('invalid_output', `${task.name}: ${lastProblem}`, false);
  }

  private async chat(
    messages: AiMessage[],
    format: unknown,
    settings: AiSettings,
  ): Promise<ChatResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.model,
          messages,
          stream: false,
          format,
          options: {
            ...(settings.temperature !== undefined && { temperature: settings.temperature }),
            ...(settings.seed !== undefined && { seed: settings.seed }),
            ...(settings.maxTokens !== undefined && { num_predict: settings.maxTokens }),
            ...(settings.numCtx !== undefined && { num_ctx: settings.numCtx }),
          },
        }),
      });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new AiError('timeout', `Ollama did not answer within ${this.timeoutMs} ms`, true);
      }
      throw new AiError(
        'unavailable',
        `cannot reach Ollama at ${this.baseUrl}: ${String(err)}`,
        true,
      );
    } finally {
      clearTimeout(timer);
    }

    let body: ChatResponse;
    try {
      body = (await res.json()) as ChatResponse;
    } catch {
      throw new AiError(
        'bad_response',
        `Ollama returned HTTP ${res.status} with no JSON`,
        res.status >= 500,
      );
    }
    if (!res.ok) {
      const text = body.error ?? `HTTP ${res.status}`;
      if (res.status === 404)
        throw new AiError('model_missing', `model ${this.model}: ${text}`, false);
      throw new AiError('bad_response', text, res.status >= 500);
    }
    return body;
  }
}
