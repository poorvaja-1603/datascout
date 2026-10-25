import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { CallContext, ExtractionResult, ExtractedRequirements } from '@datascout/contracts';
import {
  createInMemorySafetyBudgetStore,
  createLlmClient,
  createRequirementExtractor,
  EXTRACTION_PROMPT_VERSION,
  createSafetyAdmission,
  loadLlmConfig,
  SAFETY_RULESET_VERSION,
  SAFETY_TRIAGE_PROMPT_VERSION,
} from '../packages/ai/src/index.js';
import { FIELD_NAMES, parseCorpus } from './runner.js';
import type { FieldName, FieldValue, Split } from './runner.js';

export const MODEL_EVALUATOR_VERSION = 'model-extraction-evaluator-v4';
export const MODEL_REPORT_SCHEMA = 'live-extraction-report-v3';

type ResultKind = ExtractionResult['kind'] | 'error';

interface ModelCaseResult {
  case_id: string;
  split: Split;
  result_kind: ResultKind;
  model_id: string | null;
  error_code?: string;
  refusal_reason_code?: string;
  safety_triage?: { decision: string; category: string } | undefined;
  fields: Record<FieldName, {
    expected: FieldValue;
    actual: FieldValue | null;
    exact_match: boolean;
    true_positives: number;
    false_positives: number;
    false_negatives: number;
    precision: number | null;
    recall: number | null;
    f1: number | null;
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
    prompt_version: string;
    extraction_schema: 'ExtractedRequirements';
    extraction_schema_version: '1';
    corpus_sha256: string;
    case_count: number;
    timeout_ms: number;
    safety_triage: 'enabled_with_local_in_memory_budget';
    safety_ruleset_version: typeof SAFETY_RULESET_VERSION;
    safety_triage_prompt_version: typeof SAFETY_TRIAGE_PROMPT_VERSION;
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
      true_positives: number;
      false_positives: number;
      false_negatives: number;
      precision: number | null;
      recall: number | null;
      f1: number | null;
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
  safetyTriage?: (caseId: string) => { decision: string; category: string } | undefined;
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

function valueItems(value: FieldValue | null): string[] {
  if (value === null) return [];
  return (Array.isArray(value) ? value : [value]).map((item) => JSON.stringify(item));
}

function itemCounts(expected: FieldValue, actual: FieldValue | null) {
  const expectedItems = valueItems(expected);
  const actualItems = valueItems(actual);
  const remaining = new Map<string, number>();
  for (const item of expectedItems) remaining.set(item, (remaining.get(item) ?? 0) + 1);
  let truePositives = 0;
  let falsePositives = 0;
  for (const item of actualItems) {
    const count = remaining.get(item) ?? 0;
    if (count > 0) {
      truePositives += 1;
      remaining.set(item, count - 1);
    } else falsePositives += 1;
  }
  return {
    truePositives,
    falsePositives,
    falseNegatives: expectedItems.length - truePositives,
  };
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
      const counts = itemCounts(expected, actual);
      const precision = counts.truePositives + counts.falsePositives === 0
        ? null : counts.truePositives / (counts.truePositives + counts.falsePositives);
      const recall = counts.truePositives + counts.falseNegatives === 0
        ? null : counts.truePositives / (counts.truePositives + counts.falseNegatives);
      const f1 = precision === null || recall === null || precision + recall === 0
        ? null : 2 * precision * recall / (precision + recall);
      return [field, {
        expected,
        actual,
        exact_match: result !== null && result.kind !== 'refused' && sameValue(expected, actual),
        true_positives: counts.truePositives,
        false_positives: counts.falsePositives,
        false_negatives: counts.falseNegatives,
        precision,
        recall,
        f1,
      }];
    })) as ModelCaseResult['fields'];
    cases.push({
      case_id: testCase.case_id,
      split,
      result_kind: result?.kind ?? 'error',
      model_id: result?.kind === 'ok' ? result.modelId : options.modelId,
      ...(errorCode ? { error_code: errorCode } : {}),
      ...(result?.kind === 'refused' ? { refusal_reason_code: result.reasonCode } : {}),
      ...(options.safetyTriage?.(testCase.case_id)
        ? { safety_triage: options.safetyTriage(testCase.case_id) }
        : {}),
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
    const truePositives = cases.reduce((sum, item) => sum + item.fields[field].true_positives, 0);
    const falsePositives = cases.reduce((sum, item) => sum + item.fields[field].false_positives, 0);
    const falseNegatives = cases.reduce((sum, item) => sum + item.fields[field].false_negatives, 0);
    const precision = truePositives + falsePositives === 0 ? null : truePositives / (truePositives + falsePositives);
    const recall = truePositives + falseNegatives === 0 ? null : truePositives / (truePositives + falseNegatives);
    const f1 = precision === null || recall === null || precision + recall === 0
      ? null : 2 * precision * recall / (precision + recall);
    return [field, {
      exact_matches: exactMatches, cases: cases.length, exact_match_rate: exactMatches / cases.length,
      true_positives: truePositives, false_positives: falsePositives, false_negatives: falseNegatives,
      precision, recall, f1,
    }];
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
      prompt_version: EXTRACTION_PROMPT_VERSION,
      extraction_schema: 'ExtractedRequirements',
      extraction_schema_version: '1',
      corpus_sha256: createHash('sha256').update(options.corpusText).digest('hex'),
      case_count: cases.length,
      timeout_ms: options.timeoutMs,
      safety_triage: 'enabled_with_local_in_memory_budget',
      safety_ruleset_version: SAFETY_RULESET_VERSION,
      safety_triage_prompt_version: SAFETY_TRIAGE_PROMPT_VERSION,
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

function noOpContext(
  caseId: string,
  timeoutMs: number,
  onSafetyTriage: (attributes: Record<string, string | number | boolean>) => void,
): CallContext {
  return {
    requestId: `local-eval-${caseId}`,
    principalId: 'local-evaluation',
    signal: new AbortController().signal,
    deadlineMs: Date.now() + timeoutMs * 2 + 30_000,
    tracer: {
      withSpan: async (name, _options, callback) => callback({
        setAttributes: (attributes) => {
          if (name === 'safety.triage') onSafetyTriage(attributes);
        },
        score: () => undefined,
      }),
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
  const triageResults = new Map<string, { decision: string; category: string }>();
  const report = await evaluateModel({
    corpusText,
    split,
    modelId: client.modelId,
    timeoutMs,
    extract: (input, caseId) => extractor.extract(input, noOpContext(caseId, timeoutMs, (attributes) => {
      const decision = attributes['safety.triage.decision'];
      const category = attributes['safety.triage.category'];
      if (typeof decision === 'string' && typeof category === 'string') {
        triageResults.set(caseId, { decision, category });
      }
    })),
    safetyTriage: (caseId) => triageResults.get(caseId),
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
