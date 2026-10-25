import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type LlmProvider = 'fake' | 'cassette';

export interface LlmConfig {
  provider: LlmProvider;
  modelId: string;
  cassetteDirectory: string;
  timeoutMs: number;
  maxOutputTokens: number;
}

export type LlmEnvironment = Record<string, string | undefined>;

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 1_024;
const MAX_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_TOKENS = 8_192;
const DEFAULT_CASSETTE_DIRECTORY = resolve(
  fileURLToPath(new URL('../cassettes/', import.meta.url)),
);

function parseInteger(
  env: LlmEnvironment,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = env[name];
  if (value === undefined || value.trim() === '') return fallback;
  if (!/^\d+$/.test(value.trim())) {
    throw new TypeError(
      `${name} must be an integer between ${min} and ${max}.`,
    );
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new TypeError(
      `${name} must be an integer between ${min} and ${max}.`,
    );
  }
  return parsed;
}

export function loadLlmConfig(env: LlmEnvironment = process.env): LlmConfig {
  const provider = (env.LLM_PROVIDER ?? 'fake').trim();
  if (
    provider !== 'fake' &&
    provider !== 'cassette'
  ) {
    throw new TypeError('LLM_PROVIDER must be fake or cassette.');
  }

  const timeoutMs = parseInteger(
    env,
    'LLM_TIMEOUT_MS',
    DEFAULT_TIMEOUT_MS,
    1,
    MAX_TIMEOUT_MS,
  );
  const maxOutputTokens = parseInteger(
    env,
    'LLM_MAX_OUTPUT_TOKENS',
    DEFAULT_MAX_OUTPUT_TOKENS,
    1,
    MAX_OUTPUT_TOKENS,
  );
  const cassetteDirectory =
    env.LLM_CASSETTE_DIR?.trim() || DEFAULT_CASSETTE_DIRECTORY;

  return {
    provider,
    modelId: provider === 'fake' ? 'fake-datascout-v0.1' : 'cassette-datascout-v1',
    cassetteDirectory,
    timeoutMs,
    maxOutputTokens,
  };
}
