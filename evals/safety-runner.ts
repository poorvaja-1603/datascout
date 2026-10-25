import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  inspectSearchInput,
  quarantineSourceText,
  SAFETY_RULESET_VERSION,
  SAFETY_TRIAGE_PROMPT_VERSION,
} from '../packages/ai/src/safety.js';

type Case = { id: string; kind: 'input' | 'source'; label: string; text: string; suite?: string };
const root = process.cwd();
const source = [
  await readFile(resolve(root, 'evals/safety-cases.jsonl'), 'utf8'),
  await readFile(resolve(root, 'evals/safety-injection-cases.jsonl'), 'utf8'),
  await readFile(resolve(root, 'evals/safety-source-cases.jsonl'), 'utf8'),
].join('\n');
const cases = source.trim().split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as Case);
const results = cases.map((item) => {
  const decision = item.kind === 'input' ? inspectSearchInput(item.text) : undefined;
  const result = item.kind === 'input'
    ? decision!.invalidInput ? 'invalid' : decision!.refusal ? 'block' : 'allow'
    : quarantineSourceText(item.text).includes('omitted') ? 'quarantine' : 'preserve';
  return {
    id: item.id, kind: item.kind, suite: item.suite, expected: item.label, actual: result,
    layers: item.kind === 'source' ? ['L7'] : decision!.layers,
    pass: item.label === result,
  };
});
const inputCases = results.filter(({ kind }) => kind === 'input');
const blocked = inputCases.filter(({ expected }) => expected === 'block');
const allowed = inputCases.filter(({ expected }) => expected === 'allow');
const report = {
  report_schema: 'safety-evaluation-v2',
  evaluator_version: 'safety-fixture-evaluator-v2',
  safety_ruleset_version: SAFETY_RULESET_VERSION,
  safety_triage_prompt_version: SAFETY_TRIAGE_PROMPT_VERSION,
  quality_claim: 'deterministic_rule_fixture_only',
  started_at: new Date().toISOString(),
  corpus_sha256: createHash('sha256').update(source).digest('hex'),
  metrics: {
    cases: results.length,
    direct_injection_cases: results.filter(({ suite }) => suite === 'direct_injection').length,
    direct_injection_catch_rate: results.filter(({ suite, expected, pass }) => suite === 'direct_injection' && expected === 'block' && pass).length /
      Math.max(1, results.filter(({ suite }) => suite === 'direct_injection').length),
    exact_match_rate: results.filter(({ pass }) => pass).length / results.length,
    block_catch_rate: blocked.length ? blocked.filter(({ pass }) => pass).length / blocked.length : null,
    false_positive_rate: allowed.length ? allowed.filter(({ pass }) => !pass).length / allowed.length : null,
    per_layer_catch_rate: {
      L0: inputCases.filter(({ expected }) => expected === 'invalid').length
        ? results.filter(({ kind, expected, actual, layers }) => kind === 'input' && expected === 'invalid' && actual === 'invalid' && layers.includes('L0')).length /
          inputCases.filter(({ expected }) => expected === 'invalid').length
        : null,
      L1: blocked.length ? results.filter(({ kind, expected, actual, layers }) => kind === 'input' && expected === 'block' && actual === 'block' && layers.includes('L1')).length / blocked.length : null,
      L7: results.filter(({ kind, expected }) => kind === 'source' && expected === 'quarantine').length
        ? results.filter(({ kind, expected, actual }) => kind === 'source' && expected === 'quarantine' && actual === 'quarantine').length /
          results.filter(({ kind, expected }) => kind === 'source' && expected === 'quarantine').length
        : null,
      L2: 'not_evaluated_remote_model_triage',
      L8: 'unit_tested_canary_detection',
      L9: 'unit_tested_egress_redaction',
    },
    source_quarantine_rate: results.filter(({ kind, expected, pass }) => kind === 'source' && expected === 'quarantine' && pass).length /
      Math.max(1, results.filter(({ kind, expected }) => kind === 'source' && expected === 'quarantine').length),
  },
  cases: results,
};
const reportPath = resolve(root, `evals/reports/safety-${new Date().toISOString().replace(/[:.]/gu, '-')}.json`);
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ ...report.metrics, report: reportPath }, null, 2));
if (results.some(({ pass }) => !pass)) process.exitCode = 1;
