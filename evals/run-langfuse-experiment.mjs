import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { LangfuseClient } from '@langfuse/client';

const split = process.argv.includes('--heldout') ? 'held_out' : 'development';
if (split === 'held_out' && !process.argv.includes('--confirm-frozen')) {
  throw new Error('Held-out experiment requires --confirm-frozen after prompt and schema freeze.');
}
const reportArg = process.argv.find((arg) => arg.startsWith('--report='))?.slice('--report='.length);
const reportPath = resolve(reportArg || 'evals/reports/model-qwen3-8b-2026-10-24T20-23-26-972Z-development.json');
const report = JSON.parse(await readFile(reportPath, 'utf8'));
if (report.run?.split !== split) throw new Error(`Report split ${report.run?.split} does not match requested ${split} split.`);

const { LANGFUSE_PUBLIC_KEY: publicKey, LANGFUSE_SECRET_KEY: secretKey, LANGFUSE_BASE_URL: baseUrl } = process.env;
if (!publicKey?.trim() || !secretKey?.trim() || !baseUrl?.trim()) {
  throw new Error('Configure Langfuse keys using the approved local/team secret store.');
}
const datasetName = `datascout/requirements-v0.1-${split === 'held_out' ? 'held-out' : 'development'}`;
const langfuse = new LangfuseClient({ publicKey: publicKey.trim(), secretKey: secretKey.trim(), baseUrl: baseUrl.trim() });
try {
  const dataset = await langfuse.dataset.get(datasetName);
  const predictions = new Map(report.cases.map((item) => [item.case_id, {
    result_kind: item.result_kind,
    fields: Object.fromEntries(Object.entries(item.fields).map(([field, values]) => [field, values.actual])),
  }]));
  const missing = dataset.items.filter((item) => !predictions.has(item.metadata?.case_id));
  if (dataset.items.length !== predictions.size || missing.length) {
    throw new Error('Langfuse dataset and local model report do not contain the same case IDs.');
  }
  const result = await dataset.runExperiment({
    name: `DataScout extraction ${report.run.model_id}`,
    runName: `${report.run.run_id}-results-import-v2`,
    description: 'Imports the recorded local model run for deterministic scoring against the versioned Langfuse dataset; this does not call the model again.',
    metadata: {
      split, model_id: report.run.model_id, prompt_version: report.run.prompt_version,
      schema_version: report.run.extraction_schema_version,
      evaluator_version: report.evaluator_version, corpus_sha256: report.run.corpus_sha256,
      safety_ruleset_version: report.run.safety_ruleset_version,
      safety_triage_prompt_version: report.run.safety_triage_prompt_version,
      local_report: reportPath, result_kind: 'existing_model_run_import',
    },
    maxConcurrency: 1,
    task: async ({ metadata }) => predictions.get(metadata?.case_id) ?? { result_kind: 'missing', fields: null },
    evaluators: [async ({ output, expectedOutput }) => {
      const expected = expectedOutput && typeof expectedOutput === 'object' ? expectedOutput : {};
      const actual = output && typeof output === 'object' && output.fields && typeof output.fields === 'object'
        ? output.fields : {};
      const fields = ['topic', 'geography', 'time_coverage', 'minimum_records', 'required_features', 'target', 'preferences', 'constraints'];
      const normalize = (field, value) => field === 'time_coverage' && typeof value === 'string'
        ? value.replace(/\b(?:from\s+|between\s+)?(\d{4})\s*(?:-|–|—|to|through|and)\s*(\d{4})\b/iu, '$1-$2')
        : value;
      const score = (field) => output?.result_kind !== 'refused' && output?.result_kind !== 'error' && output?.result_kind !== 'missing' &&
        JSON.stringify(normalize(field, actual[field] ?? null)) === JSON.stringify(normalize(field, expected[field] ?? null));
      return [
        { name: 'extraction_all_fields_exact', value: fields.every(score) ? 1 : 0, dataType: 'BOOLEAN' },
        ...fields.map((field) => ({ name: `extraction_${field}_exact`, value: score(field) ? 1 : 0, dataType: 'BOOLEAN' })),
      ];
    }],
  });
  console.log(JSON.stringify({ dataset: datasetName, split, modelReport: reportPath, result: await result.format() }));
} finally {
  await langfuse.shutdown();
}
