import type { ResultsStore } from './results-store.js';
import type { DatasetsStore } from './datasets-store.js';
import { DynamoDbResultsStore, InMemoryResultsStore } from './results-store.js';
import {
  DynamoDbDatasetsStore,
  InMemoryDatasetsStore,
} from './datasets-store.js';

let resultsStoreInstance: ResultsStore | null = null;
let datasetsStoreInstance: DatasetsStore | null = null;

function isTestEnvironment(): boolean {
  return (
    process.env.NODE_ENV === 'test' ||
    process.env.VITEST === 'true' ||
    Boolean(process.env.VITEST)
  );
}

export function getResultsStore(): ResultsStore {
  if (!resultsStoreInstance) {
    if (isTestEnvironment()) {
      resultsStoreInstance = new InMemoryResultsStore();
    } else {
      resultsStoreInstance = new DynamoDbResultsStore();
    }
  }
  return resultsStoreInstance;
}

export function setResultsStore(store: ResultsStore | null): void {
  resultsStoreInstance = store;
}

export function getDatasetsStore(): DatasetsStore {
  if (!datasetsStoreInstance) {
    if (isTestEnvironment()) {
      datasetsStoreInstance = new InMemoryDatasetsStore();
    } else {
      datasetsStoreInstance = new DynamoDbDatasetsStore();
    }
  }
  return datasetsStoreInstance;
}

export function setDatasetsStore(store: DatasetsStore | null): void {
  datasetsStoreInstance = store;
}
