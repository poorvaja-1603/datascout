import { describe, expect, it } from 'vitest';
import { buildDatasetUsageGuidance } from '../src/utils/dataset-usage.js';
import type { Dataset } from '@datascout/contracts';

const datasetA: Dataset = {
  dataset_id: 'kaggle:climate/rainfall-australia',
  source: 'kaggle',
  title: 'Rainfall in Australia',
  description: 'Daily weather observations from Australian weather stations for rain prediction.',
  columns: [
    'Date',
    'Location',
    'MinTemp',
    'MaxTemp',
    'Rainfall',
    'Humidity9am',
    'RainTomorrow',
  ],
  file_formats: ['csv'],
  license: 'CC0: Public Domain',
  geography: 'Australia',
  time_coverage: '2008-2017',
  source_url: 'https://www.kaggle.com/datasets/climate/rainfall-australia',
  api_endpoint: null,
  record_count: 142193,
  byte_size: 14000000,
  access_type: 'open',
  raw_snapshot_key: null,
  provenance: {
    source: {
      source: 'kaggle',
      source_dataset_id: 'climate/rainfall-australia',
      retrieved_at: '2026-10-24T12:00:00Z',
      source_field_path: 'dataset.title',
    },
  },
};

const datasetB: Dataset = {
  dataset_id: 'kaggle:agri/crop-yield-australia',
  source: 'kaggle',
  title: 'Australian Crop Yield Records',
  description: 'Historical agricultural yields across Australian regions and seasons.',
  columns: ['Date', 'Location', 'CropType', 'YieldTons'],
  file_formats: ['csv'],
  license: 'CC-BY-4.0',
  geography: 'Australia',
  time_coverage: '2005-2020',
  source_url: 'https://www.kaggle.com/datasets/agri/crop-yield-australia',
  api_endpoint: null,
  record_count: 50000,
  byte_size: 5000000,
  access_type: 'open',
  raw_snapshot_key: null,
  provenance: {
    source: {
      source: 'kaggle',
      source_dataset_id: 'agri/crop-yield-australia',
      retrieved_at: '2026-10-24T12:00:00Z',
      source_field_path: 'dataset.title',
    },
  },
};

describe('Dataset Usage & Merging Engine', () => {
  it('generates customized usage, target identification, and merge suggestions', () => {
    const guidance = buildDatasetUsageGuidance({
      dataset: datasetA,
      matches: [],
      otherDatasets: [datasetA, datasetB],
      userQuery: 'rainfall prediction',
    });

    // 1. Explanation should be rich and multi-section
    expect(guidance.explanation).toContain('📋 Dataset Scope & Fit:');
    expect(guidance.explanation).toContain('🎯 Recommended Modeling Task:');
    expect(guidance.explanation).toContain('Rainfall');
    expect(guidance.explanation).toContain('⚙️ Preprocessing Roadmap:');
    expect(guidance.explanation).toContain('💡 Merge Opportunity:');
    expect(guidance.explanation).toContain('kaggle:agri/crop-yield-australia');

    // 2. Starter code should be Python with kagglehub
    expect(guidance.starterCode).toContain('kagglehub.dataset_download');
    expect(guidance.starterCode).toContain('climate/rainfall-australia');

    // 3. Preprocessing should feature column-specific advice
    expect(guidance.preprocessing.some((p) => p.includes('Date'))).toBe(true);
    expect(guidance.preprocessing.some((p) => p.includes('Location'))).toBe(true);

    // 4. Complementary datasets should contain merge suggestion with shared keys
    expect(guidance.complementaryDatasets.length).toBe(1);
    expect(guidance.complementaryDatasets[0]?.dataset_id).toBe(
      'kaggle:agri/crop-yield-australia',
    );
    expect(guidance.complementaryDatasets[0]?.join_keys).toEqual(
      expect.arrayContaining(['Location', 'Date']),
    );
    expect(guidance.complementaryDatasets[0]?.manual_verification_required).toBe(
      true,
    );
  });
});
