import type { ScheduledEvent } from 'aws-lambda';
import { DataGovInConnector } from '@datascout/connectors';
import type { CatalogStore } from '../storage/catalog-store.js';
import { DynamoDbCatalogStore } from '../storage/catalog-store.js';
import { loadRuntimeSecret } from '../secrets.js';
import { getS3SnapshotStore } from '../storage/s3-snapshot-store.js';
import { getEventBridgeBus } from '../storage/eventbridge-bus.js';

export interface RefreshResult {
  status: 'completed' | 'failed' | 'partial';
  timestamp: string;
  sourcesProcessed: string[];
  sourceStatuses: Record<
    string,
    { status: string; records: number; warning?: string }
  >;
  recordsHarvested: number;
}

export function createRefreshHandler(
  dependencies: {
    connector?: Pick<DataGovInConnector, 'harvestCatalog'>;
    store?: CatalogStore;
  } = {},
): (event: ScheduledEvent) => Promise<RefreshResult> {
  return async (event) => {
    const timestamp = event.time || new Date().toISOString();
    const maxRecords = boundedInteger(
      process.env.REFRESH_MAX_RECORDS,
      1000,
      1,
      10_000,
    );
    const store = dependencies.store ?? new DynamoDbCatalogStore();
    const sourceStatus: Record<
      string,
      { status: string; records: number; warning?: string }
    > = {};
    let recordsHarvested = 0;
    try {
      const apiKey = dependencies.connector
        ? undefined
        : await loadRuntimeSecret(
            'DATAGOVIN_API_KEY_SECRET_ARN',
            'DATAGOVIN_API_KEY',
          );
      const connector =
        dependencies.connector ??
        new DataGovInConnector(apiKey ? { apiKey } : {});
      const harvested = await connector.harvestCatalog({
        maxRecords,
        pageSize: boundedInteger(process.env.REFRESH_PAGE_SIZE, 100, 1, 1000),
        maxPages: boundedInteger(process.env.REFRESH_MAX_PAGES, 20, 1, 100),
        maxBytes: boundedInteger(
          process.env.REFRESH_MAX_BYTES,
          8 * 1024 * 1024,
          1024,
          20 * 1024 * 1024,
        ),
        pageDelayMs: boundedInteger(
          process.env.REFRESH_PAGE_DELAY_MS,
          250,
          0,
          10_000,
        ),
      });
      await store.replaceSource('datagovin', harvested.rawEntries);
      recordsHarvested = harvested.rawEntries.length;

      const s3Store = getS3SnapshotStore();
      const s3HarvestKey = await s3Store.saveCatalogHarvest(
        'datagovin',
        harvested.rawEntries,
      );
      const bus = getEventBridgeBus();
      await bus.publishDomainEvent('CatalogHarvestCompleted', {
        source: 'datagovin',
        recordsHarvested,
        s3SnapshotKey: s3HarvestKey,
        status: harvested.counts.failed ? 'partial' : 'success',
      });

      sourceStatus.datagovin = {
        status: harvested.counts.failed
          ? recordsHarvested
            ? 'partial'
            : 'failed'
          : 'success',
        records: recordsHarvested,
        ...(harvested.warnings.length
          ? { warning: harvested.warnings.slice(0, 4).join(' ') }
          : {}),
      };
    } catch {
      sourceStatus.datagovin = {
        status: 'failed',
        records: 0,
        warning: 'Catalog refresh failed.',
      };
    }
    // Persist the actual refresh outcome for search responses and operational review.
    const datagovinStatus = sourceStatus.datagovin ?? {
      status: 'failed',
      records: 0,
    };
    try {
      await store.putRefreshStatus('datagovin', {
        status: datagovinStatus.status as 'success' | 'partial' | 'failed',
        records: datagovinStatus.records,
        timestamp,
        ...(datagovinStatus.warning
          ? { warning: datagovinStatus.warning }
          : {}),
      });
    } catch {
      sourceStatus.datagovin = {
        ...datagovinStatus,
        status: 'partial',
        warning: 'Catalog harvested but refresh status could not be stored.',
      };
    }
    const status =
      sourceStatus.datagovin?.status === 'success'
        ? 'completed'
        : sourceStatus.datagovin?.status === 'partial'
          ? 'partial'
          : 'failed';
    console.info(
      JSON.stringify({
        event: 'catalog_refresh',
        timestamp,
        sources: sourceStatus,
        recordsHarvested,
      }),
    );
    return {
      status,
      timestamp,
      sourcesProcessed: ['datagovin'],
      sourceStatuses: sourceStatus,
      recordsHarvested,
    };
  };
}

export const handler = createRefreshHandler();

function boundedInteger(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!value || !/^\d+$/.test(value)) return fallback;
  return Math.min(max, Math.max(min, Number(value)));
}
