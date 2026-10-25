import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { CallContext, ExtractionResult, ExtractedRequirements } from '@datascout/contracts';
import {
  createInMemorySafetyBudgetStore,
  createLlmClient,
  createRequirementExtractor,
  createSafetyAdmission,
  loadLlmConfig,
} from '../packages/ai/src/index.js';
import { FIELD_NAMES, parseCorpus } from './runner.js';
import type { FieldName, FieldValue, Split } from './runner.js';

export const MODEL_EVALUATOR_VERSION = 'model-extraction-evaluator-v2';
export const MODEL_REPORT_SCHEMA = 'live-extraction-report-v1';

type ResultKind = ExtractionResult['kind'] | 'error';

interface ModelCaseResult {
  case_id: string;
  split: Split;
  result_kind: ResultKind;
  model_id: string | null;
  error_code?: string;
  fields: Record<FieldName, {
    expected: FieldValue;
    actual: FieldValue | null;
    exact_match: boolean;
  }>;
}

export interface ModelEvaluationReport {
  report_schema: typeof MODEL_REPORT_SCHEMA;
  evaluator_version: typeof MODEL_EVALUATOR_VERSION;
  quality_claim: 'measured_model_output_not_release_approval';
  run: {
    run_id: string;
    started_at: string;
    split: Split;
    provider: 'ollama';
    model_id: string;
    prompt_version: 'extract-v1';
    extraction_schema: 'ExtractedRequirements';
    extraction_schema_version: '1';
    corpus_sha256: string;
    case_count: number;
    timeout_ms: number;
    safety_triage: 'enabled_with_local_in_memory_budget';
  };
  metrics: {
    cases: number;
    all_fields_exact_match_cases: number;
    all_fields_exact_match_rate: number;
    result_kinds: Record<ResultKind, number>;
    per_field: Record<FieldName, {
      exact_matches: number;
      cases: number;
      exact_match_rate: number;
    }>;
  };
  cases: ModelCaseResult[];
}

export interface ModelEvaluationOptions {
  corpusText: string;
  split?: Split;
  modelId: string;
  timeoutMs: number;
  now?: Date;
  extract: (input: string, caseId: string) => Promise<ExtractionResult>;
}

function emptyRequirements(): ExtractedRequirements {
  return {
    topic: null,
    geography: null,
    time_coverage: null,
    minimum_records: null,
    required_features: [],
    target: null,
    preferences: [],
    constraints: [],
  };
}

function actualFields(result: ExtractionResult): ExtractedRequirements | null {
  if (result.kind === 'ok') return result.requirements;
  if (result.kind === 'clarification') return emptyRequirements();
  return null;
}

function sameValue(expected: FieldValue, actual: FieldValue | null): boolean {
  if (Array.isArray(expected) || Array.isArray(actual)) {
    return Array.isArray(expected) && Array.isArray(actual) &&
      expected.length === actual.length &&
      expected.every((value, index) => value === actual[index]);
  }
  return expected === actual;
}

function safeErrorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error &&
    typeof error.code === 'string' && /^[a-z_]{1,64}$/u.test(error.code)) {
    return error.code;
  }
  return 'evaluation_error';
}

export async function evaluateModel(options: ModelEvaluationOptions): Promise<ModelEvaluationReport> {
  const split = options.split ?? 'development';
  const corpus = parseCorpus(options.corpusText);
  const selected = corpus.filter((item) => item.split === split);
  if (selected.length === 0) throw new Error(`The corpus contains no ${split} cases.`);
  const startedAt = (options.now ?? new Date()).toISOString();
  const cases: ModelCaseResult[] = [];

  for (const [index, testCase] of selected.entries()) {
    let result: ExtractionResult | null = null;
    let errorCode: string | undefined;
    try {
      result = await options.extract(testCase.input, testCase.case_id);
    } catch (error) {
      errorCode = safeErrorCode(error);
    }
    const fields = Object.fromEntries(FIELD_NAMES.map((field) => {
      const actual = result === null ? null : actualFields(result)?.[field] ?? null;
      const expected = testCase.expected[field];
      return [field, {
        expected,
        actual,
        exact_match: result !== null && result.kind !== 'refused' && sameValue(expected, actual),
      }];
    })) as ModelCaseResult['fields'];
    cases.push({
      case_id: testCase.case_id,
      split,
      result_kind: result?.kind ?? 'error',
      model_id: result?.kind === 'ok' ? result.modelId : options.modelId,
      ...(errorCode ? { error_code: errorCode } : {}),
      fields,
    });
    console.log(`Evaluated ${index + 1}/${selected.length}: ${testCase.case_id} (${result?.kind ?? errorCode})`);
  }

  const resultKinds: Record<ResultKind, number> = {
    ok: 0,
    clarification: 0,
    refused: 0,
    error: 0,
  };
  for (const item of cases) resultKinds[item.result_kind] += 1;
  const perField = Object.fromEntries(FIELD_NAMES.map((field) => {
    const exactMatches = cases.filter((item) => item.fields[field].exact_match).length;
    return [field, { exact_matches: exactMatches, cases: cases.length, exact_match_rate: exactMatches / cases.length }];
  })) as ModelEvaluationReport['metrics']['per_field'];
  const allFieldsExact = cases.filter((item) => FIELD_NAMES.every((field) => item.fields[field].exact_match)).length;

  return {
    report_schema: MODEL_REPORT_SCHEMA,
    evaluator_version: MODEL_EVALUATOR_VERSION,
    quality_claim: 'measured_model_output_not_release_approval',
    run: {
      run_id: `${startedAt.replace(/[:.]/gu, '-')}-${split}`,
      started_at: startedAt,
      split,
      provider: 'ollama',
      model_id: options.modelId,
      prompt_version: 'extract-v1',
      extraction_schema: 'ExtractedRequirements',
      extraction_schema_version: '1',
      corpus_sha256: createHash('sha256').update(options.corpusText).digest('hex'),
      case_count: cases.length,
      timeout_ms: options.timeoutMs,
      safety_triage: 'enabled_with_local_in_memory_budget',
    },
    metrics: {
      cases: cases.length,
      all_fields_exact_match_cases: allFieldsExact,
      all_fields_exact_match_rate: allFieldsExact / cases.length,
      result_kinds: resultKinds,
      per_field: perField,
    },
    cases,
  };
}

function noOpContext(caseId: string, timeoutMs: number): CallContext {
  return {
    requestId: `local-eval-${caseId}`,
    principalId: 'local-evaluation',
    signal: new AbortController().signal,
    deadlineMs: Date.now() + timeoutMs * 2 + 30_000,
    tracer: {
      withSpan: async (_name, _options, callback) => callback({ setAttributes: () => undefined, score: () => undefined }),
      flush: async () => undefined,
    },
  };
}

function parseCli(args: string[]): { split: Split; modelId: string; timeoutMs: number } {
  let split: Split = 'development';
  let modelId = process.env['OLLAMA_MODEL_ID']?.trim() || 'qwen3:8b';
  let timeoutMs = 120_000;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--heldout') split = 'held_out';
    else if (arg === '--model' && args[index + 1]) modelId = args[++index]!;
    else if (arg === '--timeout-ms' && args[index + 1]) timeoutMs = Number(args[++index]);
    else throw new Error('Usage: model-runner.ts [--model <ollama-model>] [--timeout-ms <ms>] [--heldout]');
  }
  if (!modelId || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000) {
    throw new Error('Model ID or timeout is invalid; timeout must be 1000..300000 ms.');
  }
  return { split, modelId, timeoutMs };
}

export async function runModelEvaluationCli(args: string[]): Promise<void> {
  const { split, modelId, timeoutMs } = parseCli(args);
  const corpusPath = fileURLToPath(new URL('./requirements-v0.1.jsonl', import.meta.url));
  const corpusText = await readFile(corpusPath, 'utf8');
  const config = loadLlmConfig({
    ...process.env,
    LLM_PROVIDER: 'ollama',
    OLLAMA_MODEL_ID: modelId,
    LLM_TIMEOUT_MS: String(timeoutMs),
  });
  const client = createLlmClient(config);
  const admission = createSafetyAdmission({
    enabled: true,
    maxConcurrent: 1,
    perUserDailyLimit: 300,
    globalDailyLimit: 300,
    store: createInMemorySafetyBudgetStore(),
  });
  const extractor = createRequirementExtractor(client, undefined, admission);
  const report = await evaluateModel({
    corpusText,
    split,
    modelId: client.modelId,
    timeoutMs,
    extract: (input, caseId) => extractor.extract(input, noOpContext(caseId, timeoutMs)),
  });
  const outputDirectory = resolve(dirname(corpusPath), 'reports');
  await mkdir(outputDirectory, { recursive: true });
  const outputPath = resolve(outputDirectory, `model-${modelId.replace(/[^a-zA-Z0-9_-]/gu, '-')}-${report.run.run_id.replace(/[:.]/gu, '-')}.json`);
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`Saved local Ollama evaluation (${report.metrics.cases} ${split} cases) to ${outputPath}`);
  console.log(`All-fields exact match: ${report.metrics.all_fields_exact_match_cases}/${report.metrics.cases}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runModelEvaluationCli(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Local model evaluation failed.');
    process.exitCode = 1;
  });
}
