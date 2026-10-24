import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { DataScoutError } from '@datascout/contracts';
import type { CallContext, LlmJsonRequest } from '@datascout/contracts';
import { createLlmClient, getCassetteKey } from '../src/client.js';
import { loadLlmConfig } from '../src/config.js';

const request: LlmJsonRequest = {
  task: 'extract', promptVersion: 'test-v1', system: 'Return JSON.', user: 'fixture request',
  jsonSchema: { type: 'object', properties: { value: { type: 'string' } } },
  maxOutputTokens: 100, timeoutMs: 1_000,
};

function context(signal: AbortSignal = new AbortController().signal, deadlineMs = Date.now() + 5_000): CallContext {
  return {
    requestId: 'test-request', signal, deadlineMs,
    tracer: { withSpan: async (_name, _opts, fn) => fn({ setAttributes: () => undefined, score: () => undefined }), flush: async () => undefined },
  };
}

const cassetteDirectory = fileURLToPath(new URL('./fixtures/cassettes/', import.meta.url));
const geminiEnv = { LLM_PROVIDER: 'gemini', GEMINI_MODEL_ID: 'gemini-test', GEMINI_API_KEY: 'test-key' };
const ollamaEnv = { LLM_PROVIDER: 'ollama', OLLAMA_MODEL_ID: 'qwen-test' };

describe('LLM client providers', () => {
  it('calls the shared contract using the fake provider', async () => {
    const client = createLlmClient(loadLlmConfig({ LLM_PROVIDER: 'fake' }));
    const response = await client.generateJson({ ...request, user: 'Find crop yield data for Maharashtra with rainfall and temperature fields.' }, context());
    expect(client.provider).toBe('fake');
    expect(response.output).toMatchObject({ topic: 'crop yield' });
    expect(response.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it('replays cassettes deterministically without exposing their key', async () => {
    const client = createLlmClient(loadLlmConfig({ LLM_PROVIDER: 'cassette', LLM_CASSETTE_DIR: cassetteDirectory }));
    const first = await client.generateJson(request, context());
    const second = await client.generateJson(request, context());
    expect(getCassetteKey(request)).toBe('e2ab8a9c45ba870ca805f06acdfc759c98e5f164e37de278301982ab878e1b6d');
    expect(client.provider).toBe('cassette');
    expect(first).toEqual({ ...second, latencyMs: first.latencyMs });
    expect(first.output).toEqual({ value: 'replayed' });
    expect(first.modelId).toBe('recorded-test-model');
    expect(JSON.stringify(first)).not.toContain(request.user);
  });

  it('calls Gemini with its native JSON-schema API and redacted query', async () => {
    const send = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => {
      void _url; void _init;
      return Response.json({
        candidates: [{ content: { parts: [{ text: '{"value":"from-gemini"}' }] } }],
        usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 2 },
      });
    });
    const client = createLlmClient(loadLlmConfig(geminiEnv), { fetch: send as typeof fetch });
    const response = await client.generateJson({ ...request, user: 'Contact user@example.com or +91 9876543210' }, context());
    const [url, init] = send.mock.calls[0]!;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const contents = body['contents'] as { parts: { text: string }[] }[];
    expect(client.provider).toBe('gemini');
    expect(String(url)).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent');
    expect((init?.headers as Record<string, string>)['x-goog-api-key']).toBe('test-key');
    expect(body['generationConfig']).toMatchObject({ responseMimeType: 'application/json', responseJsonSchema: request.jsonSchema });
    expect(contents[0]?.parts[0]?.text).toContain('[REDACTED]');
    expect(contents[0]?.parts[0]?.text).not.toContain('user@example.com');
    expect(response.output).toEqual({ value: 'from-gemini' });
    expect(response.usage).toEqual({ inputTokens: 9, outputTokens: 2 });
  });

  it('allows safety triage to pin a separate configured model', async () => {
    const send = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => {
      void _url; void _init;
      return Response.json({ candidates: [{ content: { parts: [{ text: '{"verdict":"allow","category":"none"}' }] } }] });
    });
    const client = createLlmClient(loadLlmConfig({ ...geminiEnv, LLM_SAFETY_MODEL_ID: 'gemini-cheap-test' }), { fetch: send as typeof fetch });
    await client.generateJson({ ...request, task: 'safety_triage', modelId: 'gemini-cheap-test', jsonSchema: { type: 'object' } }, context());
    expect(String(send.mock.calls[0]?.[0])).toContain('/models/gemini-cheap-test:generateContent');
  });

  it('calls Ollama locally using its JSON format and no API credential', async () => {
    const send = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => {
      void _url; void _init;
      return Response.json({
        message: { content: '{"value":"from-ollama"}' }, prompt_eval_count: 7, eval_count: 3,
      });
    });
    const client = createLlmClient(loadLlmConfig(ollamaEnv), { fetch: send as typeof fetch });
    const response = await client.generateJson(request, context());
    const [url, init] = send.mock.calls[0]!;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(client.provider).toBe('ollama');
    expect(String(url)).toBe('http://127.0.0.1:11434/api/chat');
    expect(body['stream']).toBe(false);
    expect(body['format']).toEqual(request.jsonSchema);
    expect(init?.headers).not.toHaveProperty('authorization');
    expect(response.output).toEqual({ value: 'from-ollama' });
    expect(response.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
  });

  it('maps Gemini throttling to a safe retryable error', async () => {
    const send = vi.fn(async () => new Response(null, { status: 429 }));
    const client = createLlmClient(loadLlmConfig(geminiEnv), { fetch: send as typeof fetch });
    await expect(client.generateJson(request, context())).rejects.toMatchObject({
      code: 'rate_limited', retryable: true, safeMessage: 'The LLM provider is rate limiting requests.',
    });
  });

  it('applies the earlier of request timeout and context deadline', async () => {
    const send = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    const client = createLlmClient(loadLlmConfig({ ...geminiEnv, LLM_TIMEOUT_MS: '10' }), { fetch: send as typeof fetch });
    await expect(client.generateJson(request, context())).rejects.toMatchObject({ code: 'timeout', retryable: true });
    expect(send.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it('maps caller cancellation to a canonical non-retryable error', async () => {
    const controller = new AbortController(); controller.abort();
    const client = createLlmClient(loadLlmConfig({ LLM_PROVIDER: 'fake' }));
    await expect(client.generateJson(request, context(controller.signal))).rejects.toMatchObject({ code: 'invalid_request', retryable: false } satisfies Partial<DataScoutError>);
  });
});

describe('LLM configuration', () => {
  it.each([
    ['unknown provider', { LLM_PROVIDER: 'local' }],
    ['invalid timeout', { LLM_TIMEOUT_MS: '0' }],
    ['invalid token cap', { LLM_MAX_OUTPUT_TOKENS: '8193' }],
    ['missing Gemini model', { LLM_PROVIDER: 'gemini', GEMINI_API_KEY: 'key' }],
    ['missing Gemini key', { LLM_PROVIDER: 'gemini', GEMINI_MODEL_ID: 'm' }],
    ['missing Ollama model', { LLM_PROVIDER: 'ollama' }],
    ['remote Ollama over insecure HTTP', { LLM_PROVIDER: 'ollama', OLLAMA_MODEL_ID: 'm', OLLAMA_BASE_URL: 'http://models.example.test' }],
    ['unauthenticated remote Ollama over HTTPS', { LLM_PROVIDER: 'ollama', OLLAMA_MODEL_ID: 'm', OLLAMA_BASE_URL: 'https://models.example.test' }],
  ])('rejects %s explicitly', (_description, env) => {
    expect(() => loadLlmConfig(env)).toThrow(TypeError);
  });

  it('rejects expired deadlines as retryable timeouts', async () => {
    const client = createLlmClient(loadLlmConfig({ LLM_PROVIDER: 'fake' }));
    await expect(client.generateJson({ ...request, user: 'Find crop yield data for Maharashtra with rainfall and temperature fields.' }, context(new AbortController().signal, Date.now() - 1))).rejects.toMatchObject({ code: 'timeout', retryable: true });
  });
});
