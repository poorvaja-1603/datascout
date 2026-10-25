import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type LlmProvider = 'fake' | 'cassette' | 'gemini' | 'ollama';

export interface LlmConfig {
  provider: LlmProvider;
  modelId: string;
  baseUrl?: string;
  apiKey?: string;
  safetyModelId?: string;
  cassetteDirectory: string;
  timeoutMs: number;
  maxOutputTokens: number;
}

export type LlmEnvironment = Record<string, string | undefined>;

export interface SafetyAdmissionConfig {
  enabled: boolean;
  maxConcurrent: number;
  perUserDailyLimit: number;
  globalDailyLimit: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 1_024;
const MAX_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_TOKENS = 8_192;
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
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
    throw new TypeError(`${name} must be an integer between ${min} and ${max}.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new TypeError(`${name} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

export function loadSafetyAdmissionConfig(env: LlmEnvironment = process.env): SafetyAdmissionConfig {
  const enabledValue = (env.LLM_ENABLED ?? 'false').trim().toLowerCase();
  if (enabledValue !== 'true' && enabledValue !== 'false') {
    throw new TypeError('LLM_ENABLED must be true or false.');
  }
  return {
    enabled: enabledValue === 'true',
    maxConcurrent: parseInteger(env, 'LLM_MAX_CONCURRENT', 4, 1, 10_000),
    perUserDailyLimit: parseInteger(env, 'LLM_PER_USER_DAILY_LIMIT', 30, 1, 1_000_000),
    globalDailyLimit: parseInteger(env, 'LLM_GLOBAL_DAILY_LIMIT', 300, 1, 10_000_000),
  };
}

export function loadLlmConfig(env: LlmEnvironment = process.env): LlmConfig {
  const rawProvider = (env.LLM_PROVIDER ?? 'fake').trim();
  if (rawProvider !== 'fake' && rawProvider !== 'cassette' && rawProvider !== 'gemini' && rawProvider !== 'ollama') {
    throw new TypeError('LLM_PROVIDER must be fake, cassette, gemini, or ollama.');
  }
  const provider: LlmProvider = rawProvider;
  const timeoutMs = parseInteger(env, 'LLM_TIMEOUT_MS', DEFAULT_TIMEOUT_MS, 1, MAX_TIMEOUT_MS);
  const maxOutputTokens = parseInteger(env, 'LLM_MAX_OUTPUT_TOKENS', DEFAULT_MAX_OUTPUT_TOKENS, 1, MAX_OUTPUT_TOKENS);
  const cassetteDirectory = env.LLM_CASSETTE_DIR?.trim() || DEFAULT_CASSETTE_DIRECTORY;

  if (provider === 'gemini' || provider === 'ollama') {
    const modelId = (provider === 'gemini' ? env.GEMINI_MODEL_ID : env.OLLAMA_MODEL_ID)?.trim() || env.LLM_MODEL_ID?.trim();
    if (!modelId) {
      throw new TypeError(`${provider === 'gemini' ? 'GEMINI_MODEL_ID' : 'OLLAMA_MODEL_ID'} is required.`);
    }
    const apiKey = provider === 'gemini' ? env.GEMINI_API_KEY?.trim() : undefined;
    if (provider === 'gemini' && !apiKey) {
      throw new TypeError('GEMINI_API_KEY is required for Gemini.');
    }
    const baseUrl = provider === 'gemini'
      ? GEMINI_BASE_URL
      : env.OLLAMA_BASE_URL?.trim() || 'http://127.0.0.1:11434';
    let url: URL;
    try {
      url = new URL(baseUrl);
    } catch {
      throw new TypeError('OLLAMA_BASE_URL must be a valid HTTP(S) URL.');
    }
    const localOllama = provider === 'ollama' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && localOllama)) ||
      (provider === 'ollama' && !localOllama) ||
      url.username || url.password || url.search || url.hash) {
      throw new TypeError('Ollama must use a loopback URL until authenticated remote access is implemented.');
    }
    return {
      provider,
      modelId,
      baseUrl: baseUrl.replace(/\/+$/u, ''),
      ...(apiKey ? { apiKey } : {}),
      ...(env.LLM_SAFETY_MODEL_ID?.trim() ? { safetyModelId: env.LLM_SAFETY_MODEL_ID.trim() } : {}),
      cassetteDirectory,
      timeoutMs,
      maxOutputTokens,
    };
  }

  return {
    provider,
    modelId: env.LLM_MODEL_ID?.trim() ||
      (provider === 'fake' ? 'fake-datascout-v0.1' : 'cassette-datascout-v1'),
    cassetteDirectory,
    timeoutMs,
    maxOutputTokens,
  };
}
