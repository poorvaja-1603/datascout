import { describe, expect, it } from 'vitest';
import * as publicContractPackage from '@datascout/contracts';
import {
  CompareRequestSchema,
  ContractVersionsSchema,
  DatasetSchema,
  EXTRACTION_FIELD_MAX_LENGTH,
  EXTRACTION_LIST_ITEM_MAX_LENGTH,
  EXTRACTION_LIST_MAX_ITEMS,
  ExtractedRequirementsSchema,
  MINIMUM_RECORDS_MAX_VALUE,
  MINIMUM_RECORDS_MIN_VALUE,
  RequirementSchema,
  SEARCH_QUERY_MAX_LENGTH,
  SearchRequestSchema,
  SourceSpanSchema,
} from '../src/schemas.js';
import { toJsonSchemas } from '../src/json-schema.js';

describe('ExtractedRequirementsSchema', () => {
  it('exports schemas and inferred types through the workspace package entrypoint', () => {
    expect(publicContractPackage.ExtractedRequirementsSchema).toBe(
      ExtractedRequirementsSchema,
    );
    expect(publicContractPackage.jsonSchemas.ExtractedRequirements).toBe(
      ExtractedRequirementsSchema,
    );
  });

  it('accepts the exact reviewed corpus shape, including unknown values', () => {
    const result = ExtractedRequirementsSchema.safeParse({
      topic: null,
      geography: null,
      time_coverage: null,
      minimum_records: null,
      required_features: [],
      target: null,
      preferences: [],
      constraints: [],
    });

    expect(result.success).toBe(true);
  });

  it('rejects additional properties, wrong types, and negative record counts', () => {
    const base = {
      topic: 'rainfall',
      geography: null,
      time_coverage: null,
      minimum_records: null,
      required_features: [],
      target: null,
      preferences: [],
      constraints: [],
    };

    expect(
      ExtractedRequirementsSchema.safeParse({ ...base, unexpected: true })
        .success,
    ).toBe(false);
    expect(
      ExtractedRequirementsSchema.safeParse({ ...base, minimum_records: -1 })
        .success,
    ).toBe(false);
    expect(
      ExtractedRequirementsSchema.safeParse({ ...base, required_features: [1] })
        .success,
    ).toBe(false);
  });

  it('applies the published trimmed scalar, list, and record-count caps', () => {
    const base = {
      topic: 'rainfall',
      geography: null,
      time_coverage: null,
      minimum_records: null,
      required_features: [],
      target: null,
      preferences: [],
      constraints: [],
    };
    const capLengthTopic = ` ${'x'.repeat(EXTRACTION_FIELD_MAX_LENGTH)} `;
    const tooLongTopic = 'x'.repeat(EXTRACTION_FIELD_MAX_LENGTH + 1);
    const maxItem = 'x'.repeat(EXTRACTION_LIST_ITEM_MAX_LENGTH);

    const trimmedScalar = ExtractedRequirementsSchema.safeParse({
      ...base,
      topic: capLengthTopic,
    });
    expect(trimmedScalar.success).toBe(true);
    if (trimmedScalar.success) {
      expect(trimmedScalar.data.topic).toBe(
        'x'.repeat(EXTRACTION_FIELD_MAX_LENGTH),
      );
    }
    expect(
      ExtractedRequirementsSchema.safeParse({ ...base, topic: tooLongTopic })
        .success,
    ).toBe(false);
    const trimmedListItem = ExtractedRequirementsSchema.safeParse({
      ...base,
      required_features: [` ${maxItem} `],
    });
    expect(trimmedListItem.success).toBe(true);
    if (trimmedListItem.success) {
      expect(trimmedListItem.data.required_features).toEqual([maxItem]);
    }
    expect(
      ExtractedRequirementsSchema.safeParse({
        ...base,
        required_features: [`${maxItem}x`],
      }).success,
    ).toBe(false);
    expect(
      ExtractedRequirementsSchema.safeParse({
        ...base,
        preferences: Array.from(
          { length: EXTRACTION_LIST_MAX_ITEMS },
          () => 'valid',
        ),
      }).success,
    ).toBe(true);
    expect(
      ExtractedRequirementsSchema.safeParse({
        ...base,
        preferences: Array.from(
          { length: EXTRACTION_LIST_MAX_ITEMS + 1 },
          () => 'valid',
        ),
      }).success,
    ).toBe(false);
    expect(
      ExtractedRequirementsSchema.safeParse({ ...base, constraints: ['   '] })
        .success,
    ).toBe(false);
    expect(
      ExtractedRequirementsSchema.safeParse({
        ...base,
        minimum_records: MINIMUM_RECORDS_MIN_VALUE,
      }).success,
    ).toBe(true);
    expect(
      ExtractedRequirementsSchema.safeParse({
        ...base,
        minimum_records: MINIMUM_RECORDS_MAX_VALUE,
      }).success,
    ).toBe(true);
    expect(
      ExtractedRequirementsSchema.safeParse({
        ...base,
        minimum_records: MINIMUM_RECORDS_MIN_VALUE - 1,
      }).success,
    ).toBe(false);
    expect(
      ExtractedRequirementsSchema.safeParse({
        ...base,
        minimum_records: MINIMUM_RECORDS_MAX_VALUE + 1,
      }).success,
    ).toBe(false);
    expect(
      ExtractedRequirementsSchema.safeParse({ ...base, minimum_records: 1.5 })
        .success,
    ).toBe(false);
  });
});

describe('RequirementSchema', () => {
  it('validates source-span offsets against the exact source text', () => {
    const validSpan = SourceSpanSchema.safeParse({
      start: 7,
      end: 15,
      text: 'rainfall',
    });
    const invalidSpan = SourceSpanSchema.safeParse({
      start: 7,
      end: 15,
      text: 'rain',
    });

    expect(validSpan.success).toBe(true);
    expect(invalidSpan.success).toBe(false);
    expect(
      RequirementSchema.safeParse({
        requirement_id: 'req-1',
        type: 'feature',
        value: 'rainfall',
        unit: null,
        priority: 'required',
        aliases: ['precipitation'],
        source_span: { start: 7, end: 15, text: 'rainfall' },
      }).success,
    ).toBe(true);
  });
});

describe('DatasetSchema', () => {
  it('accepts unknown metadata only when represented explicitly as null or empty', () => {
    const result = DatasetSchema.safeParse({
      dataset_id: 'huggingface:owner/dataset',
      source: 'huggingface',
      source_url: 'https://huggingface.co/datasets/owner/dataset',
      title: 'Sample dataset',
      description: null,
      license: null,
      access_type: null,
      api_endpoint: null,
      file_formats: [],
      record_count: null,
      columns: [],
      geography: null,
      time_coverage: null,
      tags: [],
      last_updated: null,
      retrieved_at: '2026-10-24T10:00:00Z',
      raw_snapshot_key: null,
      verification_level: 'metadata_only',
      provenance: {
        title: {
          source_field_path: 'card.title',
          retrieved_at: '2026-10-24T10:00:00Z',
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it('rejects malformed IDs, invalid timestamps, and extra fields', () => {
    const validDataset = {
      dataset_id: 'openml:61',
      source: 'openml',
      source_url: null,
      title: null,
      description: null,
      license: null,
      access_type: null,
      api_endpoint: null,
      file_formats: [],
      record_count: null,
      columns: [],
      geography: null,
      time_coverage: null,
      tags: [],
      last_updated: null,
      retrieved_at: '2026-10-24T10:00:00Z',
      raw_snapshot_key: null,
      verification_level: 'metadata_only',
      provenance: {},
    };

    expect(
      DatasetSchema.safeParse({ ...validDataset, dataset_id: 'bad id' })
        .success,
    ).toBe(false);
    expect(
      DatasetSchema.safeParse({ ...validDataset, retrieved_at: 'yesterday' })
        .success,
    ).toBe(false);
    expect(
      DatasetSchema.safeParse({ ...validDataset, invented: true }).success,
    ).toBe(false);
  });
});

describe('request and version schemas', () => {
  it('limits compare requests to two through four distinct dataset IDs', () => {
    expect(
      CompareRequestSchema.safeParse({ dataset_ids: ['openml:1', 'openml:2'] })
        .success,
    ).toBe(true);
    expect(
      CompareRequestSchema.safeParse({ dataset_ids: ['openml:1', 'openml:1'] })
        .success,
    ).toBe(false);
    expect(
      CompareRequestSchema.safeParse({ dataset_ids: ['openml:1'] }).success,
    ).toBe(false);
  });

  it('trims search queries before enforcing the P0-3 query-length cap', () => {
    expect(
      SearchRequestSchema.safeParse({
        query: ` ${'x'.repeat(SEARCH_QUERY_MAX_LENGTH)} `,
      }).success,
    ).toBe(true);
    expect(
      SearchRequestSchema.safeParse({
        query: 'x'.repeat(SEARCH_QUERY_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
    expect(SearchRequestSchema.safeParse({ query: '   ' }).success).toBe(false);
  });

  it('requires every contract version field', () => {
    expect(
      ContractVersionsSchema.safeParse({
        contract_version: '1.0.0',
        prompt_version: 'extract.v1',
        schema_version: '1.0.0',
        scoring_version: 'score-v1',
        model_id: 'fake',
      }).success,
    ).toBe(true);
    expect(
      ContractVersionsSchema.safeParse({ contract_version: '1.0.0' }).success,
    ).toBe(false);
  });

  it('exports strict draft 2020-12 JSON Schemas for production consumers', () => {
    const schemas = toJsonSchemas();
    const extractionSchema = schemas.ExtractedRequirements;

    expect(Object.keys(schemas)).toContain('DatasetDetail');
    expect(extractionSchema).toMatchObject({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      additionalProperties: false,
      required: [
        'topic',
        'geography',
        'time_coverage',
        'minimum_records',
        'required_features',
        'target',
        'preferences',
        'constraints',
      ],
    });
    expect(extractionSchema).toMatchObject({
      properties: {
        topic: {
          anyOf: expect.arrayContaining([
            expect.objectContaining({
              maxLength: EXTRACTION_FIELD_MAX_LENGTH,
              'x-trim-before-length-validation': true,
            }),
          ]),
        },
        required_features: {
          maxItems: EXTRACTION_LIST_MAX_ITEMS,
          items: {
            maxLength: EXTRACTION_LIST_ITEM_MAX_LENGTH,
            'x-trim-before-length-validation': true,
          },
        },
        preferences: {
          maxItems: EXTRACTION_LIST_MAX_ITEMS,
          items: { maxLength: EXTRACTION_LIST_ITEM_MAX_LENGTH },
        },
        constraints: {
          maxItems: EXTRACTION_LIST_MAX_ITEMS,
          items: { maxLength: EXTRACTION_LIST_ITEM_MAX_LENGTH },
        },
        minimum_records: {
          anyOf: expect.arrayContaining([
            expect.objectContaining({
              minimum: MINIMUM_RECORDS_MIN_VALUE,
              maximum: MINIMUM_RECORDS_MAX_VALUE,
            }),
          ]),
        },
      },
    });
  });
});
