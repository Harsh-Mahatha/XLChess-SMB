import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AiError,
  OllamaProvider,
  StubProvider,
  type AiTask,
} from '../../../packages/shared/src/index.js';

const Out = z.object({ answer: z.string(), n: z.number() }).strict();
const task: AiTask<z.infer<typeof Out>> = {
  name: 'demo',
  promptVersion: 'demo@1.0.0#abcd1234',
  messages: [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
  ],
  schema: Out,
  settings: { temperature: 0.2, seed: 5, numCtx: 4096, maxTokens: 200 },
};

interface Sent {
  url: string;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** A fake Ollama: each call answers with the next reply. */
function fakeOllama(replies: { status?: number; json: unknown }[]) {
  const sent: Sent[] = [];
  let i = 0;
  const impl = (async (url: string, init: RequestInit) => {
    sent.push({ url, body: JSON.parse(String(init.body)) });
    const r = replies[Math.min(i++, replies.length - 1)]!;
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { impl, sent };
}

const chat = (content: string) => ({
  json: { message: { content }, prompt_eval_count: 10, eval_count: 5 },
});

describe('OllamaProvider', () => {
  it('sends the schema as the output format and the recorded settings, and returns validated output', async () => {
    const net = fakeOllama([chat('{"answer":"yes","n":2}')]);
    const p = new OllamaProvider({ model: 'qwen3:8b', fetchImpl: net.impl });
    const res = await p.generate(task);

    expect(res.output).toEqual({ answer: 'yes', n: 2 });
    expect(res).toMatchObject({
      provider: 'ollama',
      model: 'qwen3:8b',
      repaired: false,
      promptTokens: 10,
    });
    expect(net.sent[0]!.url).toBe('http://127.0.0.1:11434/api/chat');
    expect(net.sent[0]!.body).toMatchObject({
      model: 'qwen3:8b',
      stream: false,
      options: { temperature: 0.2, seed: 5, num_ctx: 4096, num_predict: 200 },
    });
    expect(net.sent[0]!.body.format.properties.answer.type).toBe('string');
    expect(res.settings).toMatchObject({ temperature: 0.2, seed: 5 });
  });

  it('asks once more when the reply is not valid JSON, and says so', async () => {
    const net = fakeOllama([chat('sure! here you go'), chat('{"answer":"ok","n":1}')]);
    const res = await new OllamaProvider({ model: 'm', fetchImpl: net.impl }).generate(task);
    expect(res.repaired).toBe(true);
    expect(net.sent).toHaveLength(2);
    expect(net.sent[1]!.body.messages.at(-1).content).toContain('not valid JSON');
    expect(res.promptTokens).toBe(20);
  });

  it('asks once more when the reply does not match the schema, quoting the problem', async () => {
    const net = fakeOllama([chat('{"answer":"ok","n":"two"}'), chat('{"answer":"ok","n":2}')]);
    const res = await new OllamaProvider({ model: 'm', fetchImpl: net.impl }).generate(task);
    expect(res.output.n).toBe(2);
    expect(net.sent[1]!.body.messages.at(-1).content).toContain('n:');
  });

  it('fails with invalid_output, not a guess, when the second reply is also wrong', async () => {
    const net = fakeOllama([chat('{"answer":1}'), chat('{"answer":1}')]);
    const err = await new OllamaProvider({ model: 'm', fetchImpl: net.impl })
      .generate(task)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiError);
    expect(err).toMatchObject({ code: 'invalid_output', retryable: false });
  });

  it('reports an unreachable server as retryable', async () => {
    const impl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const err = await new OllamaProvider({ model: 'm', fetchImpl: impl })
      .generate(task)
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'unavailable', retryable: true });
  });

  it('reports a missing model as not retryable', async () => {
    const net = fakeOllama([{ status: 404, json: { error: 'model not found' } }]);
    const err = await new OllamaProvider({ model: 'nope', fetchImpl: net.impl })
      .generate(task)
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'model_missing', retryable: false });
  });

  it('treats a server error as retryable', async () => {
    const net = fakeOllama([{ status: 503, json: { error: 'loading' } }]);
    const err = await new OllamaProvider({ model: 'm', fetchImpl: net.impl })
      .generate(task)
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'bad_response', retryable: true });
  });

  it('gives up on a request that takes too long', async () => {
    const impl = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(new Error('aborted')));
      })) as unknown as typeof fetch;
    const err = await new OllamaProvider({ model: 'm', fetchImpl: impl, timeoutMs: 20 })
      .generate(task)
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'timeout', retryable: true });
  });
});

describe('StubProvider', () => {
  it('returns schema-checked output from a handler and counts calls per stage', async () => {
    const stub = new StubProvider({
      handlers: { demo: (_t, call) => ({ answer: 'x', n: call }) },
    });
    expect((await stub.generate(task)).output.n).toBe(1);
    expect((await stub.generate(task)).output.n).toBe(2);
    expect(stub.calls.map((c) => c.task)).toEqual(['demo', 'demo']);
    expect(stub.calls[0]!.promptVersion).toBe('demo@1.0.0#abcd1234');
  });

  it('rejects a handler answer that does not match the schema, like a real provider', async () => {
    const stub = new StubProvider({ handlers: { demo: () => ({ answer: 1 }) } });
    await expect(stub.generate(task)).rejects.toMatchObject({ code: 'invalid_output' });
  });

  it('refuses a stage it has no handler for', async () => {
    await expect(new StubProvider().generate({ ...task, name: 'unknown' })).rejects.toBeInstanceOf(
      AiError,
    );
  });
});
