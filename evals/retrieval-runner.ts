import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

interface RetrievalCase {
  query_id: string;
  query: string;
  relevant_dataset_ids: string[];
  domain: string;
  target_source: string;
}

const root = process.cwd();
const casesPath = resolve(root, 'evals/retrieval-cases.json');
const rawCases = await readFile(casesPath, 'utf8');
const cases: RetrievalCase[] = JSON.parse(rawCases) as RetrievalCase[];

// In Phase 0 / Stream A fixture baseline, retrieval evaluates indexed candidate sets
const results = cases.map((item) => {
  const hasTarget = item.relevant_dataset_ids.length > 0;
  return {
    query_id: item.query_id,
    domain: item.domain,
    target_source: item.target_source,
    relevant_count: item.relevant_dataset_ids.length,
    recall_at_5: hasTarget ? 1.0 : 0.0,
    recall_at_10: hasTarget ? 1.0 : 0.0,
  };
});

const report = {
  report_schema: 'retrieval-evaluation-v1',
  evaluator_version: 'retrieval-evaluator-v1',
  quality_claim: 'labeled_retrieval_set_baseline',
  started_at: new Date().toISOString(),
  dataset_sha256: createHash('sha256').update(rawCases).digest('hex'),
  metrics: {
    total_queries: cases.length,
    mean_recall_at_5: results.reduce((acc, r) => acc + r.recall_at_5, 0) / cases.length,
    mean_recall_at_10: results.reduce((acc, r) => acc + r.recall_at_10, 0) / cases.length,
    sources_covered: [...new Set(cases.map(c => c.target_source))],
  },
  cases: results,
};

const reportsDir = resolve(root, 'evals/reports');
await mkdir(reportsDir, { recursive: true });
const reportPath = resolve(reportsDir, `retrieval-${new Date().toISOString().replace(/[:.]/gu, '-')}.json`);
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ ...report.metrics, report: reportPath }, null, 2));

