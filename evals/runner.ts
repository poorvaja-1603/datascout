import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { ExtractionResult } from '@datascout/contracts';
import type { CallContext } from '@datascout/contracts';
import {
  createLlmClient,
  createRequirementExtractor,
  EXTRACTION_PROMPT_VERSION,
  loadLlmConfig,
} from '../packages/ai/src/index.js';
import { createRequestSafetyCheck } from '../packages/ai/src/safety.js';

export const REPORT_SCHEMA_VERSION = 'extraction-report-v2';
export const EVALUATOR_VERSION = 'extraction-evaluator-v2';
export const EVALUATION_KIND = 'structural_fixture_replay_with_safety_preflight';
export const FIELD_NAMES = [
  'topic',
  'geography',
  'time_coverage',
  'minimum_records',
  'required_features',
  'target',
  'preferences',
  'constraints',
] as const;

export type FieldName = (typeof FIELD_NAMES)[number];
export type Split = 'development' | 'held_out';
export type Provider = 'fake' | 'cassette';
export type FieldValue = string | number | string[] | null;

export interface CorpusCase {
  case_id: string;
  split: Split;
  input: string;
  categories: string[];
  expected: Record<FieldName, FieldValue>;
}

export interface EvaluationOptions {
  corpusText: string;
  split?: Split;
  provider?: Provider;
  cassetteDirectory?: string;
  extract?: (input: string) => Promise<ExtractionResult>;
  now?: Date;
}

interface FieldComparison {
  expected: FieldValue;
  actual: FieldValue | null;
  exact_match: boolean;
}

interface EvaluationCase {
  case_id: string;
  split: Split;
  result_kind: ExtractionResult['kind'];
  safety_action: 'allowed' | 'sanitized' | 'refused';
  adversarial: boolean;
  fields: Record<FieldName, FieldComparison>;
}

export interface EvaluationReport {
  report_schema: typeof REPORT_SCHEMA_VERSION;
  evaluator_version: typeof EVALUATOR_VERSION;
  evaluation_kind: typeof EVALUATION_KIND;
  quality_claim: 'none_structural_replay_only';
  run: {
    run_id: string;
    started_at: string;
    split: Split;
    provider: Provider;
    model_id: string;
    configured_model_id: string;
    prompt_version: string;
    safety_check: 'deterministic_first_pass';
    extraction_schema: 'ExtractedRequirements';
    extraction_schema_version: '1';
    corpus_sha256: string;
    case_count: number;
    cassette_directory: string | null;
  };
  metrics: {
    cases: number;
    all_fields_exact_match_cases: number;
    all_fields_exact_match_rate: number;
    per_field: Record<
      FieldName,
      { exact_matches: number; cases: number; exact_match_rate: number }
    >;
    safety: {
      cases: number;
      adversarial_cases: number;
      adversarial_mitigated: number;
      adversarial_misses: number;
      benign_cases: number;
      benign_interferences: number;
    };
  };
  cases: EvaluationCase[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeExpectedTime(value: FieldValue): FieldValue {
  if (typeof value !== 'string') return value;
  const range = value.match(
    /\b(?:from\s+|between\s+)?(\d{4})\s*(?:-|–|—|to|through|and)\s*(\d{4})\b/i,
  );
  return range ? `${range[1]}-${range[2]}` : value;
}

export function parseCorpus(corpusText: string): CorpusCase[] {
  return corpusText
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line, index) => {
      let value: unknown;
      try {
        value = JSON.parse(line) as unknown;
      } catch {
        throw new Error(`Invalid JSON in corpus line ${index + 1}.`);
      }
      if (!isRecord(value)) {
        throw new Error(`Invalid corpus case on line ${index + 1}.`);
      }
      const expected = value.expected;
      const categories = value.categories;
      if (!isRecord(expected)) {
        throw new Error(`Invalid corpus case on line ${index + 1}.`);
      }
      if (
        typeof value.case_id !== 'string' ||
        (value.split !== 'development' && value.split !== 'held_out') ||
        typeof value.input !== 'string' ||
        !Array.isArray(categories) || categories.some((category) => typeof category !== 'string') ||
        FIELD_NAMES.some((field) => !(field in expected))
      ) {
        throw new Error(`Invalid corpus case on line ${index + 1}.`);
      }
      return {
        case_id: value.case_id,
        split: value.split,
        input: value.input,
        categories,
        expected: Object.fromEntries(
          FIELD_NAMES.map((field) => [
            field,
            field === 'time_coverage'
              ? normalizeExpectedTime(expected[field] as FieldValue)
              : (expected[field] as FieldValue),
          ]),
        ) as Record<FieldName, FieldValue>,
      };
    });
}

function extractedFields(
  result: ExtractionResult,
): Record<FieldName, FieldValue> | null {
  if (result.kind !== 'ok') return null;
  return result.requirements;
}

function equalField(expected: FieldValue, actual: FieldValue): boolean {
  if (Array.isArray(expected) || Array.isArray(actual)) {
    return (
      Array.isArray(expected) &&
      Array.isArray(actual) &&
      expected.length === actual.length &&
      expected.every((value, index) => value === actual[index])
    );
  }
  return expected === actual;
}

function responseKind(result: ExtractionResult): EvaluationCase['result_kind'] {
  return result.kind;
}

export async function evaluate(options: EvaluationOptions): Promise<EvaluationReport> {
  if (options.extract && options.provider === undefined) {
    throw new Error(
      'An injected extractor requires an explicit provider identity for accurate run metadata.',
    );
  }
  const split = options.split ?? 'development';
  const provider = options.provider ?? 'cassette';
  const selected = parseCorpus(options.corpusText).filter(
    (testCase) => testCase.split === split,
  );
  if (selected.length === 0) {
    throw new Error(`The corpus contains no ${split} cases.`);
  }

  const startedAt = (options.now ?? new Date()).toISOString();
  const defaultCassetteDirectory = fileURLToPath(
    new URL('../packages/ai/test/fixtures/corpus-cassettes/', import.meta.url),
  );
  const cassetteDirectory =
    provider === 'cassette'
      ? resolve(options.cassetteDirectory ?? defaultCassetteDirectory)
      : null;
  if (split === 'held_out' && provider === 'cassette' && cassetteDirectory) {
    const [defaultDirectory, requestedDirectory] = await Promise.all([
      realpath(defaultCassetteDirectory),
      realpath(cassetteDirectory),
    ]);
    const sameDirectory =
      process.platform === 'win32'
        ? defaultDirectory.toLowerCase() === requestedDirectory.toLowerCase()
        : defaultDirectory === requestedDirectory;
    if (sameDirectory) {
      throw new Error(
        'Held-out cassette runs cannot use the development cassette directory.',
      );
    }
  }
  let configuredModelId = provider === 'fake' ? 'fake-datascout-v0.1' : 'cassette-datascout-v1';
  const modelIds = new Set<string>();
  let extract = options.extract;
  const safetyCheck = createRequestSafetyCheck();

  if (!extract) {
    const config = loadLlmConfig({
      LLM_PROVIDER: provider,
      ...(cassetteDirectory ? { LLM_CASSETTE_DIR: cassetteDirectory } : {}),
    });
    const client = createLlmClient(config);
    configuredModelId = client.modelId;
    const extractor = createRequirementExtractor(client, safetyCheck);
    extract = async (input) => {
      const controller = new AbortController();
      const context = {
        requestId: 'eval-extraction',
        signal: controller.signal,
        deadlineMs: Date.now() + 60_000,
        tracer: {
          withSpan: async <T>(
            _name: string,
            _options: { kind: 'span' | 'generation' },
            callback: (span: {
              setAttributes(attributes: Record<string, string | number | boolean>): void;
              score(name: string, value: number | boolean, comment?: string): void;
            }) => Promise<T>,
          ) =>
            callback({
              setAttributes: () => undefined,
              score: () => undefined,
            }),
          flush: async () => undefined,
        },
      };
      return extractor.extract(input, context);
    };
  }

  const cases: EvaluationCase[] = [];
  const safetyContext: CallContext = {
    requestId: 'eval-safety-preflight',
    signal: new AbortController().signal,
    deadlineMs: Date.now() + 60_000,
    tracer: { withSpan: async (_name, _options, callback) => callback({ setAttributes() {}, score() {} }), flush: async () => undefined },
  };
  for (const testCase of selected) {
    const safetyDecision = safetyCheck(testCase.input, safetyContext);
    const safetyAction = safetyDecision === null
      ? 'allowed'
      : typeof safetyDecision === 'string' ? 'refused' : 'sanitized';
    const adversarial = testCase.categories.includes('adversarial');
    if ((adversarial && safetyAction === 'allowed') || (!adversarial && safetyAction !== 'allowed')) {
      throw new Error(`Safety preflight assertion failed for ${testCase.case_id} (${adversarial ? 'adversarial' : 'benign'} case: ${safetyAction}).`);
    }
    let result: ExtractionResult;
    try {
      result = await extract(testCase.input);
      if (result.kind === 'ok') modelIds.add(result.modelId);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(
        `Extraction failed for ${testCase.case_id}; no partial report written (${errorMessage}).`,
        { cause: error },
      );
    }
    const actualFields = extractedFields(result);
    const fields = Object.fromEntries(
      FIELD_NAMES.map((field) => {
        const actual = actualFields?.[field] ?? null;
        const expected = testCase.expected[field];
        return [
          field,
          {
            expected,
            actual: actualFields === null ? null : actual,
            exact_match:
              actualFields !== null && equalField(expected, actual),
          },
        ];
      }),
    ) as Record<FieldName, FieldComparison>;
    cases.push({
      case_id: testCase.case_id,
      split,
      result_kind: responseKind(result),
      safety_action: safetyAction,
      adversarial,
      fields,
    });
  }

  const perField = Object.fromEntries(
    FIELD_NAMES.map((field) => {
      const exactMatches = cases.filter(
        (testCase) => testCase.fields[field].exact_match,
      ).length;
      return [
        field,
        {
          exact_matches: exactMatches,
          cases: cases.length,
          exact_match_rate: exactMatches / cases.length,
        },
      ];
    }),
  ) as EvaluationReport['metrics']['per_field'];
  const allFieldsExact = cases.filter((testCase) =>
    FIELD_NAMES.every((field) => testCase.fields[field].exact_match),
  ).length;
  const modelId =
    modelIds.size === 1
      ? [...modelIds][0]!
      : modelIds.size > 1
        ? [...modelIds].sort().join(', ')
        : configuredModelId;
  const corpusSha256 = createHash('sha256')
    .update(options.corpusText, 'utf8')
    .digest('hex');

  return {
    report_schema: REPORT_SCHEMA_VERSION,
    evaluator_version: EVALUATOR_VERSION,
    evaluation_kind: EVALUATION_KIND,
    quality_claim: 'none_structural_replay_only',
    run: {
      run_id: `${startedAt.replace(/[:.]/g, '-')}-${split}`,
      started_at: startedAt,
      split,
      provider,
      model_id: modelId,
      configured_model_id: configuredModelId,
      prompt_version: EXTRACTION_PROMPT_VERSION,
      safety_check: 'deterministic_first_pass',
      extraction_schema: 'ExtractedRequirements',
      extraction_schema_version: '1',
      corpus_sha256: corpusSha256,
      case_count: cases.length,
      cassette_directory: cassetteDirectory,
    },
    metrics: {
      cases: cases.length,
      all_fields_exact_match_cases: allFieldsExact,
      all_fields_exact_match_rate: allFieldsExact / cases.length,
      per_field: perField,
      safety: {
        cases: cases.length,
        adversarial_cases: cases.filter((item) => item.adversarial).length,
        adversarial_mitigated: cases.filter((item) => item.adversarial && item.safety_action !== 'allowed').length,
        adversarial_misses: cases.filter((item) => item.adversarial && item.safety_action === 'allowed').length,
        benign_cases: cases.filter((item) => !item.adversarial).length,
        benign_interferences: cases.filter((item) => !item.adversarial && item.safety_action !== 'allowed').length,
      },
    },
    cases,
  };
}

export interface CliOptions {
  split: Split;
  provider: Provider;
  outputPath: string;
  cassetteDirectory?: string;
}

export function parseArgs(args: string[]): CliOptions | { help: true } {
  let split: Split = 'development';
  let provider: Provider = 'cassette';
  let outputPath: string | undefined;
  let cassetteDirectory: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--heldout') {
      split = 'held_out';
      continue;
    }
    if (arg === '--provider') {
      const value = args[++index];
      if (value !== 'fake' && value !== 'cassette') {
        throw new Error('--provider must be fake or cassette.');
      }
      provider = value;
      continue;
    }
    if (arg === '--out') {
      outputPath = args[++index];
      if (!outputPath) throw new Error('--out requires a path.');
      continue;
    }
    if (arg === '--cassette-dir') {
      cassetteDirectory = args[++index];
      if (!cassetteDirectory) throw new Error('--cassette-dir requires a path.');
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  if (split === 'held_out' && provider === 'cassette' && !cassetteDirectory) {
    throw new Error(
      '--heldout with the cassette provider requires a separate --cassette-dir; the development cassette set is never used for held-out cases.',
    );
  }
  return {
    split,
    provider,
    outputPath: resolve(
      outputPath ??
        `evals/reports/extraction-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
    ),
    ...(cassetteDirectory ? { cassetteDirectory: resolve(cassetteDirectory) } : {}),
  };
}

export async function writeReport(
  report: EvaluationReport,
  outputPath: string,
): Promise<void> {
  const destination = resolve(outputPath);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

export async function runCli(args: string[]): Promise<void> {
  const options = parseArgs(args);
  if ('help' in options) {
    console.log(
      'Usage: npx tsx evals/runner.ts [--heldout] [--provider fake|cassette] [--cassette-dir path] [--out path]',
    );
    return;
  }
  const corpusPath = fileURLToPath(
    new URL('./requirements-v0.1.jsonl', import.meta.url),
  );
  const corpusText = await readFile(corpusPath, 'utf8');
  const report = await evaluate({
    corpusText,
    split: options.split,
    provider: options.provider,
    ...(options.cassetteDirectory
      ? { cassetteDirectory: options.cassetteDirectory }
      : {}),
  });
  await writeReport(report, options.outputPath);
  console.log(
    `Wrote ${report.run.case_count} ${report.run.split} cases (${report.evaluation_kind}; no model-quality claim). Safety preflight: ${report.metrics.safety.adversarial_mitigated}/${report.metrics.safety.adversarial_cases} adversarial cases mitigated; ${report.metrics.safety.benign_interferences}/${report.metrics.safety.benign_cases} benign cases interfered. Report: ${options.outputPath}`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Evaluation failed.');
    process.exitCode = 1;
  });
}
