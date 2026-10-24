import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import {
  EVALUATION_KIND,
  EVALUATOR_VERSION,
  REPORT_SCHEMA_VERSION,
  type EvaluationReport,
  FIELD_NAMES,
} from './runner.js';
import {
  MODEL_EVALUATOR_VERSION,
  MODEL_REPORT_SCHEMA,
  type ModelEvaluationReport,
} from './model-runner.js';

export function assertSafeBaselineUpdate(
  report: EvaluationReport,
  explicitOptIn: boolean,
): void {
  if (!explicitOptIn) {
    throw new Error(
      'Baseline update requires --accept-structural-replay; this report is not model-quality evidence.',
    );
  }
  if (
    report.report_schema !== REPORT_SCHEMA_VERSION ||
    report.evaluator_version !== EVALUATOR_VERSION ||
    report.evaluation_kind !== EVALUATION_KIND ||
    report.quality_claim !== 'none_structural_replay_only' ||
    report.run.split !== 'development' ||
    !['fake', 'cassette'].includes(report.run.provider) ||
    report.cases.some((testCase) => testCase.split !== 'development') ||
    report.run.case_count !== report.cases.length ||
    report.metrics.cases !== report.cases.length ||
    report.run.prompt_version.trim() === '' ||
    report.run.safety_check !== 'evaluation_allow_all' ||
    report.run.model_id.trim() === '' ||
    !/^[a-f0-9]{64}$/.test(report.run.corpus_sha256) ||
    FIELD_NAMES.some((field) => !report.metrics.per_field[field])
  ) {
    throw new Error(
      'Refusing to update baseline: report is not a valid development-only structural replay.',
    );
  }
  const expectedCaseCount = report.cases.length;
  const allFieldsExact = report.cases.filter((testCase) =>
    FIELD_NAMES.every((field) => testCase.fields[field]?.exact_match === true),
  ).length;
  const metricsConsistent =
    report.metrics.all_fields_exact_match_cases === allFieldsExact &&
    report.metrics.all_fields_exact_match_rate === allFieldsExact / expectedCaseCount &&
    FIELD_NAMES.every((field) => {
      const exactMatches = report.cases.filter(
        (testCase) => testCase.fields[field]?.exact_match === true,
      ).length;
      const metric = report.metrics.per_field[field];
      return (
        metric.cases === expectedCaseCount &&
        metric.exact_matches === exactMatches &&
        metric.exact_match_rate === exactMatches / expectedCaseCount
      );
    });
  if (!metricsConsistent) {
    throw new Error(
      'Refusing to update baseline: report metrics do not match its per-case field results.',
    );
  }
}

export function appendStructuralReplay(
  baseline: string,
  report: EvaluationReport,
  explicitOptIn: boolean,
): string {
  assertSafeBaselineUpdate(report, explicitOptIn);
  if (baseline.includes(`Run ID: ${report.run.run_id}`)) {
    throw new Error(`Baseline already contains run ${report.run.run_id}.`);
  }
  const rates = FIELD_NAMES.map((field) => {
    const metric = report.metrics.per_field[field];
    return `${field} ${metric.exact_matches}/${metric.cases} (${(
      metric.exact_match_rate * 100
    ).toFixed(1)}%)`;
  }).join('; ');
  const entry = [
    '',
    '## Structural cassette/fake replay (not model accuracy)',
    '',
    `This record is only a deterministic ${report.run.provider} fixture/fake replay through the extraction implementation. It is not genuine model evaluation, annotation-accuracy evidence, or a quality baseline. The model-quality status and measures remain unchanged.`,
    '',
    `- Run ID: ${report.run.run_id}`,
    `- Timestamp: ${report.run.started_at}`,
    `- Split: ${report.run.split} (${report.run.case_count} development cases)`,
    `- Provider / model ID: ${report.run.provider} / ${report.run.model_id}`,
    `- Prompt / evaluator / report schema: ${report.run.prompt_version} / ${report.evaluator_version} / ${report.report_schema}`,
    `- Safety check: ${report.run.safety_check} (no production classifier; not a safety evaluation)`,
    `- Extraction schema: ${report.run.extraction_schema} v${report.run.extraction_schema_version}`,
    `- Corpus SHA-256: \`${report.run.corpus_sha256}\``,
    `- Structural exact-field matches: ${rates}`,
    `- All-fields exact match: ${report.metrics.all_fields_exact_match_cases}/${report.metrics.cases} (${(report.metrics.all_fields_exact_match_rate * 100).toFixed(1)}%)`,
    '',
  ].join('\n');
  return `${baseline.trimEnd()}\n${entry}`;
}

export function assertSafeModelBaselineUpdate(
  report: ModelEvaluationReport,
): void {
  if (
    report.report_schema !== MODEL_REPORT_SCHEMA ||
    report.evaluator_version !== MODEL_EVALUATOR_VERSION ||
    report.quality_claim !== 'measured_model_output_not_release_approval' ||
    report.run.provider !== 'ollama' ||
    report.run.split !== 'development' ||
    report.cases.some((testCase) => testCase.split !== 'development') ||
    report.run.case_count !== report.cases.length ||
    report.metrics.cases !== report.cases.length ||
    report.run.model_id.trim() === '' ||
    !/^[a-f0-9]{64}$/u.test(report.run.corpus_sha256) ||
    FIELD_NAMES.some((field) => !report.metrics.per_field[field])
  ) {
    throw new Error(
      'Refusing to update baseline: report is not a valid development-only Ollama model evaluation.',
    );
  }
  const allFieldsExact = report.cases.filter((testCase) =>
    FIELD_NAMES.every((field) => testCase.fields[field]?.exact_match === true),
  ).length;
  const resultKinds = { ok: 0, clarification: 0, refused: 0, error: 0 };
  for (const testCase of report.cases) resultKinds[testCase.result_kind] += 1;
  const metricsConsistent =
    report.metrics.all_fields_exact_match_cases === allFieldsExact &&
    report.metrics.all_fields_exact_match_rate === allFieldsExact / report.cases.length &&
    Object.entries(resultKinds).every(([kind, count]) =>
      report.metrics.result_kinds[kind as keyof typeof resultKinds] === count,
    ) &&
    FIELD_NAMES.every((field) => {
      const exactMatches = report.cases.filter(
        (testCase) => testCase.fields[field]?.exact_match === true,
      ).length;
      const metric = report.metrics.per_field[field];
      return metric.cases === report.cases.length &&
        metric.exact_matches === exactMatches &&
        metric.exact_match_rate === exactMatches / report.cases.length;
    });
  if (!metricsConsistent) {
    throw new Error('Refusing to update baseline: model report metrics do not match its case results.');
  }
}

export function appendModelEvaluation(
  baseline: string,
  report: ModelEvaluationReport,
  reportPath: string,
): string {
  assertSafeModelBaselineUpdate(report);
  if (baseline.includes(`Run ID: ${report.run.run_id}`)) {
    throw new Error(`Baseline already contains run ${report.run.run_id}.`);
  }
  const fieldRates = FIELD_NAMES.map((field) => {
    const metric = report.metrics.per_field[field];
    return `${field} ${metric.exact_matches}/${metric.cases} (${(metric.exact_match_rate * 100).toFixed(1)}%)`;
  }).join('; ');
  const updatedStatus = baseline.replace(/^\*\*Status:.*\*\*$/mu,
    '**Status: DEVELOPMENT BASELINE RECORDED; HELD-OUT NOT RUN.**');
  const updatedTable = updatedStatus.replace(
    /^\| Requirement extraction accuracy \|.*$/mu,
    `| Requirement extraction accuracy | Development measured; held-out not run | Local Ollama ${report.run.model_id}, ${report.metrics.cases} development cases; report: \`${reportPath}\` |`,
  );
  const updatedIntro = updatedTable.replace(
    /^The v1 requirement contract and extraction implementation exist\..*$/mu,
    'The v1 requirement contract and extraction implementation exist. A local Ollama development baseline has been measured, but held-out quality and release gates remain unrun. The development result is diagnostic, not release approval.',
  );
  const entry = [
    '',
    '## Live local model evaluation (development only)',
    '',
    'This is a measured model-output baseline on the development split, not a release approval. No held-out examples were used. Refusals and errors count as extraction mismatches; safety correctness is not independently labeled by this corpus.',
    '',
    `- Run ID: ${report.run.run_id}`,
    `- Timestamp: ${report.run.started_at}`,
    `- Split: ${report.run.split} (${report.run.case_count} cases)`,
    `- Provider / model ID: ${report.run.provider} / ${report.run.model_id}`,
    `- Prompt / evaluator / report schema: ${report.run.prompt_version} / ${report.evaluator_version} / ${report.report_schema}`,
    `- Safety path: ${report.run.safety_triage}; result kinds ok=${report.metrics.result_kinds.ok}, clarification=${report.metrics.result_kinds.clarification}, refused=${report.metrics.result_kinds.refused}, error=${report.metrics.result_kinds.error}`,
    `- Extraction schema: ${report.run.extraction_schema} v${report.run.extraction_schema_version}`,
    `- Timeout: ${report.run.timeout_ms} ms`,
    `- Corpus SHA-256: \`${report.run.corpus_sha256}\``,
    `- Per-field exact matches: ${fieldRates}`,
    `- All-fields exact match: ${report.metrics.all_fields_exact_match_cases}/${report.metrics.cases} (${(report.metrics.all_fields_exact_match_rate * 100).toFixed(1)}%)`,
    `- Full report: \`${reportPath}\``,
    '',
  ].join('\n');
  return `${updatedIntro.trimEnd()}\n${entry}`;
}

export async function updateBaseline(
  reportPath: string,
  explicitOptIn: boolean,
): Promise<void> {
  const scriptDirectory = fileURLToPath(new URL('.', import.meta.url));
  const baselinePath = resolve(scriptDirectory, 'BASELINE.md');
  const report = JSON.parse(
    await readFile(resolve(reportPath), 'utf8'),
  ) as EvaluationReport;
  const baseline = await readFile(baselinePath, 'utf8');
  const updated = appendStructuralReplay(baseline, report, explicitOptIn);
  await writeFile(baselinePath, updated, 'utf8');
}

export async function updateModelBaseline(reportPath: string): Promise<void> {
  const scriptDirectory = fileURLToPath(new URL('.', import.meta.url));
  const baselinePath = resolve(scriptDirectory, 'BASELINE.md');
  const report = JSON.parse(await readFile(resolve(reportPath), 'utf8')) as ModelEvaluationReport;
  const baseline = await readFile(baselinePath, 'utf8');
  const updated = appendModelEvaluation(baseline, report, reportPath);
  await writeFile(baselinePath, updated, 'utf8');
}

export async function runUpdateCli(args: string[]): Promise<void> {
  if (args.length === 2 && args[0] === '--accept-model-evaluation') {
    await updateModelBaseline(args[1]!);
    console.log('Appended a verified development-only local model baseline; held-out status remains pending.');
    return;
  }
  if (args.length !== 2 || args[0] !== '--accept-structural-replay') {
    throw new Error(
      'Usage: npx tsx evals/update-baseline.ts --accept-structural-replay <report.json> | --accept-model-evaluation <development-model-report.json>',
    );
  }
  await updateBaseline(args[1]!, true);
  console.log(
    'Appended a clearly labeled structural replay record; model-quality baseline remains NOT RUN.',
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runUpdateCli(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Baseline update failed.');
    process.exitCode = 1;
  });
}
