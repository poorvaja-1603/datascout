import { describe, expect, it } from 'vitest';
import type { Dataset } from '@datascout/contracts';
import { dedupeDatasets } from '../src/normalize/index.js';

function createMockDataset(overrides: Partial<Dataset> = {}): Dataset {
  return {
    dataset_id: 'huggingface:owner/weather',
    source: 'huggingface',
    source_url: 'https://huggingface.co/datasets/owner/weather',
    title: 'Weather Data',
    description: 'Global weather measurements',
    license: 'MIT',
    access_type: 'open',
    api_endpoint:
      'https://datasets-server.huggingface.co/rows?dataset=owner%2Fweather',
    file_formats: ['parquet'],
    record_count: 10000,
    columns: ['temp', 'humidity'],
    geography: null,
    time_coverage: null,
    tags: ['climate'],
    last_updated: '2026-01-01T00:00:00.000Z',
    retrieved_at: '2026-10-24T10:00:00.000Z',
    raw_snapshot_key: null,
    verification_level: 'metadata_only',
    provenance: {
      title: {
        source_field_path: 'title',
        retrieved_at: '2026-10-24T10:00:00.000Z',
      },
    },
    ...overrides,
  };
}

describe('dedupeDatasets', () => {
  it('dedupes by dataset_id and keeps the candidate with more non-null fields', () => {
    // candidate A has fewer non-null fields (record_count is null, columns empty)
    const sparse = createMockDataset({
      record_count: null,
      columns: [],
      tags: [],
      provenance: {},
    });

    // candidate B has more non-null fields
    const rich = createMockDataset({
      record_count: 25000,
      columns: ['temp', 'humidity', 'wind'],
      tags: ['climate', 'meteorology'],
      geography: 'Global',
    });

    const result = dedupeDatasets([sparse, rich]);
    expect(result).toHaveLength(1);
    expect(result[0]!.record_count).toBe(25000);
    expect(result[0]!.columns).toEqual(['temp', 'humidity', 'wind']);
    expect(result[0]!.geography).toBe('Global');
  });

  it('merges nothing silently across duplicates', () => {
    // candidate A has license 'MIT', no geography
    const candA = createMockDataset({
      license: 'MIT',
      geography: null,
      columns: ['temp', 'pressure'], // 2 columns
      tags: ['a', 'b', 'c'],
    });

    // candidate B has license 'unknown', but has geography 'Europe'
    const candB = createMockDataset({
      license: 'unknown',
      geography: 'Europe',
      columns: [],
      tags: [],
    });

    const result = dedupeDatasets([candA, candB]);
    expect(result).toHaveLength(1);
    // candA has more non-null fields, so candA wins
    expect(result[0]!.license).toBe('MIT');
    // candB's geography must NOT be merged into candA!
    expect(result[0]!.geography).toBeNull();
  });

  it('breaks ties using verification_level (sample_checked > metadata_only)', () => {
    const metaOnly = createMockDataset({
      verification_level: 'metadata_only',
      record_count: 100,
    });

    const sampleChecked = createMockDataset({
      verification_level: 'sample_checked',
      record_count: 100,
    });

    const result1 = dedupeDatasets([metaOnly, sampleChecked]);
    expect(result1).toHaveLength(1);
    expect(result1[0]!.verification_level).toBe('sample_checked');

    const result2 = dedupeDatasets([sampleChecked, metaOnly]);
    expect(result2).toHaveLength(1);
    expect(result2[0]!.verification_level).toBe('sample_checked');
  });

  it('is fully deterministic across shuffled input orders', () => {
    const cand1 = createMockDataset({
      title: 'Variant 1',
      record_count: 100,
      verification_level: 'sample_checked',
      retrieved_at: '2026-10-24T12:00:00.000Z',
    });

    const cand2 = createMockDataset({
      title: 'Variant 2',
      record_count: 50,
      verification_level: 'metadata_only',
      retrieved_at: '2026-10-24T11:00:00.000Z',
    });

    const cand3 = createMockDataset({
      title: 'Variant 3',
      record_count: 100,
      verification_level: 'full_dataset',
      retrieved_at: '2026-10-24T13:00:00.000Z',
    });

    const orderA = [cand1, cand2, cand3];
    const orderB = [cand3, cand1, cand2];
    const orderC = [cand2, cand3, cand1];

    const resA = dedupeDatasets(orderA);
    const resB = dedupeDatasets(orderB);
    const resC = dedupeDatasets(orderC);

    expect(resA[0]!.title).toBe(resB[0]!.title);
    expect(resB[0]!.title).toBe(resC[0]!.title);
    expect(resA[0]!.verification_level).toBe('full_dataset');
  });

  it('preserves distinct datasets with different IDs', () => {
    const ds1 = createMockDataset({ dataset_id: 'huggingface:org/dataset-1' });
    const ds2 = createMockDataset({ dataset_id: 'huggingface:org/dataset-2' });
    const ds3 = createMockDataset({ dataset_id: 'datagovin:resource-3' });

    const result = dedupeDatasets([ds1, ds2, ds3]);
    expect(result).toHaveLength(3);
    expect(result.map((d) => d.dataset_id)).toEqual([
      'huggingface:org/dataset-1',
      'huggingface:org/dataset-2',
      'datagovin:resource-3',
    ]);
  });
});
