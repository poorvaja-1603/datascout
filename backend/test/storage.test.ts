import { describe, expect, it, beforeEach } from 'vitest';
import {
  InMemoryResultsStore,
  InMemoryDatasetsStore,
} from '../src/storage/index.js';
import searchResultsFixture from '../../contracts/fixtures/search-results.json' with { type: 'json' };
import datasetDetailFixture from '../../contracts/fixtures/dataset-detail.json' with { type: 'json' };
import type { DatasetDetail } from '@datascout/contracts';

describe('InMemoryStorage', () => {
  let resultsStore: InMemoryResultsStore;
  let datasetsStore: InMemoryDatasetsStore;

  beforeEach(() => {
    resultsStore = new InMemoryResultsStore();
    datasetsStore = new InMemoryDatasetsStore();
  });

  describe('InMemoryResultsStore', () => {
    it('stores and retrieves a search result', async () => {
      const response = {
        ...searchResultsFixture,
        request_id: 'req-storage-1',
      };
      await resultsStore.putResult('req-storage-1', 'user-1', response, 3600);

      const stored = await resultsStore.getResult('req-storage-1');
      expect(stored).not.toBeNull();
      expect(stored?.requestId).toBe('req-storage-1');
      expect(stored?.ownerSub).toBe('user-1');
      expect(stored?.searchResponse.request_id).toBe('req-storage-1');
    });

    it('treats expired items as missing (ttl <= now)', async () => {
      const response = {
        ...searchResultsFixture,
        request_id: 'req-expired-1',
      };
      // ttlSeconds negative so ttl is in the past
      await resultsStore.putResult('req-expired-1', 'user-1', response, -10);

      const stored = await resultsStore.getResult('req-expired-1');
      expect(stored).toBeNull();
    });

    it('prevents overwrite and throws internal_error on duplicate request_id', async () => {
      const response = {
        ...searchResultsFixture,
        request_id: 'req-duplicate-1',
      };
      await resultsStore.putResult('req-duplicate-1', 'user-1', response, 3600);

      await expect(
        resultsStore.putResult('req-duplicate-1', 'user-2', response, 3600),
      ).rejects.toThrow('Result with this request_id already exists.');
    });

    it('returns null for non-existent item', async () => {
      const stored = await resultsStore.getResult('req-does-not-exist');
      expect(stored).toBeNull();
    });
  });

  describe('InMemoryDatasetsStore', () => {
    const sampleDataset = datasetDetailFixture as DatasetDetail;

    it('puts and gets dataset detail', async () => {
      await datasetsStore.putDataset(sampleDataset);
      const retrieved = await datasetsStore.getDataset(
        sampleDataset.dataset.dataset_id,
      );
      expect(retrieved).not.toBeNull();
      expect(retrieved?.dataset.dataset_id).toBe(
        sampleDataset.dataset.dataset_id,
      );
    });

    it('batch retrieves datasets', async () => {
      await datasetsStore.putDataset(sampleDataset);
      const results = await datasetsStore.batchGetDatasets([
        sampleDataset.dataset.dataset_id,
        'datagovin:nonexistent-id',
      ]);
      expect(results).toHaveLength(1);
      expect(results[0].dataset.dataset_id).toBe(
        sampleDataset.dataset.dataset_id,
      );
    });
  });
});
