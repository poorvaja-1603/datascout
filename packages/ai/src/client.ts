import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  DATASCOUT_ERROR_CODES,
  DataScoutError,
  FakeLlmClient,
  redactSensitiveText,
  throwIfAborted,
} from '@datascout/contracts';
import type {
  CallContext,
  LlmClient,
  LlmJsonRequest,
  LlmJsonResponse,
} from '@datascout/contracts';
import type { LlmConfig } from './config.js';

interface Cassette {
  output: unknown;
  modelId?: string;
  usage: { inputTokens: number; outputTokens: number };
}

interface JsonLlmClientOptions {
  provider: LlmClient['provider'];
  modelId: string;
  safetyModelId?: string;
  config: LlmConfig;
  invoke: (
    req: LlmJsonRequest,
    signal: AbortSignal,
  ) => Promise<Omit<LlmJsonResponse, 'latencyMs'>>;
}

export interface LlmClientDependencies {
  fetch?: typeof fetch;
}

function assertConfig(config: LlmConfig): void {
  if (
    !['fake', 'cassette', 'gemini', 'ollama'].includes(
      config.provider,
    ) ||
    !Number.isSafeInteger(config.timeoutMs) ||
    config.timeoutMs < 1 ||
    config.timeoutMs > 300_000 ||
    !Number.isSafeInteger(config.maxOutputTokens) ||
    config.maxOutputTokens < 1 ||
    config.maxOutputTokens > 8_192 ||
    !config.modelId.trim()
  ) {
    throw new TypeError(
      'LLM configuration contains invalid limits or model ID.',
    );
  }
  if (
    (config.provider === 'gemini' || config.provider === 'ollama') &&
    (!config.baseUrl?.trim() || !config.modelId.trim())
  ) {
    throw new TypeError(
      'External LLM configuration requires base URL and model ID.',
    );
  }
  if (!config.cassetteDirectory.trim()) {
    throw new TypeError('LLM_CASSETTE_DIR must not be empty.');
  }
}

function validateRequest(req: LlmJsonRequest, config: LlmConfig): number {
  if (
    !['extract', 'explain', 'safety_triage'].includes(req.task) ||
    typeof req.promptVersion !== 'string' ||
    !req.promptVersion.trim() ||
    typeof req.system !== 'string' ||
    typeof req.user !== 'string' ||
    typeof req.jsonSchema !== 'object' ||
    req.jsonSchema === null ||
    Array.isArray(req.jsonSchema) ||
    !Number.isSafeInteger(req.maxOutputTokens) ||
    req.maxOutputTokens < 1 ||
    !Number.isSafeInteger(req.timeoutMs) ||
    req.timeoutMs < 1
  ) {
    throw new DataScoutError(
      'invalid_request',
      'The LLM request settings are invalid.',
    );
  }
  return Math.min(req.maxOutputTokens, config.maxOutputTokens);
}

class ConfiguredLlmClient implements LlmClient {
  readonly provider: LlmClient['provider'];
  readonly modelId: string;
  readonly safetyModelId: string | undefined;
  private readonly config: LlmConfig;
  private readonly invoke: JsonLlmClientOptions['invoke'];

  constructor(options: JsonLlmClientOptions) {
    this.provider = options.provider;
    this.modelId = options.modelId;
    this.safetyModelId = options.safetyModelId;
    this.config = options.config;
    this.invoke = options.invoke;
  }

  async generateJson(
    req: LlmJsonRequest,
    ctx: CallContext,
  ): Promise<LlmJsonResponse> {
    throwIfAborted(ctx.signal);
    const maxOutputTokens = validateRequest(req, this.config);
    const timeoutMs = this.provider === 'ollama' && req.task !== 'safety_triage'
      ? this.config.timeoutMs
      : Math.min(req.timeoutMs, this.config.timeoutMs);
    if (!Number.isFinite(ctx.deadlineMs)) {
      throw new DataScoutError(
        'invalid_request',
        'The LLM request deadline is invalid.',
      );
    }
    const remainingMs = ctx.deadlineMs - Date.now();
    if (remainingMs <= 0) {
      throw new DataScoutError(
        DATASCOUT_ERROR_CODES.llmTimeout,
        'The LLM request timed out.',
      );
    }
    const boundedRequest = { ...req, maxOutputTokens, timeoutMs };
    const controller = new AbortController();
    const startedAt = Date.now();
    let rejectAbort!: (error: DataScoutError) => void;
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = reject;
    });
    const onCallerAbort = (): void => {
      controller.abort();
      rejectAbort(
        new DataScoutError(
          DATASCOUT_ERROR_CODES.requestAborted,
          'The request was cancelled.',
        ),
      );
    };
    ctx.signal.addEventListener('abort', onCallerAbort, { once: true });
    const timer = setTimeout(
      () => {
        controller.abort();
        rejectAbort(
          new DataScoutError(
            DATASCOUT_ERROR_CODES.llmTimeout,
            'The LLM request timed out.',
          ),
        );
      },
      Math.min(timeoutMs, remainingMs),
    );

    try {
      const response = await Promise.race([
        this.invoke(boundedRequest, controller.signal),
        aborted,
      ]);
      if (ctx.signal.aborted) {
        throw new DataScoutError(
          DATASCOUT_ERROR_CODES.requestAborted,
          'The request was cancelled.',
        );
      }
      if (controller.signal.aborted) {
        throw new DataScoutError(
          DATASCOUT_ERROR_CODES.llmTimeout,
          'The LLM request timed out.',
        );
      }
      return { ...response, latencyMs: Date.now() - startedAt };
    } catch (error) {
      if (ctx.signal.aborted) {
        throw new DataScoutError(
          DATASCOUT_ERROR_CODES.requestAborted,
          'The request was cancelled.',
        );
      }
      if (controller.signal.aborted) {
        throw new DataScoutError(
          DATASCOUT_ERROR_CODES.llmTimeout,
          'The LLM request timed out.',
        );
      }
      if (error instanceof DataScoutError) throw error;
      throw error;
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', onCallerAbort);
    }
  }
}

function stableRequestKey(req: LlmJsonRequest): string {
  const identity = canonicalJson({
    task: req.task,
    promptVersion: req.promptVersion,
    system: req.system,
    user: req.user,
    jsonSchema: req.jsonSchema,
  });
  return createHash('sha256').update(identity).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    const fields = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${fields.join(',')}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new DataScoutError(
      'invalid_request',
      'The LLM request schema is invalid.',
    );
  }
  return serialized;
}

function parseCassette(value: unknown): Cassette {
  if (typeof value !== 'object' || value === null || !('output' in value)) {
    throw new DataScoutError(
      DATASCOUT_ERROR_CODES.fixtureNotFound,
      'The LLM cassette is invalid.',
    );
  }
  const cassette = value as Partial<Cassette>;
  const usage = cassette.usage ?? { inputTokens: 0, outputTokens: 0 };
  if (
    !Number.isSafeInteger(usage.inputTokens) ||
    usage.inputTokens < 0 ||
    !Number.isSafeInteger(usage.outputTokens) ||
    usage.outputTokens < 0
  ) {
    throw new DataScoutError(
      DATASCOUT_ERROR_CODES.fixtureNotFound,
      'The LLM cassette is invalid.',
    );
  }
  return {
    output: cassette.output,
    ...(typeof cassette.modelId === 'string'
      ? { modelId: cassette.modelId }
      : {}),
    usage,
  };
}

function createCassetteClient(config: LlmConfig): LlmClient {
  return new ConfiguredLlmClient({
    provider: 'cassette',
    modelId: config.modelId,
    config,
    invoke: async (req, signal) => {
      if (signal.aborted) {
        throw new DataScoutError(
          DATASCOUT_ERROR_CODES.llmTimeout,
          'The LLM request timed out.',
        );
      }
      const key = stableRequestKey(req);
      let content: string;
      try {
        content = await readFile(
          resolve(config.cassetteDirectory, `${key}.json`),
          'utf8',
        );
      } catch {
        if (signal.aborted) {
          throw new DataScoutError(
            DATASCOUT_ERROR_CODES.llmTimeout,
            'The LLM request timed out.',
          );
        }
        throw new DataScoutError(
          DATASCOUT_ERROR_CODES.fixtureNotFound,
          'No cassette is available for this LLM request.',
        );
      }

      try {
        const cassette = parseCassette(JSON.parse(content) as unknown);
        return {
          output: cassette.output,
          modelId: cassette.modelId ?? config.modelId,
          usage: cassette.usage!,
        };
      } catch (error) {
        if (error instanceof DataScoutError) throw error;
        throw new DataScoutError(
          DATASCOUT_ERROR_CODES.fixtureNotFound,
          'The LLM cassette is invalid.',
        );
      }
    },
  });
}

function providerError(status: number): DataScoutError {
  if (status === 429) {
    return new DataScoutError(
      DATASCOUT_ERROR_CODES.llmThrottled,
      'The LLM provider is rate limiting requests.',
    );
  }
  if (status === 408 || status >= 500) {
    return new DataScoutError(
      status === 408 ? 'timeout' : 'upstream_unavailable',
      'The LLM provider is temporarily unavailable.',
    );
  }
  return new DataScoutError(
    'extraction_failed',
    'The LLM provider could not complete the request.',
    false,
  );
}

function parseJsonContent(content: unknown): unknown {
  if (typeof content !== 'string') {
    throw new DataScoutError(
      'extraction_failed',
      'The LLM provider returned invalid structured output.',
      false,
    );
  }
  try {
    return JSON.parse(content) as unknown;
  } catch {
    throw new DataScoutError(
      'extraction_failed',
      'The LLM provider returned invalid structured output.',
      false,
    );
  }
}

function createRemoteClient(
  config: LlmConfig,
  dependencies: LlmClientDependencies,
): LlmClient {
  const send = dependencies.fetch ?? fetch;
  const provider = config.provider;
  if (provider !== 'gemini' && provider !== 'ollama') {
    throw new TypeError('A Gemini or Ollama provider is required.');
  }
  return new ConfiguredLlmClient({
    provider,
    modelId: config.modelId,
    ...(config.safetyModelId ? { safetyModelId: config.safetyModelId } : {}),
    config,
    invoke: async (req, signal) => {
      try {
        const modelId = req.modelId ?? config.modelId;
        const endpoint = provider === 'gemini'
          ? `${config.baseUrl}/models/${encodeURIComponent(modelId)}:generateContent`
          : `${config.baseUrl}/api/chat`;
        const headers: Record<string, string> = {
          'content-type': 'application/json',
        };
        const system = redactSensitiveText(req.system);
        if (provider === 'gemini') headers['x-goog-api-key'] = config.apiKey!;
        const body = provider === 'gemini'
          ? {
              systemInstruction: { parts: [{ text: system }] },
              contents: [{ role: 'user', parts: [{ text: redactSensitiveText(req.user) }] }],
              generationConfig: {
                temperature: 0,
                maxOutputTokens: req.maxOutputTokens,
                responseMimeType: 'application/json',
                responseJsonSchema: req.jsonSchema,
              },
            }
          : {
              model: modelId,
              stream: false,
              think: false,
              messages: [
                { role: 'system', content: `${system}\n\nReturn JSON matching this schema: ${JSON.stringify(req.jsonSchema)}` },
                { role: 'user', content: redactSensitiveText(req.user) },
              ],
              format: req.jsonSchema,
              options: { temperature: 0, num_predict: req.maxOutputTokens },
            };
        const response = await send(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal,
        });
        if (!response.ok) throw providerError(response.status);
        const payload: unknown = await response.json();
        if (typeof payload !== 'object' || payload === null) {
          throw new DataScoutError(
            'extraction_failed',
            'The LLM provider returned an invalid response.',
            false,
          );
        }
        const data = payload as Record<string, unknown>;
        let output: unknown;
        let inputTokens = 0;
        let outputTokens = 0;
        if (provider === 'gemini') {
          const candidates = Array.isArray(data['candidates']) ? data['candidates'] : [];
          const content = candidates[0] && typeof candidates[0] === 'object'
            ? (candidates[0] as Record<string, unknown>)['content'] : undefined;
          const parts = content && typeof content === 'object'
            ? (content as Record<string, unknown>)['parts'] : undefined;
          const text = Array.isArray(parts) && parts[0] && typeof parts[0] === 'object'
            ? (parts[0] as Record<string, unknown>)['text'] : undefined;
          output = parseJsonContent(text);
          const usage = typeof data['usageMetadata'] === 'object' && data['usageMetadata'] !== null
            ? data['usageMetadata'] as Record<string, unknown> : {};
          inputTokens = typeof usage['promptTokenCount'] === 'number' ? usage['promptTokenCount'] : 0;
          outputTokens = typeof usage['candidatesTokenCount'] === 'number' ? usage['candidatesTokenCount'] : 0;
        } else {
          const message = typeof data['message'] === 'object' && data['message'] !== null
            ? data['message'] as Record<string, unknown> : {};
          output = parseJsonContent(message['content']);
          inputTokens = typeof data['prompt_eval_count'] === 'number' ? data['prompt_eval_count'] : 0;
          outputTokens = typeof data['eval_count'] === 'number' ? data['eval_count'] : 0;
        }
        return {
          output,
          modelId,
          usage: {
            inputTokens,
            outputTokens,
          },
        };
      } catch (error) {
        if (error instanceof DataScoutError) throw error;
        if (signal.aborted) {
          throw new DataScoutError('timeout', 'The LLM request timed out.');
        }
        throw new DataScoutError(
          'upstream_unavailable',
          'The LLM provider is temporarily unavailable.',
        );
      }
    },
  });
}

export function createLlmClient(
  config: LlmConfig,
  dependencies: LlmClientDependencies = {},
): LlmClient {
  assertConfig(config);
  switch (config.provider) {
    case 'fake': {
      const fake = new FakeLlmClient();
      return new ConfiguredLlmClient({
        provider: 'fake',
        modelId: fake.modelId,
        config,
        invoke: async (req, signal) => {
          const response = await fake.generateJson(req, {
            requestId: 'ai-client',
            signal,
            deadlineMs: Number.MAX_SAFE_INTEGER,
            tracer: {
              withSpan: async (_name, _opts, fn) =>
                fn({
                  setAttributes: () => undefined,
                  score: () => undefined,
                }),
              flush: async () => undefined,
            },
          });
          return {
            output: response.output,
            modelId: response.modelId,
            usage: response.usage,
          };
        },
      });
    }
    case 'cassette':
      return createCassetteClient(config);
    case 'gemini':
    case 'ollama':
      return createRemoteClient(config, dependencies);
  }
}

export { stableRequestKey as getCassetteKey };
