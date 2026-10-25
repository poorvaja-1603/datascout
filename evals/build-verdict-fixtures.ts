import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import {
  DatasetSchema,
  EvidenceSchema,
  RequirementSchema,
  RequirementMatchSchema,
} from '../contracts/src/index.js';
import { matchRequirements } from '../packages/verify/src/index.js';

interface RawFixture {
  dataset: z.infer<typeof DatasetSchema>;
  requirements: z.infer<typeof RequirementSchema>[];
  evidence: z.infer<typeof EvidenceSchema>[];
  expected_verdicts: z.infer<typeof RequirementMatchSchema>[];
}

const fixtures: RawFixture[] = [];

function registerFixture(
  dataset: z.infer<typeof DatasetSchema>,
  requirements: z.infer<typeof RequirementSchema>[],
  evidence: z.infer<typeof EvidenceSchema>[],
) {
  DatasetSchema.parse(dataset);
  requirements.forEach(r => RequirementSchema.parse(r));
  evidence.forEach(e => EvidenceSchema.parse(e));

  const actualVerdicts = matchRequirements(requirements, dataset, evidence);
  actualVerdicts.forEach(v => RequirementMatchSchema.parse(v));

  fixtures.push({
    dataset,
    requirements,
    evidence,
    expected_verdicts: actualVerdicts,
  });
}

// 1. DATA.GOV.IN: Maharashtra Crop Yield
const dg1Id = 'datagovin:crop-yield-maharashtra';
registerFixture(
  {
    dataset_id: dg1Id,
    source: 'datagovin',
    source_url: 'https://data.gov.in/resource/crop-yield-maharashtra',
    title: 'District-wise Crop Production Statistics for Maharashtra',
    description: 'Annual crop yield and seasonal rainfall by district in Maharashtra.',
    license: 'Government Open Data License - India (GODL)',
    access_type: 'open',
    api_endpoint: 'https://api.data.gov.in/resource/crop-yield-mh',
    file_formats: ['csv'],
    record_count: 14200,
    columns: ['state', 'district', 'crop', 'crop_year', 'season', 'area_hectares', 'production_tonnes', 'annual_rainfall_mm'],
    geography: 'Maharashtra',
    time_coverage: '2015-2022',
    tags: ['agriculture', 'crop yield', 'rainfall', 'maharashtra'],
    last_updated: '2023-08-15T00:00:00Z',
    retrieved_at: '2026-01-10T00:00:00Z',
    raw_snapshot_key: 'snapshots/datagovin/crop-yield-maharashtra.csv',
    verification_level: 'sample_checked',
    provenance: {
      geography: { source_field_path: 'metadata.spatial_coverage', retrieved_at: '2026-01-10T00:00:00Z' },
      record_count: { source_field_path: 'sample.row_count', retrieved_at: '2026-01-10T00:00:00Z' },
    },
  },
  [
    { requirement_id: 'req-dg1-topic', type: 'topic', value: 'crop yield', unit: null, priority: 'required', aliases: ['agriculture'], source_span: null },
    { requirement_id: 'req-dg1-geo', type: 'geography', value: 'Maharashtra', unit: null, priority: 'required', aliases: ['MH'], source_span: null },
    { requirement_id: 'req-dg1-time', type: 'time_coverage', value: '2015-2022', unit: null, priority: 'required', aliases: [], source_span: null },
    { requirement_id: 'req-dg1-minrec', type: 'minimum_records', value: 5000, unit: 'records', priority: 'required', aliases: [], source_span: null },
    { requirement_id: 'req-dg1-feat1', type: 'feature', value: 'rainfall', unit: null, priority: 'required', aliases: ['annual_rainfall_mm'], source_span: null },
    { requirement_id: 'req-dg1-target', type: 'target', value: 'production_tonnes', unit: null, priority: 'required', aliases: ['yield'], source_span: null },
    { requirement_id: 'req-dg1-fail-geo', type: 'geography', value: 'Karnataka', unit: null, priority: 'required', aliases: [], source_span: null },
  ],
  [
    { evidence_id: 'ev-dg1-topic', dataset_id: dg1Id, field: 'topic', value: 'crop yield', provenance: { source_field_path: 'tags', retrieved_at: '2026-01-10T00:00:00Z' } },
    { evidence_id: 'ev-dg1-geo', dataset_id: dg1Id, field: 'geography', value: 'Maharashtra', provenance: { source_field_path: 'geography', retrieved_at: '2026-01-10T00:00:00Z' } },
    { evidence_id: 'ev-dg1-time', dataset_id: dg1Id, field: 'time_coverage', value: '2015-2022', provenance: { source_field_path: 'time_coverage', retrieved_at: '2026-01-10T00:00:00Z' } },
    { evidence_id: 'ev-dg1-count', dataset_id: dg1Id, field: 'record_count', value: 14200, provenance: { source_field_path: 'sample.row_count', retrieved_at: '2026-01-10T00:00:00Z' } },
    { evidence_id: 'ev-dg1-cols', dataset_id: dg1Id, field: 'columns', value: ['state', 'district', 'crop', 'crop_year', 'season', 'area_hectares', 'production_tonnes', 'annual_rainfall_mm'], provenance: { source_field_path: 'sample.columns', retrieved_at: '2026-01-10T00:00:00Z' } },
  ]
);

// 2. DATA.GOV.IN: Delhi Air Quality (metadata_only)
const dg2Id = 'datagovin:delhi-air-quality';
registerFixture(
  {
    dataset_id: dg2Id,
    source: 'datagovin',
    source_url: 'https://data.gov.in/resource/delhi-air-quality',
    title: 'Central Pollution Control Board Delhi Air Quality Hourly Data',
    description: 'Hourly PM2.5, PM10, NO2, and SO2 monitoring across Delhi stations.',
    license: 'Government Open Data License - India (GODL)',
    access_type: 'open',
    api_endpoint: 'https://api.data.gov.in/resource/cpcb-aqi',
    file_formats: ['csv', 'json'],
    record_count: 87600,
    columns: ['station', 'timestamp', 'pm25', 'pm10', 'no2', 'so2', 'aqi_sub_index'],
    geography: 'Delhi',
    time_coverage: '2023-2023',
    tags: ['air quality', 'pollution', 'delhi', 'cpcb'],
    last_updated: '2024-01-05T00:00:00Z',
    retrieved_at: '2026-01-10T00:00:00Z',
    raw_snapshot_key: null,
    verification_level: 'metadata_only',
    provenance: {},
  },
  [
    { requirement_id: 'req-dg2-topic', type: 'topic', value: 'air quality', unit: null, priority: 'required', aliases: ['pollution'], source_span: null },
    { requirement_id: 'req-dg2-geo', type: 'geography', value: 'Delhi', unit: null, priority: 'required', aliases: ['New Delhi'], source_span: null },
    { requirement_id: 'req-dg2-feat', type: 'feature', value: 'pm25', unit: null, priority: 'required', aliases: [], source_span: null },
    { requirement_id: 'req-dg2-fail-records', type: 'minimum_records', value: 200000, unit: 'records', priority: 'required', aliases: [], source_span: null },
    { requirement_id: 'req-dg2-pref-fmt', type: 'preference', value: 'json', unit: null, priority: 'preferred', aliases: [], source_span: null },
  ],
  [
    { evidence_id: 'ev-dg2-topic', dataset_id: dg2Id, field: 'topic', value: 'air quality', provenance: { source_field_path: 'tags', retrieved_at: '2026-01-10T00:00:00Z' } },
    { evidence_id: 'ev-dg2-geo', dataset_id: dg2Id, field: 'geography', value: 'Delhi', provenance: { source_field_path: 'geography', retrieved_at: '2026-01-10T00:00:00Z' } },
    { evidence_id: 'ev-dg2-cols', dataset_id: dg2Id, field: 'columns', value: ['station', 'timestamp', 'pm25', 'pm10', 'no2', 'so2', 'aqi_sub_index'], provenance: { source_field_path: 'columns', retrieved_at: '2026-01-10T00:00:00Z' } },
    { evidence_id: 'ev-dg2-count', dataset_id: dg2Id, field: 'record_count', value: 87600, provenance: { source_field_path: 'record_count', retrieved_at: '2026-01-10T00:00:00Z' } },
    { evidence_id: 'ev-dg2-pref', dataset_id: dg2Id, field: 'preferences', value: ['csv', 'json'], provenance: { source_field_path: 'file_formats', retrieved_at: '2026-01-10T00:00:00Z' } },
  ]
);

// 3. DATA.GOV.IN: Karnataka Health Facilities (sample_checked)
const dg3Id = 'datagovin:karnataka-phc-facilities';
registerFixture(
  {
    dataset_id: dg3Id,
    source: 'datagovin',
    source_url: 'https://data.gov.in/resource/karnataka-phc',
    title: 'Primary Health Centers and Bed Capacities in Karnataka',
    description: 'Government health facilities, beds, doctors, and location in Karnataka.',
    license: 'Government Open Data License - India (GODL)',
    access_type: 'open',
    api_endpoint: null,
    file_formats: ['csv'],
    record_count: 2450,
    columns: ['district', 'phc_name', 'taluk', 'doctors_count', 'beds_count', 'latitude', 'longitude'],
    geography: 'Karnataka',
    time_coverage: '2021-2022',
    tags: ['health', 'hospitals', 'karnataka', 'public health'],
    last_updated: '2022-09-01T00:00:00Z',
    retrieved_at: '2026-01-14T00:00:00Z',
    raw_snapshot_key: 'snapshots/datagovin/karnataka-phc.csv',
    verification_level: 'sample_checked',
    provenance: {},
  },
  [
    { requirement_id: 'req-dg3-topic', type: 'topic', value: 'health', unit: null, priority: 'required', aliases: ['public health'], source_span: null },
    { requirement_id: 'req-dg3-geo', type: 'geography', value: 'Karnataka', unit: null, priority: 'required', aliases: [], source_span: null },
    { requirement_id: 'req-dg3-feat1', type: 'feature', value: 'beds_count', unit: null, priority: 'required', aliases: ['beds'], source_span: null },
    { requirement_id: 'req-dg3-minrec', type: 'minimum_records', value: 2000, unit: 'records', priority: 'required', aliases: [], source_span: null },
    { requirement_id: 'req-dg3-fail-rec', type: 'minimum_records', value: 5000, unit: 'records', priority: 'required', aliases: [], source_span: null },
    { requirement_id: 'req-dg3-fail-feat', type: 'feature', value: 'icu_ventilators', unit: null, priority: 'required', aliases: [], source_span: null },
  ],
  [
    { evidence_id: 'ev-dg3-topic', dataset_id: dg3Id, field: 'topic', value: 'health', provenance: { source_field_path: 'tags', retrieved_at: '2026-01-14T00:00:00Z' } },
    { evidence_id: 'ev-dg3-geo', dataset_id: dg3Id, field: 'geography', value: 'Karnataka', provenance: { source_field_path: 'geography', retrieved_at: '2026-01-14T00:00:00Z' } },
    { evidence_id: 'ev-dg3-cols', dataset_id: dg3Id, field: 'columns', value: ['district', 'phc_name', 'taluk', 'doctors_count', 'beds_count', 'latitude', 'longitude'], provenance: { source_field_path: 'columns', retrieved_at: '2026-01-14T00:00:00Z' } },
    { evidence_id: 'ev-dg3-count', dataset_id: dg3Id, field: 'record_count', value: 2450, provenance: { source_field_path: 'record_count', retrieved_at: '2026-01-14T00:00:00Z' } },
  ]
);

// 4. DATA.GOV.IN: India Demographic Census 2011 (metadata_only)
const dg4Id = 'datagovin:india-census-literacy-2011';
registerFixture(
  {
    dataset_id: dg4Id,
    source: 'datagovin',
    source_url: 'https://data.gov.in/resource/census-2011-literacy',
    title: 'Census 2011 District Level Population and Literacy Statistics',
    description: 'Demographic breakdown of population, male and female literacy by district.',
    license: 'Government Open Data License - India (GODL)',
    access_type: 'open',
    api_endpoint: null,
    file_formats: ['csv'],
    record_count: 640,
    columns: ['state_code', 'state_name', 'district_code', 'district_name', 'population_total', 'literate_total'],
    geography: 'India',
    time_coverage: '2011-2011',
    tags: ['census', 'demographics', 'literacy', 'population', 'india'],
    last_updated: '2015-06-01T00:00:00Z',
    retrieved_at: '2026-01-15T00:00:00Z',
    raw_snapshot_key: null,
    verification_level: 'metadata_only',
    provenance: {},
  },
  [
    { requirement_id: 'req-dg4-topic', type: 'topic', value: 'literacy', unit: null, priority: 'required', aliases: ['education'], source_span: null },
    { requirement_id: 'req-dg4-geo', type: 'geography', value: 'India', unit: null, priority: 'required', aliases: [], source_span: null },
    { requirement_id: 'req-dg4-time', type: 'time_coverage', value: '2011-2011', unit: null, priority: 'required', aliases: [], source_span: null },
    { requirement_id: 'req-dg4-feat', type: 'feature', value: 'population_total', unit: null, priority: 'required', aliases: [], source_span: null },
    { requirement_id: 'req-dg4-fail-time', type: 'time_coverage', value: '2020-2022', unit: null, priority: 'required', aliases: [], source_span: null },
  ],
  [
    { evidence_id: 'ev-dg4-topic', dataset_id: dg4Id, field: 'topic', value: 'literacy', provenance: { source_field_path: 'tags', retrieved_at: '2026-01-15T00:00:00Z' } },
    { evidence_id: 'ev-dg4-geo', dataset_id: dg4Id, field: 'geography', value: 'India', provenance: { source_field_path: 'geography', retrieved_at: '2026-01-15T00:00:00Z' } },
    { evidence_id: 'ev-dg4-time', dataset_id: dg4Id, field: 'time_coverage', value: '2011-2011', provenance: { source_field_path: 'time_coverage', retrieved_at: '2026-01-15T00:00:00Z' } },
    { evidence_id: 'ev-dg4-cols', dataset_id: dg4Id, field: 'columns', value: ['state_code', 'state_name', 'district_code', 'district_name', 'population_total', 'literate_total'], provenance: { source_field_path: 'columns', retrieved_at: '2026-01-15T00:00:00Z' } },
  ]
);

// 5. HUGGING FACE: Financial PhraseBank (sample_checked)
const hf1Id = 'huggingface:financial_phrasebank';
registerFixture(
  {
    dataset_id: hf1Id,
    source: 'huggingface',
    source_url: 'https://huggingface.co/datasets/financial_phrasebank',
    title: 'Financial PhraseBank Sentiment Dataset',
    description: 'Polar sentiment classification for financial news statements.',
    license: 'cc-by-nc-sa-4.0',
    access_type: 'open',
    api_endpoint: 'https://datasets-server.huggingface.co/rows?dataset=financial_phrasebank',
    file_formats: ['parquet', 'json'],
    record_count: 4845,
    columns: ['sentence', 'label'],
    geography: null,
    time_coverage: null,
    tags: ['finance', 'sentiment analysis', 'nlp', 'classification'],
    last_updated: '2023-04-10T00:00:00Z',
    retrieved_at: '2026-01-11T00:00:00Z',
    raw_snapshot_key: 'snapshots/hf/financial_phrasebank.parquet',
    verification_level: 'sample_checked',
    provenance: {},
  },
  [
    { requirement_id: 'req-hf1-topic', type: 'topic', value: 'sentiment analysis', unit: null, priority: 'required', aliases: ['classification'], source_span: null },
    { requirement_id: 'req-hf1-feat', type: 'feature', value: 'sentence', unit: null, priority: 'required', aliases: ['text'], source_span: null },
    { requirement_id: 'req-hf1-target', type: 'target', value: 'label', unit: null, priority: 'required', aliases: ['sentiment'], source_span: null },
    { requirement_id: 'req-hf1-minrec', type: 'minimum_records', value: 4000, unit: 'records', priority: 'required', aliases: [], source_span: null },
    { requirement_id: 'req-hf1-constraint', type: 'constraint', value: 'open', unit: null, priority: 'required', aliases: ['public'], source_span: null },
    { requirement_id: 'req-hf1-fail-records', type: 'minimum_records', value: 10000, unit: 'records', priority: 'required', aliases: [], source_span: null },
  ],
  [
    { evidence_id: 'ev-hf1-topic', dataset_id: hf1Id, field: 'topic', value: 'sentiment analysis', provenance: { source_field_path: 'tags', retrieved_at: '2026-01-11T00:00:00Z' } },
    { evidence_id: 'ev-hf1-cols', dataset_id: hf1Id, field: 'columns', value: ['sentence', 'label'], provenance: { source_field_path: 'viewer.first_rows', retrieved_at: '2026-01-11T00:00:00Z' } },
    { evidence_id: 'ev-hf1-count', dataset_id: hf1Id, field: 'record_count', value: 4845, provenance: { source_field_path: 'viewer.size', retrieved_at: '2026-01-11T00:00:00Z' } },
    { evidence_id: 'ev-hf1-access', dataset_id: hf1Id, field: 'constraints', value: ['open', 'cc-by-nc-sa-4.0', 'parquet', 'json'], provenance: { source_field_path: 'card.license', retrieved_at: '2026-01-11T00:00:00Z' } },
  ]
);

// 6. HUGGING FACE: SQuAD (metadata_only)
const hf2Id = 'huggingface:squad';
registerFixture(
  {
    dataset_id: hf2Id,
    source: 'huggingface',
    source_url: 'https://huggingface.co/datasets/squad',
    title: 'Stanford Question Answering Dataset',
    description: 'Reading comprehension dataset consisting of questions posed on Wikipedia articles.',
    license: 'cc-by-sa-4.0',
    access_type: 'open',
    api_endpoint: 'https://datasets-server.huggingface.co/rows?dataset=squad',
    file_formats: ['parquet'],
    record_count: 100000,
    columns: ['id', 'title', 'context', 'question', 'answers'],
    geography: null,
    time_coverage: null,
    tags: ['question answering', 'reading comprehension', 'nlp'],
    last_updated: '2023-01-15T00:00:00Z',
    retrieved_at: '2026-01-11T00:00:00Z',
    raw_snapshot_key: null,
    verification_level: 'metadata_only',
    provenance: {},
  },
  [
    { requirement_id: 'req-hf2-topic', type: 'topic', value: 'question answering', unit: null, priority: 'required', aliases: ['qa'], source_span: null },
    { requirement_id: 'req-hf2-feat', type: 'feature', value: 'context', unit: null, priority: 'required', aliases: ['passage'], source_span: null },
    { requirement_id: 'req-hf2-time', type: 'time_coverage', value: '2020-2022', unit: null, priority: 'required', aliases: [], source_span: null },
    { requirement_id: 'req-hf2-unknown-geo', type: 'geography', value: 'Global', unit: null, priority: 'required', aliases: [], source_span: null },
  ],
  [
    { evidence_id: 'ev-hf2-topic', dataset_id: hf2Id, field: 'topic', value: 'question answering', provenance: { source_field_path: 'tags', retrieved_at: '2026-01-11T00:00:00Z' } },
    { evidence_id: 'ev-hf2-cols', dataset_id: hf2Id, field: 'columns', value: ['id', 'title', 'context', 'question', 'answers'], provenance: { source_field_path: 'columns', retrieved_at: '2026-01-11T00:00:00Z' } },
  ]
);

// 7. HUGGING FACE: SST-2 (sample_checked)
const hf3Id = 'huggingface:sst2';
registerFixture(
  {
    dataset_id: hf3Id,
    source: 'huggingface',
    source_url: 'https://huggingface.co/datasets/sst2',
    title: 'Stanford Sentiment Treebank (SST-2)',
    description: 'Binary sentiment sentences from movie reviews for benchmarking.',
    license: 'other',
    access_type: 'open',
    api_endpoint: 'https://datasets-server.huggingface.co/rows?dataset=glue&config=sst2',
    file_formats: ['parquet'],
    record_count: 67349,
    columns: ['sentence', 'label', 'idx'],
    geography: null,
    time_coverage: null,
    tags: ['sentiment', 'nlp', 'benchmark'],
    last_updated: '2023-05-01T00:00:00Z',
    retrieved_at: '2026-01-14T00:00:00Z',
    raw_snapshot_key: 'snapshots/hf/glue-sst2.parquet',
    verification_level: 'sample_checked',
    provenance: {},
  },
  [
    { requirement_id: 'req-hf3-topic', type: 'topic', value: 'sentiment', unit: null, priority: 'required', aliases: ['nlp'], source_span: null },
    { requirement_id: 'req-hf3-feat', type: 'feature', value: 'sentence', unit: null, priority: 'required', aliases: [], source_span: null },
    { requirement_id: 'req-hf3-target', type: 'target', value: 'label', unit: null, priority: 'required', aliases: [], source_span: null },
    { requirement_id: 'req-hf3-minrec', type: 'minimum_records', value: 50000, unit: 'records', priority: 'required', aliases: [], source_span: null },
    { requirement_id: 'req-hf3-fail-target', type: 'target', value: 'bounding_box', unit: null, priority: 'required', aliases: [], source_span: null },
  ],
  [
    { evidence_id: 'ev-hf3-topic', dataset_id: hf3Id, field: 'topic', value: 'sentiment', provenance: { source_field_path: 'tags', retrieved_at: '2026-01-14T00:00:00Z' } },
    { evidence_id: 'ev-hf3-cols', dataset_id: hf3Id, field: 'columns', value: ['sentence', 'label', 'idx'], provenance: { source_field_path: 'columns', retrieved_at: '2026-01-14T00:00:00Z' } },
    { evidence_id: 'ev-hf3-count', dataset_id: hf3Id, field: 'record_count', value: 67349, provenance: { source_field_path: 'record_count', retrieved_at: '2026-01-14T00:00:00Z' } },
  ]
);

// 8. OPENML: Diabetes (sample_checked)
const oml1Id = 'openml:diabetes';
registerFixture(
  {
    dataset_id: oml1Id,
    source: 'openml',
    source_url: 'https://www.openml.org/d/37',
    title: 'Pima Indians Diabetes Database',
    description: 'Predict whether or not a patient has diabetes based on diagnostic measurements.',
    license: 'Public Domain',
    access_type: 'open',
    api_endpoint: 'https://www.openml.org/api/v1/json/data/37',
    file_formats: ['arff', 'csv'],
    record_count: 768,
    columns: ['preg', 'plas', 'pres', 'skin', 'insu', 'mass', 'pedi', 'age', 'class'],
    geography: 'United States',
    time_coverage: null,
    tags: ['medical', 'classification', 'diabetes', 'tabular'],
    last_updated: '2014-04-06T00:00:00Z',
    retrieved_at: '2026-01-12T00:00:00Z',
    raw_snapshot_key: 'snapshots/openml/37.csv',
    verification_level: 'sample_checked',
    provenance: {},
  },
  [
    { requirement_id: 'req-oml1-topic', type: 'topic', value: 'diabetes', unit: null, priority: 'required', aliases: ['medical'], source_span: null },
    { requirement_id: 'req-oml1-target', type: 'target', value: 'class', unit: null, priority: 'required', aliases: ['outcome'], source_span: null },
    { requirement_id: 'req-oml1-feat', type: 'feature', value: 'age', unit: null, priority: 'required', aliases: [], source_span: null },
    { requirement_id: 'req-oml1-minrec', type: 'minimum_records', value: 500, unit: 'records', priority: 'required', aliases: [], source_span: null },
    { requirement_id: 'req-oml1-fail-minrec', type: 'minimum_records', value: 1000, unit: 'records', priority: 'required', aliases: [], source_span: null },
    { requirement_id: 'req-oml1-fail-geo', type: 'geography', value: 'India', unit: null, priority: 'required', aliases: [], source_span: null },
  ],
  [
    { evidence_id: 'ev-oml1-topic', dataset_id: oml1Id, field: 'topic', value: 'diabetes', provenance: { source_field_path: 'tags', retrieved_at: '2026-01-12T00:00:00Z' } },
    { evidence_id: 'ev-oml1-cols', dataset_id: oml1Id, field: 'columns', value: ['preg', 'plas', 'pres', 'skin', 'insu', 'mass', 'pedi', 'age', 'class'], provenance: { source_field_path: 'features', retrieved_at: '2026-01-12T00:00:00Z' } },
    { evidence_id: 'ev-oml1-count', dataset_id: oml1Id, field: 'record_count', value: 768, provenance: { source_field_path: 'qualities.NumberOfInstances', retrieved_at: '2026-01-12T00:00:00Z' } },
    { evidence_id: 'ev-oml1-geo', dataset_id: oml1Id, field: 'geography', value: 'United States', provenance: { source_field_path: 'description', retrieved_at: '2026-01-12T00:00:00Z' } },
  ]
);

// 9. OPENML: Credit Card Fraud (sample_checked)
const oml2Id = 'openml:creditcard-fraud';
registerFixture(
  {
    dataset_id: oml2Id,
    source: 'openml',
    source_url: 'https://www.openml.org/d/42175',
    title: 'Credit Card Fraud Detection',
    description: 'Anonymized credit card transactions labeled as fraudulent or genuine.',
    license: 'Database Contents License (DbCL)',
    access_type: 'open',
    api_endpoint: 'https://www.openml.org/api/v1/json/data/42175',
    file_formats: ['arff', 'csv'],
    record_count: 284807,
    columns: ['Time', 'V1', 'V2', 'V3', 'Amount', 'Class'],
    geography: 'Europe',
    time_coverage: '2013-2013',
    tags: ['fraud detection', 'finance', 'anomaly detection'],
    last_updated: '2019-10-15T00:00:00Z',
    retrieved_at: '2026-01-12T00:00:00Z',
    raw_snapshot_key: 'snapshots/openml/42175.csv',
    verification_level: 'sample_checked',
    provenance: {},
  },
  [
    { requirement_id: 'req-oml2-topic', type: 'topic', value: 'fraud detection', unit: null, priority: 'required', aliases: ['finance'], source_span: null },
    { requirement_id: 'req-oml2-feat1', type: 'feature', value: 'Amount', unit: null, priority: 'required', aliases: ['transaction_amount'], source_span: null },
    { requirement_id: 'req-oml2-target', type: 'target', value: 'Class', unit: null, priority: 'required', aliases: ['fraud'], source_span: null },
    { requirement_id: 'req-oml2-geo', type: 'geography', value: 'Europe', unit: null, priority: 'required', aliases: ['EU'], source_span: null },
    { requirement_id: 'req-oml2-minrec', type: 'minimum_records', value: 100000, unit: 'records', priority: 'required', aliases: [], source_span: null },
    { requirement_id: 'req-oml2-time', type: 'time_coverage', value: '2013-2013', unit: null, priority: 'required', aliases: [], source_span: null },
    { requirement_id: 'req-oml2-fail-time', type: 'time_coverage', value: '2018-2022', unit: null, priority: 'required', aliases: [], source_span: null },
  ],
  [
    { evidence_id: 'ev-oml2-topic', dataset_id: oml2Id, field: 'topic', value: 'fraud detection', provenance: { source_field_path: 'tags', retrieved_at: '2026-01-12T00:00:00Z' } },
    { evidence_id: 'ev-oml2-cols', dataset_id: oml2Id, field: 'columns', value: ['Time', 'V1', 'V2', 'V3', 'Amount', 'Class'], provenance: { source_field_path: 'features', retrieved_at: '2026-01-12T00:00:00Z' } },
    { evidence_id: 'ev-oml2-geo', dataset_id: oml2Id, field: 'geography', value: 'Europe', provenance: { source_field_path: 'description', retrieved_at: '2026-01-12T00:00:00Z' } },
    { evidence_id: 'ev-oml2-count', dataset_id: oml2Id, field: 'record_count', value: 284807, provenance: { source_field_path: 'qualities.NumberOfInstances', retrieved_at: '2026-01-12T00:00:00Z' } },
    { evidence_id: 'ev-oml2-time', dataset_id: oml2Id, field: 'time_coverage', value: '2013-2013', provenance: { source_field_path: 'description', retrieved_at: '2026-01-12T00:00:00Z' } },
  ]
);

// 10. OPENML: Titanic (sample_checked)
const oml3Id = 'openml:titanic';
registerFixture(
  {
    dataset_id: oml3Id,
    source: 'openml',
    source_url: 'https://www.openml.org/d/40945',
    title: 'Titanic Passenger Survival Dataset',
    description: 'Survival outcome of Titanic passengers with demographics and passenger class.',
    license: 'Public Domain',
    access_type: 'open',
    api_endpoint: 'https://www.openml.org/api/v1/json/data/40945',
    file_formats: ['arff', 'csv'],
    record_count: 1309,
    columns: ['pclass', 'survived', 'name', 'sex', 'age', 'sibsp', 'parch', 'ticket', 'fare', 'cabin', 'embarked'],
    geography: null,
    time_coverage: '1912-1912',
    tags: ['survival analysis', 'classification', 'titanic'],
    last_updated: '2016-01-01T00:00:00Z',
    retrieved_at: '2026-01-14T00:00:00Z',
    raw_snapshot_key: 'snapshots/openml/40945.csv',
    verification_level: 'sample_checked',
    provenance: {},
  },
  [
    { requirement_id: 'req-oml3-topic', type: 'topic', value: 'survival analysis', unit: null, priority: 'required', aliases: ['classification'], source_span: null },
    { requirement_id: 'req-oml3-target', type: 'target', value: 'survived', unit: null, priority: 'required', aliases: [], source_span: null },
    { requirement_id: 'req-oml3-feat1', type: 'feature', value: 'age', unit: null, priority: 'required', aliases: [], source_span: null },
    { requirement_id: 'req-oml3-feat2', type: 'feature', value: 'sex', unit: null, priority: 'required', aliases: ['gender'], source_span: null },
    { requirement_id: 'req-oml3-time', type: 'time_coverage', value: '1912-1912', unit: null, priority: 'required', aliases: [], source_span: null },
    { requirement_id: 'req-oml3-minrec', type: 'minimum_records', value: 1000, unit: 'records', priority: 'required', aliases: [], source_span: null },
  ],
  [
    { evidence_id: 'ev-oml3-topic', dataset_id: oml3Id, field: 'topic', value: 'survival analysis', provenance: { source_field_path: 'tags', retrieved_at: '2026-01-14T00:00:00Z' } },
    { evidence_id: 'ev-oml3-cols', dataset_id: oml3Id, field: 'columns', value: ['pclass', 'survived', 'name', 'sex', 'age', 'sibsp', 'parch', 'ticket', 'fare', 'cabin', 'embarked'], provenance: { source_field_path: 'columns', retrieved_at: '2026-01-14T00:00:00Z' } },
    { evidence_id: 'ev-oml3-time', dataset_id: oml3Id, field: 'time_coverage', value: '1912-1912', provenance: { source_field_path: 'time_coverage', retrieved_at: '2026-01-14T00:00:00Z' } },
    { evidence_id: 'ev-oml3-count', dataset_id: oml3Id, field: 'record_count', value: 1309, provenance: { source_field_path: 'record_count', retrieved_at: '2026-01-14T00:00:00Z' } },
  ]
);

// 11. WORLD BANK: GDP Per Capita (sample_checked)
const wb1Id = 'worldbank:gdp-per-capita';
registerFixture(
  {
    dataset_id: wb1Id,
    source: 'worldbank',
    source_url: 'https://data.worldbank.org/indicator/NY.GDP.PCAP.CD',
    title: 'GDP per capita (current US$)',
    description: 'GDP per capita is gross domestic product divided by midyear population.',
    license: 'CC-BY-4.0',
    access_type: 'open',
    api_endpoint: 'https://api.worldbank.org/v2/country/all/indicator/NY.GDP.PCAP.CD?format=json',
    file_formats: ['json', 'csv'],
    record_count: 16800,
    columns: ['country', 'countryiso3code', 'date', 'value', 'indicator'],
    geography: 'World',
    time_coverage: '1960-2023',
    tags: ['economy', 'gdp', 'development', 'world bank', 'indicators'],
    last_updated: '2024-03-28T00:00:00Z',
    retrieved_at: '2026-01-13T00:00:00Z',
    raw_snapshot_key: 'snapshots/worldbank/NY.GDP.PCAP.CD.json',
    verification_level: 'sample_checked',
    provenance: {},
  },
  [
    { requirement_id: 'req-wb1-topic', type: 'topic', value: 'gdp', unit: null, priority: 'required', aliases: ['economy'], source_span: null },
    { requirement_id: 'req-wb1-time', type: 'time_coverage', value: '2000-2020', unit: null, priority: 'required', aliases: [], source_span: null },
    { requirement_id: 'req-wb1-minrec', type: 'minimum_records', value: 10000, unit: 'records', priority: 'required', aliases: [], source_span: null },
    { requirement_id: 'req-wb1-feat', type: 'feature', value: 'country', unit: null, priority: 'required', aliases: [], source_span: null },
    { requirement_id: 'req-wb1-target', type: 'target', value: 'value', unit: null, priority: 'required', aliases: ['gdp_per_capita'], source_span: null },
    { requirement_id: 'req-wb1-geo', type: 'geography', value: 'World', unit: null, priority: 'required', aliases: ['Global'], source_span: null },
    { requirement_id: 'req-wb1-constraint', type: 'constraint', value: 'open', unit: null, priority: 'required', aliases: [], source_span: null },
    { requirement_id: 'req-wb1-fail-feat', type: 'feature', value: 'patient_blood_pressure', unit: null, priority: 'required', aliases: [], source_span: null },
  ],
  [
    { evidence_id: 'ev-wb1-topic', dataset_id: wb1Id, field: 'topic', value: 'gdp', provenance: { source_field_path: 'tags', retrieved_at: '2026-01-13T00:00:00Z' } },
    { evidence_id: 'ev-wb1-time', dataset_id: wb1Id, field: 'time_coverage', value: '1960-2023', provenance: { source_field_path: 'time_coverage', retrieved_at: '2026-01-13T00:00:00Z' } },
    { evidence_id: 'ev-wb1-count', dataset_id: wb1Id, field: 'record_count', value: 16800, provenance: { source_field_path: 'total', retrieved_at: '2026-01-13T00:00:00Z' } },
    { evidence_id: 'ev-wb1-cols', dataset_id: wb1Id, field: 'columns', value: ['country', 'countryiso3code', 'date', 'value', 'indicator'], provenance: { source_field_path: 'columns', retrieved_at: '2026-01-13T00:00:00Z' } },
    { evidence_id: 'ev-wb1-geo', dataset_id: wb1Id, field: 'geography', value: 'World', provenance: { source_field_path: 'geography', retrieved_at: '2026-01-13T00:00:00Z' } },
    { evidence_id: 'ev-wb1-access', dataset_id: wb1Id, field: 'constraints', value: ['open', 'CC-BY-4.0', 'json', 'csv'], provenance: { source_field_path: 'license', retrieved_at: '2026-01-13T00:00:00Z' } },
  ]
);

// 12. WORLD BANK: Life Expectancy (sample_checked)
const wb2Id = 'worldbank:life-expectancy';
registerFixture(
  {
    dataset_id: wb2Id,
    source: 'worldbank',
    source_url: 'https://data.worldbank.org/indicator/SP.DYN.LE00.IN',
    title: 'Life expectancy at birth, total (years)',
    description: 'Life expectancy at birth indicates the number of years a newborn infant would live.',
    license: 'CC-BY-4.0',
    access_type: 'open',
    api_endpoint: 'https://api.worldbank.org/v2/country/all/indicator/SP.DYN.LE00.IN?format=json',
    file_formats: ['json', 'csv'],
    record_count: 15500,
    columns: ['country', 'countryiso3code', 'date', 'value', 'indicator'],
    geography: 'World',
    time_coverage: '1960-2022',
    tags: ['health', 'life expectancy', 'demographics', 'world bank'],
    last_updated: '2023-12-15T00:00:00Z',
    retrieved_at: '2026-01-14T00:00:00Z',
    raw_snapshot_key: 'snapshots/worldbank/SP.DYN.LE00.IN.json',
    verification_level: 'sample_checked',
    provenance: {},
  },
  [
    { requirement_id: 'req-wb2-topic', type: 'topic', value: 'life expectancy', unit: null, priority: 'required', aliases: ['health', 'demographics'], source_span: null },
    { requirement_id: 'req-wb2-time', type: 'time_coverage', value: '1970-2020', unit: null, priority: 'required', aliases: [], source_span: null },
    { requirement_id: 'req-wb2-target', type: 'target', value: 'value', unit: null, priority: 'required', aliases: ['years'], source_span: null },
    { requirement_id: 'req-wb2-minrec', type: 'minimum_records', value: 12000, unit: 'records', priority: 'required', aliases: [], source_span: null },
    { requirement_id: 'req-wb2-fail-geo', type: 'geography', value: 'Mars', unit: null, priority: 'required', aliases: [], source_span: null },
  ],
  [
    { evidence_id: 'ev-wb2-topic', dataset_id: wb2Id, field: 'topic', value: 'life expectancy', provenance: { source_field_path: 'tags', retrieved_at: '2026-01-14T00:00:00Z' } },
    { evidence_id: 'ev-wb2-time', dataset_id: wb2Id, field: 'time_coverage', value: '1960-2022', provenance: { source_field_path: 'time_coverage', retrieved_at: '2026-01-14T00:00:00Z' } },
    { evidence_id: 'ev-wb2-cols', dataset_id: wb2Id, field: 'columns', value: ['country', 'countryiso3code', 'date', 'value', 'indicator'], provenance: { source_field_path: 'columns', retrieved_at: '2026-01-14T00:00:00Z' } },
    { evidence_id: 'ev-wb2-count', dataset_id: wb2Id, field: 'record_count', value: 15500, provenance: { source_field_path: 'record_count', retrieved_at: '2026-01-14T00:00:00Z' } },
    { evidence_id: 'ev-wb2-geo', dataset_id: wb2Id, field: 'geography', value: 'World', provenance: { source_field_path: 'geography', retrieved_at: '2026-01-14T00:00:00Z' } },
  ]
);

const totalVerdicts = fixtures.reduce((sum, f) => sum + f.expected_verdicts.length, 0);
console.log(`Generated ${fixtures.length} datasets with ${totalVerdicts} total requirement-dataset pairs!`);

const outPath = resolve(process.cwd(), 'evals/verdict-fixtures.json');
writeFileSync(outPath, `${JSON.stringify(fixtures, null, 2)}\n`, 'utf8');
console.log(`Saved to ${outPath}`);

