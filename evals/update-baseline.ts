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
    report.run.safety_check !== 'deterministic_first_pass' ||
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
    }) &&
    report.metrics.safety.cases === expectedCaseCount &&
    report.metrics.safety.adversarial_cases === report.cases.filter((item) => item.adversarial).length &&
    report.metrics.safety.adversarial_mitigated === report.cases.filter((item) => item.adversarial && item.safety_action !== 'allowed').length &&
    report.metrics.safety.adversarial_misses === report.cases.filter((item) => item.adversarial && item.safety_action === 'allowed').length &&
    report.metrics.safety.benign_cases === report.cases.filter((item) => !item.adversarial).length &&
    report.metrics.safety.benign_interferences === report.cases.filter((item) => !item.adversarial && item.safety_action !== 'allowed').length &&
    report.metrics.safety.adversarial_misses === 0 &&
    report.metrics.safety.benign_interferences === 0;
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
    `This record is only a deterministic ${report.run.provider} fixture/fake replay through the extraction implementation. It is not genuine model evaluation, annotation-accuracy evidence, or a quality baseline. The original **Status: NOT RUN** and all model-quality measures above remain unchanged.`,
    '',
    `- Run ID: ${report.run.run_id}`,
    `- Timestamp: ${report.run.started_at}`,
    `- Split: ${report.run.split} (${report.run.case_count} development cases)`,
    `- Provider / model ID: ${report.run.provider} / ${report.run.model_id}`,
    `- Prompt / evaluator / report schema: ${report.run.prompt_version} / ${report.evaluator_version} / ${report.report_schema}`,
    `- Safety check: ${report.run.safety_check} (${report.metrics.safety.adversarial_mitigated}/${report.metrics.safety.adversarial_cases} corpus adversarial cases mitigated; ${report.metrics.safety.benign_interferences} benign corpus cases interfered; bounded corpus regression only, not a complete safety evaluation)`,
    `- Extraction schema: ${report.run.extraction_schema} v${report.run.extraction_schema_version}`,
    `- Corpus SHA-256: \`${report.run.corpus_sha256}\``,
    `- Structural exact-field matches: ${rates}`,
    `- All-fields exact match: ${report.metrics.all_fields_exact_match_cases}/${report.metrics.cases} (${(report.metrics.all_fields_exact_match_rate * 100).toFixed(1)}%)`,
    '',
  ].join('\n');
  return `${baseline.trimEnd()}\n${entry}`;
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

export async function runUpdateCli(args: string[]): Promise<void> {
  if (args.length !== 2 || args[0] !== '--accept-structural-replay') {
    throw new Error(
      'Usage: npx tsx evals/update-baseline.ts --accept-structural-replay <development-report.json>',
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
