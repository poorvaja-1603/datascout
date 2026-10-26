import { describe, expect, it } from 'vitest';
import { S3SnapshotStore } from '../src/storage/s3-snapshot-store.js';
import { EventBridgeBus } from '../src/storage/eventbridge-bus.js';
import { Ec2DatasetWorker } from '../src/workers/ec2-dataset-worker.js';

describe('AWS S3, EventBridge, and EC2 Worker Integration', () => {
  it('stores dataset and catalog snapshots in S3 with stable keys', async () => {
    const s3 = new S3SnapshotStore();

    // 1. Dataset snapshot
    const datasetKey = await s3.saveDatasetSnapshot('kaggle:climate/rainfall-australia', {
      title: 'Rainfall in Australia',
      rows: 142193,
      verified: true,
    });
    expect(datasetKey).toContain('snapshots/kaggle/climate/rainfall-australia/snapshot.json');

    const readBack = await s3.getObject(datasetKey!);
    expect(readBack).toContain('Rainfall in Australia');

    // 2. Catalog harvest snapshot
    const harvestKey = await s3.saveCatalogHarvest('datagovin', [
      { id: '1', title: 'Crop Production' },
    ]);
    expect(harvestKey).toContain('catalog-harvests/datagovin/');
  });

  it('publishes domain events to EventBridge', async () => {
    const bus = new EventBridgeBus();

    const published = await bus.publishDomainEvent('CatalogHarvestCompleted', {
      source: 'datagovin',
      recordsHarvested: 500,
    });
    expect(published).toBe(true);

    const recent = bus.getRecentEvents();
    expect(recent.some((e) => e.detailType === 'CatalogHarvestCompleted')).toBe(true);
  });

  it('executes deep dataset inspection on EC2 worker and saves S3 artifact', async () => {
    const worker = new Ec2DatasetWorker();

    const result = await worker.processInspection({
      datasetId: 'kaggle:waqi786/usa-rainfall-prediction-dataset',
      maxSampleBytes: 10 * 1024 * 1024,
    });

    expect(result.status).toBe('completed');
    expect(result.s3ArtifactKey).toContain('deep-inspections/kaggle/waqi786/usa-rainfall-prediction-dataset');
    expect(result.columnsDetected).toContain('target');
  });
});
