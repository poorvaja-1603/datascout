import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ConverseCommandOutput,
  type ConverseCommandInput,
} from '@aws-sdk/client-bedrock-runtime';
import {
  DATASCOUT_ERROR_CODES,
  DataScoutError,
  FakeLlmClient,
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

type JsonDocument =
  | null
  | boolean
  | number
  | string
  | JsonDocument[]
  | { [key: string]: JsonDocument };

interface JsonLlmClientOptions {
  provider: LlmClient['provider'];
  modelId: string;
  config: LlmConfig;
  invoke: (
    req: LlmJsonRequest,
    signal: AbortSignal,
  ) => Promise<Omit<LlmJsonResponse, 'latencyMs'>>;
}

export interface LlmClientDependencies {
  sendBedrock?: (
    command: ConverseCommand,
    signal: AbortSignal,
  ) => Promise<ConverseCommandOutput>;
}

function assertConfig(config: LlmConfig): void {
  if (
    !['fake', 'cassette', 'bedrock'].includes(config.provider) ||
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
    config.provider === 'bedrock' &&
    (!config.region?.trim() || !config.modelId.trim())
  ) {
    throw new TypeError(
      'Bedrock configuration requires AWS region and model ID.',
    );
  }
  if (!config.cassetteDirectory.trim()) {
    throw new TypeError('LLM_CASSETTE_DIR must not be empty.');
  }
}

function validateRequest(req: LlmJsonRequest, config: LlmConfig): number {
  if (
    (req.task !== 'extract' && req.task !== 'explain') ||
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
  private readonly config: LlmConfig;
  private readonly invoke: JsonLlmClientOptions['invoke'];

  constructor(options: JsonLlmClientOptions) {
    this.provider = options.provider;
    this.modelId = options.modelId;
    this.config = options.config;
    this.invoke = options.invoke;
  }

  async generateJson(
    req: LlmJsonRequest,
    ctx: CallContext,
  ): Promise<LlmJsonResponse> {
    throwIfAborted(ctx.signal);
    const maxOutputTokens = validateRequest(req, this.config);
    const timeoutMs = Math.min(req.timeoutMs, this.config.timeoutMs);
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

function bedrockError(error: unknown): DataScoutError {
  const name =
    typeof error === 'object' && error !== null && 'name' in error
      ? String(error.name)
      : '';
  if (
    name === 'ThrottlingException' ||
    name === 'TooManyRequestsException' ||
    name === 'ServiceQuotaExceededException'
  ) {
    return new DataScoutError(
      DATASCOUT_ERROR_CODES.llmThrottled,
      'The LLM provider is rate limiting requests.',
    );
  }
  if (
    name === 'ServiceUnavailableException' ||
    name === 'InternalServerException' ||
    name === 'ModelNotReadyException'
  ) {
    return new DataScoutError(
      'upstream_unavailable',
      'The LLM provider is temporarily unavailable.',
    );
  }
  return new DataScoutError(
    'extraction_failed',
    'The LLM provider could not complete the request.',
  );
}

function createBedrockClient(
  config: LlmConfig,
  dependencies: LlmClientDependencies,
): LlmClient {
  const runtime = new BedrockRuntimeClient({ region: config.region! });
  const send =
    dependencies.sendBedrock ??
    ((command: ConverseCommand, signal: AbortSignal) =>
      runtime.send(command, { abortSignal: signal }));
  return new ConfiguredLlmClient({
    provider: 'bedrock',
    modelId: config.modelId,
    config,
    invoke: async (req, signal) => {
      const input: ConverseCommandInput = {
        modelId: config.modelId,
        system: [{ text: req.system }],
        messages: [{ role: 'user', content: [{ text: req.user }] }],
        inferenceConfig: {
          maxTokens: req.maxOutputTokens,
          temperature: 0.1,
        },
        toolConfig: {
          tools: [
            {
              toolSpec: {
                name: 'emit_json',
                description:
                  'Return the requested data in the supplied JSON schema.',
                inputSchema: {
                  json: JSON.parse(
                    JSON.stringify(req.jsonSchema),
                  ) as JsonDocument,
                },
              },
            },
          ],
          toolChoice: { tool: { name: 'emit_json' } },
        },
      };
      try {
        const response = await send(new ConverseCommand(input), signal);
        const toolUse = response.output?.message?.content?.find(
          (block) => 'toolUse' in block,
        );
        if (!toolUse || !('toolUse' in toolUse)) {
          throw new DataScoutError(
            'extraction_failed',
            'The LLM provider returned no structured output.',
          );
        }
        return {
          output: toolUse.toolUse.input,
          modelId: config.modelId,
          usage: {
            inputTokens: response.usage?.inputTokens ?? 0,
            outputTokens: response.usage?.outputTokens ?? 0,
          },
        };
      } catch (error) {
        if (error instanceof DataScoutError) throw error;
        throw bedrockError(error);
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
    case 'bedrock':
      return createBedrockClient(config, dependencies);
  }
}

export { stableRequestKey as getCassetteKey };
