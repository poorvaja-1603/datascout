import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { DatasetSchema, EvidenceSchema, RequirementMatchSchema, RequirementSchema } from '../contracts/src/index.js';
import { matchRequirements } from '../packages/verify/src/index.js';

const root = process.cwd();
let fixtureFile = resolve(root, 'evals/verdict-fixtures.json');
try {
  await readFile(fixtureFile, 'utf8');
} catch {
  fixtureFile = resolve(root, 'contracts/fixtures/datasets.json');
}
const source = await readFile(fixtureFile, 'utf8');
const fixtureSchema = z.array(z.object({
  dataset: DatasetSchema,
  requirements: z.array(RequirementSchema),
  evidence: z.array(EvidenceSchema),
  expected_verdicts: z.array(RequirementMatchSchema),
}).passthrough());
const fixtures = fixtureSchema.parse(JSON.parse(source));
const comparisons = fixtures.flatMap((fixture) => {
  const actual = matchRequirements(fixture.requirements, fixture.dataset, fixture.evidence);
  return actual.map((verdict, index) => ({
    dataset_id: fixture.dataset.dataset_id,
    requirement_id: verdict.requirement_id,
    expected: fixture.expected_verdicts[index]?.status,
    actual: verdict.status,
    false_pass: verdict.status === 'PASS' && fixture.expected_verdicts[index]?.status !== 'PASS',
  }));
});
const falsePasses = comparisons.filter(({ false_pass }) => false_pass).length;
const report = {
  report_schema: 'verdict-evaluation-v1',
  evaluator_version: 'match-fixture-evaluator-v1',
  quality_claim: 'labeled_synthetic_fixture_only',
  started_at: new Date().toISOString(),
  fixture_sha256: createHash('sha256').update(source).digest('hex'),
  metrics: {
    verdicts: comparisons.length,
    exact_match_rate: comparisons.length ? comparisons.filter(({ expected, actual }) => expected === actual).length / comparisons.length : null,
    false_pass_count: falsePasses,
    false_pass_rate: comparisons.length ? falsePasses / comparisons.length : null,
  },
  cases: comparisons,
};
const reportPath = resolve(root, `evals/reports/verdict-${new Date().toISOString().replace(/[:.]/gu, '-')}.json`);
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ ...report.metrics, report: reportPath }, null, 2));
if (falsePasses > 0) process.exitCode = 1;
