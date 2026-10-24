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
import { matchRequirement, matchRequirements } from '../src/index.js';

const fixtureSchema = z
  .object({
    description: z.string(),
    dataset: DatasetSchema,
    requirements: z.array(RequirementSchema),
    evidence: z.array(EvidenceSchema),
    expected_verdicts: z.array(RequirementMatchSchema),
  })
  .strict();

async function loadFixtures() {
  const raw: unknown = JSON.parse(
    await readFile(
      resolve(process.cwd(), '../../contracts/fixtures/datasets.json'),
      'utf8',
    ),
  );
  return z.array(fixtureSchema).parse(raw);
}

describe('P0-5 matching and verdicts', () => {
  it('matches every labeled fixture without producing a false PASS', async () => {
    const fixtures = await loadFixtures();

    expect(fixtures).toHaveLength(10);
    for (const fixture of fixtures) {
      const actual = matchRequirements(
        fixture.requirements,
        fixture.dataset,
        fixture.evidence,
      );
      expect(
        actual.map(
          ({ requirement_id, status, evidence_ids, verification_level }) => ({
            requirement_id,
            status,
            evidence_ids,
            verification_level,
          }),
        ),
      ).toEqual(
        fixture.expected_verdicts.map(
          ({ requirement_id, status, evidence_ids, verification_level }) => ({
            requirement_id,
            status,
            evidence_ids,
            verification_level,
          }),
        ),
      );
      expect(actual.every(({ reason }) => reason.trim().length > 0)).toBe(true);
      expect(
        actual.some((verdict, index) => {
          const expected = fixture.expected_verdicts[index];
          return verdict.status === 'PASS' && expected?.status !== 'PASS';
        }),
      ).toBe(false);
    }
  });

  it('does not infer a PASS from dataset fields without matching evidence', async () => {
    const fixture = (await loadFixtures()).find(({ dataset }) =>
      dataset.dataset_id.includes('diagnosis-table'),
    );
    if (!fixture) throw new Error('diagnosis fixture missing');

    const verdict = matchRequirement(
      fixture.requirements[0]!,
      fixture.dataset,
      [],
    );

    expect(verdict.status).toBe('UNKNOWN');
    expect(verdict.evidence_ids).toEqual([]);
  });

  it('ignores evidence belonging to another dataset', async () => {
    const fixture = (await loadFixtures()).find(({ dataset }) =>
      dataset.dataset_id.includes('diagnosis-table'),
    );
    if (!fixture) throw new Error('diagnosis fixture missing');

    const verdict = matchRequirement(
      fixture.requirements[0]!,
      fixture.dataset,
      [{ ...fixture.evidence[0]!, dataset_id: 'openml:other-dataset' }],
    );

    expect(verdict.status).toBe('UNKNOWN');
    expect(verdict.evidence_ids).toEqual([]);
  });

  it('keeps exact metadata-only matches PARTIAL, never PASS', async () => {
    const fixture = (await loadFixtures()).find(({ dataset }) =>
      dataset.dataset_id.includes('crop-yield-metadata'),
    );
    if (!fixture) throw new Error('metadata fixture missing');

    const metadataOnly = {
      ...fixture.dataset,
      columns: ['rainfall', 'temperature'],
    };
    const evidence = [
      {
        ...fixture.evidence[0]!,
        value: ['rainfall', 'temperature'],
      },
    ];
    const verdict = matchRequirement(
      fixture.requirements[0]!,
      metadataOnly,
      evidence,
    );

    expect(verdict.status).toBe('PARTIAL');
    expect(verdict.status).not.toBe('PASS');
  });

  it('does not treat missing metadata as proof of absence', async () => {
    const fixture = (await loadFixtures()).find(({ dataset }) =>
      dataset.dataset_id.includes('health-survey-unknown'),
    );
    if (!fixture) throw new Error('geography fixture missing');

    const evidence = [
      {
        evidence_id: 'unrelated-description',
        dataset_id: fixture.dataset.dataset_id,
        field: 'description',
        value: 'Nepal',
        provenance: {
          source_field_path: 'catalog.description',
          retrieved_at: fixture.dataset.retrieved_at,
        },
      },
    ];
    const verdict = matchRequirement(
      fixture.requirements[0]!,
      fixture.dataset,
      evidence,
    );

    expect(verdict.status).toBe('UNKNOWN');
    expect(verdict.evidence_ids).toEqual([]);
  });

  it('returns the same verdict for identical inputs', async () => {
    const fixture = (await loadFixtures())[0]!;
    const first = matchRequirement(
      fixture.requirements[0]!,
      fixture.dataset,
      fixture.evidence,
    );
    const second = matchRequirement(
      fixture.requirements[0]!,
      fixture.dataset,
      fixture.evidence,
    );

    expect(second).toEqual(first);
  });
});
