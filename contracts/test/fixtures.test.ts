import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  CLARIFICATION_QUESTION_TEMPLATES,
  CompareResponseSchema,
  CONTRACT_VERSION,
  createClarification,
  createRefusal,
  DatasetSchema,
  DatasetDetailSchema,
  ERROR_HTTP_STATUS,
  ERROR_RETRYABLE,
  ErrorCodeSchema,
  ErrorObjectSchema,
  EvidenceSchema,
  GENERIC_REFUSAL_MESSAGE,
  RequirementMatchSchema,
  RequirementSchema,
  SCHEMA_VERSION,
  SearchResponseSchema,
} from '../src/index.js';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const contractsDirectory = resolve(testDirectory, '..');
const fixturesDirectory = resolve(contractsDirectory, 'fixtures');

const DatasetFixtureSchema = z
  .object({
    description: z.string().min(1),
    dataset: DatasetSchema,
    requirements: z.array(RequirementSchema).min(1),
    evidence: z.array(EvidenceSchema),
    expected_verdicts: z.array(RequirementMatchSchema).min(1),
  })
  .strict();

function collectExamples(
  value: unknown,
  found: { name: string; externalValue: string }[] = [],
): { name: string; externalValue: string }[] {
  if (Array.isArray(value)) {
    for (const item of value) collectExamples(item, found);
    return found;
  }
  if (typeof value !== 'object' || value === null) return found;

  const record = value as Record<string, unknown>;
  const examples = record['examples'];
  if (typeof examples === 'object' && examples !== null) {
    for (const [name, example] of Object.entries(examples)) {
      if (typeof example !== 'object' || example === null) continue;
      const externalValue = (example as Record<string, unknown>)[
        'externalValue'
      ];
      if (typeof externalValue === 'string') {
        found.push({ name, externalValue });
      }
    }
  }

  for (const child of Object.values(record)) collectExamples(child, found);
  return found;
}

describe('P0-5 contract fixtures', () => {
  it('validates ten synthetic datasets and their labeled expected verdicts', async () => {
    const raw: unknown = JSON.parse(
      await readFile(resolve(fixturesDirectory, 'datasets.json'), 'utf8'),
    );
    const fixtures = z.array(DatasetFixtureSchema).parse(raw);

    expect(fixtures).toHaveLength(10);
    expect(
      new Set(fixtures.map(({ dataset }) => dataset.dataset_id)).size,
    ).toBe(10);
    expect(
      new Set(
        fixtures.flatMap(({ expected_verdicts }) =>
          expected_verdicts.map(({ status }) => status),
        ),
      ),
    ).toEqual(new Set(['PASS', 'PARTIAL', 'FAIL', 'UNKNOWN']));
    expect(
      new Set(fixtures.map(({ dataset }) => dataset.verification_level)),
    ).toEqual(new Set(['metadata_only', 'sample_checked']));

    for (const fixture of fixtures) {
      const requirementIds = new Set(
        fixture.requirements.map(({ requirement_id }) => requirement_id),
      );
      const evidenceIds = new Set(
        fixture.evidence.map(({ evidence_id }) => evidence_id),
      );
      expect(
        fixture.evidence.every(
          ({ dataset_id }) => dataset_id === fixture.dataset.dataset_id,
        ),
      ).toBe(true);

      for (const verdict of fixture.expected_verdicts) {
        expect(requirementIds.has(verdict.requirement_id)).toBe(true);
        expect(
          verdict.evidence_ids.every((evidenceId) =>
            evidenceIds.has(evidenceId),
          ),
        ).toBe(true);
        expect(verdict.verification_level).toBe(
          fixture.dataset.verification_level,
        );
      }
    }
  });

  it('does not reference held-out evaluation cases in any fixture', async () => {
    const fixtureNames = [
      'datasets.json',
      'search-results.json',
      'search-partial.json',
      'search-no-match.json',
      'search-clarification.json',
      'search-refused.json',
      'dataset-detail.json',
      'compare-synthetic.json',
      ...ErrorCodeSchema.options.map((code) => `errors/error-${code}.json`),
    ];
    const fixtureText = (
      await Promise.all(
        fixtureNames.map((name) =>
          readFile(resolve(fixturesDirectory, name), 'utf8'),
        ),
      )
    ).join('\n');
    const corpus = (
      await readFile(
        resolve(contractsDirectory, '..', 'evals', 'requirements-v0.1.jsonl'),
        'utf8',
      )
    )
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    for (const heldOutCase of corpus.filter(
      (item) => item['split'] === 'held_out',
    )) {
      for (const field of ['case_id', 'input']) {
        const value = heldOutCase[field];
        if (typeof value === 'string') {
          expect(fixtureText).not.toContain(value);
        }
      }
      expect(fixtureText).not.toContain(
        JSON.stringify(heldOutCase['expected']),
      );
    }
  });

  it('validates search response examples and enforces the selected outcome', async () => {
    const names = [
      'search-results',
      'search-partial',
      'search-no-match',
      'search-clarification',
      'search-refused',
    ] as const;
    const responses = new Map<string, Record<string, unknown>>();

    for (const name of names) {
      const response: unknown = JSON.parse(
        await readFile(resolve(fixturesDirectory, `${name}.json`), 'utf8'),
      );
      responses.set(name, SearchResponseSchema.parse(response));
    }

    expect(responses.get('search-results')?.['outcome']).toBe('results');
    expect(responses.get('search-partial')?.['outcome']).toBe('results');
    expect(responses.get('search-no-match')).toMatchObject({
      outcome: 'results',
      results: [],
      warnings: expect.arrayContaining([expect.any(String)]),
    });
    expect(responses.get('search-clarification')).toMatchObject({
      outcome: 'clarification_needed',
      clarification: createClarification('too_vague'),
    });
    expect(responses.get('search-refused')).toMatchObject({
      outcome: 'refused',
      refusal: createRefusal('unsafe_request'),
    });

    const clarification = structuredClone(
      responses.get('search-clarification'),
    );
    expect(clarification).toBeDefined();
    if (!clarification)
      throw new Error('Clarification fixture was not loaded.');
    clarification['requirements'] = {
      ...(clarification['requirements'] as Record<string, unknown>),
      topic: 'unexpected topic',
    };
    expect(SearchResponseSchema.safeParse(clarification).success).toBe(false);

    const refusal = structuredClone(responses.get('search-refused'));
    expect(refusal).toBeDefined();
    if (!refusal) throw new Error('Refusal fixture was not loaded.');
    refusal['requirements'] = {
      topic: null,
      geography: null,
      time_coverage: null,
      minimum_records: null,
      required_features: [],
      target: null,
      preferences: [],
      constraints: [],
    };
    expect(SearchResponseSchema.safeParse(refusal).success).toBe(false);
  });

  it('validates the dataset-detail and compare endpoint fixtures', async () => {
    const detail: unknown = JSON.parse(
      await readFile(resolve(fixturesDirectory, 'dataset-detail.json'), 'utf8'),
    );
    const compare: unknown = JSON.parse(
      await readFile(
        resolve(fixturesDirectory, 'compare-synthetic.json'),
        'utf8',
      ),
    );

    expect(DatasetDetailSchema.parse(detail).dataset.dataset_id).toBe(
      'datagovin:fixture-crop-yield',
    );
    expect(
      CompareResponseSchema.parse(compare).datasets.map(
        ({ dataset }) => dataset.dataset_id,
      ),
    ).toEqual([
      'datagovin:fixture-rainfall-monthly',
      'openml:datascout-fixtures/diagnosis-table',
    ]);
  });

  it('validates every error fixture against the canonical code/status/retryability catalog', async () => {
    const codes = ErrorCodeSchema.options;
    expect(Object.keys(ERROR_HTTP_STATUS).sort()).toEqual([...codes].sort());
    expect(Object.keys(ERROR_RETRYABLE).sort()).toEqual([...codes].sort());

    const fixtureCodes = new Set<string>();
    for (const code of codes) {
      const error: unknown = JSON.parse(
        await readFile(
          resolve(fixturesDirectory, 'errors', `error-${code}.json`),
          'utf8',
        ),
      );
      const parsed = ErrorObjectSchema.parse(error);
      fixtureCodes.add(parsed.code);
      expect(parsed.request_id).toBeTruthy();
      expect(parsed.retryable).toBe(ERROR_RETRYABLE[code]);
      expect(parsed).toMatchObject({
        contract_version: CONTRACT_VERSION,
        schema_version: SCHEMA_VERSION,
      });
    }

    expect(fixtureCodes).toEqual(new Set(codes));
    expect(ERROR_HTTP_STATUS).toEqual({
      invalid_request: 400,
      unauthorized: 401,
      forbidden: 403,
      not_found: 404,
      payload_too_large: 413,
      rate_limited: 429,
      internal_error: 500,
      extraction_failed: 502,
      upstream_unavailable: 503,
      timeout: 504,
    });
  });

  it('uses fixed clarification/refusal copy and exposes named OpenAPI examples', async () => {
    expect(createClarification('missing_topic').question).toBe(
      CLARIFICATION_QUESTION_TEMPLATES.missing_topic,
    );
    expect(createClarification('too_vague').question).toBe(
      CLARIFICATION_QUESTION_TEMPLATES.too_vague,
    );
    expect(createRefusal('unsafe_request').message).toBe(
      GENERIC_REFUSAL_MESSAGE,
    );
    expect(createRefusal('out_of_scope').message).toBe(GENERIC_REFUSAL_MESSAGE);

    const openapi: unknown = parseYaml(
      await readFile(resolve(contractsDirectory, 'openapi.yaml'), 'utf8'),
    );
    const examples = collectExamples(openapi);
    const expectedNames = [
      'search-results',
      'search-partial',
      'search-no-match',
      'search-clarification',
      'search-refused',
      'dataset-detail',
      'compare-synthetic',
      ...ErrorCodeSchema.options.map((code) => `error-${code}`),
    ];
    const externalValues = new Map<string, string>();
    for (const name of expectedNames) {
      externalValues.set(
        name,
        name.startsWith('error-')
          ? `./fixtures/errors/${name}.json`
          : `./fixtures/${name}.json`,
      );
    }

    expect([...new Set(examples.map(({ name }) => name))].sort()).toEqual(
      [...expectedNames].sort(),
    );
    for (const { name, externalValue } of examples) {
      expect(externalValue).toBe(externalValues.get(name));
      await expect(
        readFile(resolve(contractsDirectory, externalValue), 'utf8'),
      ).resolves.toBeTruthy();
    }
  });
});
