import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import {
  DatasetSchema,
  EvidenceSchema,
  RequirementMatchSchema,
  RequirementSchema,
} from '../../../contracts/src/index.js';
import type { ScoredDataset } from '../../../contracts/src/ports.js';
import {
  createScorer,
  rankScoredDatasets,
  scoreDataset,
} from '../src/index.js';

const fixtureSchema = z
  .object({
    description: z.string(),
    dataset: DatasetSchema,
    requirements: z.array(RequirementSchema),
    evidence: z.array(EvidenceSchema),
    expected_verdicts: z.array(RequirementMatchSchema),
  })
  .strict();

async function loadFixture() {
  const raw: unknown = JSON.parse(
    await readFile(
      resolve(process.cwd(), '../../contracts/fixtures/datasets.json'),
      'utf8',
    ),
  );
  const fixtures = z.array(fixtureSchema).parse(raw);
  const fixture = fixtures.find(({ requirements }) => requirements.length > 0);
  if (!fixture) throw new Error('scoring fixture missing requirements');
  return fixture;
}

function withScore(
  item: ScoredDataset,
  datasetId: string,
  total: number,
  evidenceCoverage: number,
): ScoredDataset {
  return {
    ...item,
    dataset: { ...item.dataset, dataset_id: datasetId },
    score: {
      ...item.score,
      total,
      evidence_coverage: evidenceCoverage,
    },
  };
}

describe('score-v1', () => {
  it('returns deterministic component points and evidence coverage', async () => {
    const fixture = await loadFixture();
    const scorer = createScorer();
    const first = scorer.evaluate({
      requirements: fixture.requirements,
      dataset: fixture.dataset,
      inspection: {
        datasetId: fixture.dataset.dataset_id,
        status: 'ok',
        verificationLevel: 'sample_checked',
        rowsExamined: 20,
        columns: [
          { name: 'x', inferredType: 'number', missingRate: 0.01 },
          { name: 'y', inferredType: 'string', missingRate: 0.03 },
        ],
        dateRange: null,
        duplicateRate: 0.01,
        evidence: fixture.evidence,
      },
    });
    const second = scorer.evaluate({
      requirements: fixture.requirements,
      dataset: fixture.dataset,
      inspection: {
        datasetId: fixture.dataset.dataset_id,
        status: 'ok',
        verificationLevel: 'sample_checked',
        rowsExamined: 20,
        columns: [
          { name: 'x', inferredType: 'number', missingRate: 0.01 },
          { name: 'y', inferredType: 'string', missingRate: 0.03 },
        ],
        dateRange: null,
        duplicateRate: 0.01,
        evidence: fixture.evidence,
      },
    });

    expect(second).toEqual(first);
    expect(first.score.scoring_version).toBe('score-v1');
    expect(first.score.components.map(({ weight }) => weight)).toEqual([
      50, 20, 15, 10, 5,
    ]);
    expect(first.score.total).toBeCloseTo(
      first.score.components.reduce(
        (sum, component) => sum + component.points,
        0,
      ),
      2,
    );
    expect(first.score.evidence_coverage).toBeGreaterThanOrEqual(0);
    expect(first.score.evidence_coverage).toBeLessThanOrEqual(1);
  });

  it('is monotonic when a requirement verdict improves', async () => {
    const fixture = await loadFixture();
    const evidence = fixture.evidence;
    const evidenceId = evidence[0]?.evidence_id;
    if (!evidenceId) throw new Error('scoring fixture has no evidence');
    const requirement = fixture.requirements[0]!;
    const baseMatch = {
      requirement_id: requirement.requirement_id,
      reason: 'test verdict',
      verification_level: fixture.dataset.verification_level,
      measured_value: undefined,
    };
    const unknown = {
      ...baseMatch,
      status: 'UNKNOWN' as const,
      evidence_ids: [],
    };
    const partial = {
      ...baseMatch,
      status: 'PARTIAL' as const,
      evidence_ids: [evidenceId],
    };
    const pass = {
      ...baseMatch,
      status: 'PASS' as const,
      evidence_ids: [evidenceId],
    };
    const score = (match: typeof unknown | typeof partial | typeof pass) =>
      scoreDataset({
        requirements: [requirement],
        matches: [match],
        dataset: fixture.dataset,
        evidence,
      });

    const unknownScore = score(unknown);
    const partialScore = score(partial);
    const passScore = score(pass);
    expect(unknownScore.components[0]?.points).toBeLessThan(
      partialScore.components[0]?.points ?? 0,
    );
    expect(partialScore.components[0]?.points).toBeLessThan(
      passScore.components[0]?.points ?? 0,
    );
    expect(unknownScore.evidence_coverage).toBe(0);
    expect(partialScore.evidence_coverage).toBe(1);
    expect(passScore.evidence_coverage).toBe(1);
    expect(unknownScore.total).toBeLessThan(partialScore.total);
    expect(partialScore.total).toBeLessThan(passScore.total);
  });

  it('weights required requirements at 3, preferences at 1, and counts preferences in coverage', async () => {
    const fixture = await loadFixture();
    const evidenceItem = fixture.evidence[0];
    if (!evidenceItem) throw new Error('scoring fixture has no evidence');
    const required = {
      ...fixture.requirements[0]!,
      requirement_id: 'required-topic',
      type: 'topic' as const,
      priority: 'required' as const,
    };
    const preference = {
      ...fixture.requirements[0]!,
      requirement_id: 'preferred-topic',
      type: 'preference' as const,
      priority: 'preferred' as const,
    };
    const score = scoreDataset({
      requirements: [required, preference],
      matches: [
        {
          requirement_id: required.requirement_id,
          status: 'PASS',
          reason: 'verified',
          evidence_ids: [evidenceItem.evidence_id],
          verification_level: fixture.dataset.verification_level,
        },
        {
          requirement_id: preference.requirement_id,
          status: 'UNKNOWN',
          reason: 'not verified',
          evidence_ids: [],
          verification_level: fixture.dataset.verification_level,
        },
      ],
      dataset: fixture.dataset,
      evidence: [evidenceItem],
    });

    expect(score.components[0]?.points).toBe(37.5);
    expect(score.evidence_coverage).toBe(0.5);
  });

  it('awards successful sample quality points at the stated thresholds', async () => {
    const fixture = await loadFixture();
    const dataset = {
      ...fixture.dataset,
      access_type: 'open',
      file_formats: ['csv'],
    };
    const inspection = {
      datasetId: dataset.dataset_id,
      status: 'ok' as const,
      verificationLevel: 'sample_checked' as const,
      rowsExamined: 1,
      columns: Array.from({ length: 10 }, (_, index) => ({
        name: `column_${index}`,
        inferredType: index < 9 ? 'number' : '',
        missingRate: 0.05,
      })),
      dateRange: null,
      duplicateRate: 0.01,
      evidence: fixture.evidence,
    };
    const score = scoreDataset({
      requirements: fixture.requirements,
      matches: fixture.expected_verdicts,
      dataset,
      evidence: fixture.evidence,
      inspection,
    });

    expect(score.components[1]?.points).toBe(20);
  });

  it('rejects PASS/PARTIAL coverage unsupported by cited same-dataset evidence', async () => {
    const fixture = await loadFixture();
    const requirement = fixture.requirements[0]!;
    const score = scoreDataset({
      requirements: [requirement],
      matches: [
        {
          requirement_id: requirement.requirement_id,
          status: 'PASS',
          reason: 'uncited',
          evidence_ids: ['missing-evidence'],
          verification_level: fixture.dataset.verification_level,
        },
      ],
      dataset: fixture.dataset,
      evidence: fixture.evidence,
    });
    expect(score.evidence_coverage).toBe(0);
  });

  it('ranks shuffled input identically using total, coverage, then ASCII ID', async () => {
    const fixture = await loadFixture();
    const item = createScorer().evaluate({
      requirements: fixture.requirements,
      dataset: fixture.dataset,
    });
    const inputs = [
      withScore(item, 'source:z', 80, 0.5),
      withScore(item, 'source:a', 80, 0.5),
      withScore(item, 'source:B', 80, 0.5),
      withScore(item, 'source:coverage', 80, 0.6),
      withScore(item, 'source:score', 80.01, 0),
    ];

    const ordered = (values: ScoredDataset[]) =>
      rankScoredDatasets(values).map(({ rank, item: ranked }) => ({
        rank,
        id: ranked.dataset.dataset_id,
      }));

    const expected = [
      { rank: 1, id: 'source:score' },
      { rank: 2, id: 'source:coverage' },
      { rank: 3, id: 'source:B' },
      { rank: 4, id: 'source:a' },
      { rank: 5, id: 'source:z' },
    ];
    expect(ordered(inputs)).toEqual(expected);
    expect(ordered([...inputs].reverse())).toEqual(expected);
  });

  it('rejects duplicate dataset IDs before assigning ranks', async () => {
    const fixture = await loadFixture();
    const item = createScorer().evaluate({
      requirements: fixture.requirements,
      dataset: fixture.dataset,
    });
    expect(() =>
      rankScoredDatasets([
        item,
        { ...item, score: { ...item.score, total: item.score.total } },
      ]),
    ).toThrow(/unique dataset IDs/u);
  });
});
