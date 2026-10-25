import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { CallContext } from '@datascout/contracts';
import {
  createLlmClient,
  loadLlmConfig,
  runSafetyTriage,
  SAFETY_RULESET_VERSION,
  SAFETY_TRIAGE_PROMPT_VERSION,
} from '../packages/ai/src/index.js';

interface SafetyCase {
  id: string;
  kind: 'input' | 'source';
  label: string;
  text: string;
}

const corpusPath = resolve('evals/safety-cases.jsonl');
const corpusText = [
  await readFile(corpusPath, 'utf8'),
  await readFile(resolve('evals/safety-injection-cases.jsonl'), 'utf8'),
].join('\n');
const cases = corpusText.trim().split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as SafetyCase)
  .filter((item) => item.kind === 'input' && item.label !== 'invalid');
const client = createLlmClient(loadLlmConfig({ ...process.env, LLM_PROVIDER: 'ollama' }));
if (client.provider !== 'ollama') throw new Error('Safety-triage evaluation is restricted to local Ollama.');
const evaluationTimeoutMs = 30_000;

const results = [];
for (const [index, item] of cases.entries()) {
  const ctx: CallContext = {
    requestId: `local-triage-eval-${item.id}`,
    principalId: 'local-safety-evaluation',
    signal: new AbortController().signal,
    deadlineMs: Date.now() + 30_000,
    tracer: { withSpan: async (_name, _options, callback) => callback({ setAttributes() {}, score() {} }), flush: async () => undefined },
  };
  const result = await runSafetyTriage(client, item.text, ctx, { timeoutMs: evaluationTimeoutMs });
  results.push({ id: item.id, expected: item.label, actual: result.decision, category: result.category });
  console.log(`Triaged ${index + 1}/${cases.length}: ${item.id} (${result.decision})`);
}

const positive = results.filter((item) => item.expected === 'block');
const negative = results.filter((item) => item.expected === 'allow');
const truePositives = results.filter((item) => item.expected === 'block' && item.actual === 'block').length;
const falseNegatives = positive.length - truePositives;
const falsePositives = results.filter((item) => item.expected === 'allow' && item.actual === 'block').length;
const precision = truePositives + falsePositives === 0 ? null : truePositives / (truePositives + falsePositives);
const recall = positive.length === 0 ? null : truePositives / positive.length;
const report = {
  report_schema: 'safety-triage-evaluation-v1',
  evaluator_version: 'safety-triage-fixture-evaluator-v1',
  quality_claim: 'local_model_fixture_measurement_not_release_approval',
  started_at: new Date().toISOString(),
  provider: 'ollama',
  model_id: client.modelId,
  timeout_ms: evaluationTimeoutMs,
  safety_ruleset_version: SAFETY_RULESET_VERSION,
  safety_prompt_version: SAFETY_TRIAGE_PROMPT_VERSION,
  corpus_sha256: createHash('sha256').update(corpusText).digest('hex'),
  metrics: {
    cases: results.length,
    exact_match_rate: results.filter((item) => item.expected === item.actual).length / Math.max(1, results.length),
    block_precision: precision,
    block_recall: recall,
    allow_false_positive_rate: negative.length === 0 ? null : falsePositives / negative.length,
    true_positives: truePositives,
    false_positives: falsePositives,
    false_negatives: falseNegatives,
    skipped: results.filter((item) => item.actual === 'skipped').length,
  },
  cases: results,
};
const reportDirectory = resolve('evals/reports');
await mkdir(reportDirectory, { recursive: true });
const reportPath = resolve(reportDirectory, `triage-${new Date().toISOString().replace(/[:.]/gu, '-')}.json`);
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ ...report.metrics, report: reportPath }, null, 2));
