import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DataScoutError } from '../contracts/src/index.js';
import type { CallContext, LlmJsonRequest } from '../contracts/src/index.js';
import { createLlmClient, loadLlmConfig } from '../packages/ai/src/index.js';

if (!process.argv.includes('--confirm-single-call')) {
  throw new Error('Pass --confirm-single-call to permit exactly one Gemini request.');
}

const config = loadLlmConfig({
  ...process.env,
  LLM_PROVIDER: 'gemini',
  LLM_FALLBACK_PROVIDER: '',
  LLM_TIMEOUT_MS: '30000',
  LLM_MAX_OUTPUT_TOKENS: '128',
});
if (config.provider !== 'gemini') throw new Error('Gemini configuration was not loaded.');

let httpStatus: number | null = null;
let transportErrorType: string | null = null;
const client = createLlmClient(config, {
  fetch: async (input, init) => {
    try {
      const response = await fetch(input, init);
      httpStatus = response.status;
      return response;
    } catch (error) {
      transportErrorType = error instanceof Error ? error.name : 'unknown';
      throw error;
    }
  },
});
const request: LlmJsonRequest = {
  task: 'extract',
  promptVersion: 'gemini-smoke-v1',
  system: 'Return only the requested JSON object. This is a connectivity check.',
  user: 'For this synthetic smoke test, return {"ok":true}.',
  jsonSchema: {
    type: 'object',
    properties: { ok: { type: 'boolean' } },
    required: ['ok'],
    additionalProperties: false,
  },
  maxOutputTokens: 128,
  timeoutMs: 30000,
};
const ctx: CallContext = {
  requestId: `gemini-smoke-${Date.now()}`,
  principalId: 'local-gemini-smoke',
  signal: new AbortController().signal,
  deadlineMs: Date.now() + 35_000,
  tracer: {
    withSpan: async (_name, _options, callback) =>
      callback({ setAttributes() {}, score() {} }),
    flush: async () => undefined,
  },
};

const completedAt = new Date().toISOString();
let report: Record<string, unknown>;
try {
  const result = await client.generateJson(request, ctx);
  const valid =
    typeof result.output === 'object' &&
    result.output !== null &&
    (result.output as Record<string, unknown>).ok === true;
  report = {
    report_schema: 'gemini-single-call-smoke-v1',
    quality_claim: 'provider_connectivity_only_not_quality_evaluation',
    outcome: valid ? 'passed' : 'invalid_response',
    completed_at: completedAt,
    provider: 'gemini',
    model_id: result.modelId,
    http_status: httpStatus,
    usage: result.usage,
    latency_ms: result.latencyMs,
    requests_sent: 1,
    fallback_enabled: false,
    response_schema_valid: valid,
  };
  if (!valid) process.exitCode = 1;
} catch (error) {
  report = {
    report_schema: 'gemini-single-call-smoke-v1',
    quality_claim: 'provider_connectivity_only_not_quality_evaluation',
    outcome: 'failed',
    completed_at: completedAt,
    provider: 'gemini',
    model_id: config.modelId,
    http_status: httpStatus,
    safe_error_code:
      error instanceof DataScoutError ? error.code : 'unknown_client_error',
    transport_error_type: transportErrorType,
    requests_sent: 1,
    fallback_enabled: false,
    response_schema_valid: false,
    usage: null,
  };
  process.exitCode = 1;
}

const reportPath = resolve(
  'evals/reports',
  `gemini-smoke-${new Date().toISOString().replace(/[:.]/gu, '-')}.json`,
);
await mkdir(resolve('evals/reports'), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ ...report, report: reportPath }, null, 2));
