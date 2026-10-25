import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DataScoutError } from '@datascout/contracts';
import type { CallContext, LlmJsonRequest } from '@datascout/contracts';
import { createLlmClient, getCassetteKey } from '../src/client.js';
import { loadLlmConfig } from '../src/config.js';

const request: LlmJsonRequest = {
  task: 'extract',
  promptVersion: 'test-v1',
  system: 'Return JSON.',
  user: 'fixture request',
  jsonSchema: {
    type: 'object',
    properties: { value: { type: 'string' } },
  },
  maxOutputTokens: 100,
  timeoutMs: 1_000,
};

function context(
  signal: AbortSignal = new AbortController().signal,
  deadlineMs = Date.now() + 5_000,
): CallContext {
  return {
    requestId: 'test-request',
    signal,
    deadlineMs,
    tracer: {
      withSpan: async (_name, _opts, fn) =>
        fn({ setAttributes: () => undefined, score: () => undefined }),
      flush: async () => undefined,
    },
  };
}

const cassetteDirectory = fileURLToPath(
  new URL('./fixtures/cassettes/', import.meta.url),
);

describe('LLM client providers', () => {
  it('calls the same contract with the fake provider', async () => {
    const fakeRequest = {
      ...request,
      user: 'Find crop yield data for Maharashtra with rainfall and temperature fields.',
    };
    const client = createLlmClient(loadLlmConfig({ LLM_PROVIDER: 'fake' }));
    const response = await client.generateJson(fakeRequest, context());

    expect(client.provider).toBe('fake');
    expect(response.output).toMatchObject({ topic: 'crop yield' });
    expect(response.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it('replays a request cassette deterministically without exposing its key', async () => {
    const config = loadLlmConfig({
      LLM_PROVIDER: 'cassette',
      LLM_CASSETTE_DIR: cassetteDirectory,
    });
    const client = createLlmClient(config);
    const first = await client.generateJson(request, context());
    const second = await client.generateJson(request, context());

    expect(getCassetteKey(request)).toBe(
      'e2ab8a9c45ba870ca805f06acdfc759c98e5f164e37de278301982ab878e1b6d',
    );
    expect(client.provider).toBe('cassette');
    expect(first).toEqual({ ...second, latencyMs: first.latencyMs });
    expect(first.output).toEqual({ value: 'replayed' });
    expect(first.modelId).toBe('recorded-test-model');
    expect(JSON.stringify(first)).not.toContain(request.user);
  });

  it('maps caller cancellation to the canonical non-retryable error', async () => {
    const controller = new AbortController();
    controller.abort();
    const client = createLlmClient(loadLlmConfig({ LLM_PROVIDER: 'fake' }));

    await expect(
      client.generateJson(request, context(controller.signal)),
    ).rejects.toMatchObject({
      code: 'invalid_request',
      retryable: false,
    } satisfies Partial<DataScoutError>);
  });
});

describe('LLM configuration', () => {
  it.each([
    ['unknown provider', { LLM_PROVIDER: 'local' }],
    ['invalid timeout', { LLM_TIMEOUT_MS: '0' }],
    ['invalid token cap', { LLM_MAX_OUTPUT_TOKENS: '8193' }],
  ])('rejects %s explicitly', (_description, env) => {
    expect(() => loadLlmConfig(env)).toThrow(TypeError);
  });

  it('rejects an expired call deadline as a retryable timeout', async () => {
    const client = createLlmClient(loadLlmConfig({ LLM_PROVIDER: 'fake' }));
    await expect(
      client.generateJson(
        {
          ...request,
          user: 'Find crop yield data for Maharashtra with rainfall and temperature fields.',
        },
        context(new AbortController().signal, Date.now() - 1),
      ),
    ).rejects.toMatchObject({ code: 'timeout', retryable: true });
  });
});
