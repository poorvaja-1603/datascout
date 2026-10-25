import { describe, expect, it, vi } from 'vitest';
import {
  DataGovInConnector,
  isValidNativeId,
  type CachedCatalogEntry,
} from '../src/datagovin/connector.js';
import * as safeFetchModule from '../src/toolkit/safe-fetch.js';
import type { CallContext, ConnectorSearchRequest, Dataset, InspectionLimits } from '@datascout/contracts';

function createMockContext(signal?: AbortSignal): CallContext {
  return {
    requestId: 'test-req-gov',
    signal: signal ?? new AbortController().signal,
    deadlineMs: Date.now() + 10000,
    tracer: {
      trace: vi.fn(),
      span: vi.fn(() => ({ end: vi.fn() })),
    } as unknown as CallContext['tracer'],
  };
}

const CANARY_KEY = 'CANARY_KEY_SEC_998877_XYZ';

describe('DataGovInConnector', () => {
  describe('Native ID Validation', () => {
    it('validates UUIDs, numeric IDs, and kebab-case slugs', () => {
      expect(isValidNativeId('9ef84268-d588-465a-a308-a864a43d0070')).toBe(true);
      expect(isValidNativeId('crop-yield-maharashtra-resource-01')).toBe(true);
      expect(isValidNativeId('1234')).toBe(true);
      expect(isValidNativeId('census_data_2021')).toBe(true);
    });

    it('rejects path traversal, spaces, query strings, and control characters', () => {
      expect(isValidNativeId('../etc/passwd')).toBe(false);
      expect(isValidNativeId('/resource/123')).toBe(false);
      expect(isValidNativeId('id with spaces')).toBe(false);
      expect(isValidNativeId('id?query=test')).toBe(false);
      expect(isValidNativeId('')).toBe(false);
      expect(isValidNativeId('..')).toBe(false);
    });
  });

  describe('Search', () => {
    it('returns disabled source status when no API key is configured', async () => {
      const connector = new DataGovInConnector({ apiKey: undefined, cachedCatalog: [] });
      const req: ConnectorSearchRequest = {
        requirements: {
          topic: 'agriculture',
          geography: null,
          time_coverage: null,
          minimum_records: null,
          required_features: [],
          target: null,
          preferences: [],
          constraints: [],
        },
        derived: [],
        maxResults: 10,
      };

      const result = await connector.search(req, createMockContext());
      expect(result.source).toBe('datagovin');
      expect(result.status.status).toBe('disabled');
      expect(result.status.result_count).toBe(0);
      expect(result.status.warning).toContain('API key is not configured');
      expect(result.datasets).toHaveLength(0);
    });

    it('returns partial status with warning when cached catalog is empty', async () => {
      const connector = new DataGovInConnector({ apiKey: 'VALID_KEY', cachedCatalog: [] });
      const req: ConnectorSearchRequest = {
        requirements: {
          topic: 'agriculture',
          geography: null,
          time_coverage: null,
          minimum_records: null,
          required_features: [],
          target: null,
          preferences: [],
          constraints: [],
        },
        derived: [],
        maxResults: 10,
      };

      const result = await connector.search(req, createMockContext());
      expect(result.status.status).toBe('partial');
      expect(result.status.result_count).toBe(0);
      expect(result.status.warning).toContain('catalog index is empty');
      expect(result.datasets).toHaveLength(0);
    });

    it('searches cached catalog locally and never invents fields or licenses', async () => {
      const cachedCatalog: CachedCatalogEntry[] = [
        {
          id: 'crop-yield-maharashtra-resource-01',
          title: 'District-wise Crop Production Statistics in Maharashtra',
          desc: 'Agricultural yield, rainfall and season wise production data',
          sector: 'Agriculture',
        },
        {
          id: 'transport-stats-resource-02',
          title: 'National Highway Road Accidents',
          desc: 'Transport department survey statistics',
          sector: 'Transport',
        },
      ];

      const connector = new DataGovInConnector({
        apiKey: 'VALID_KEY',
        cachedCatalog,
      });

      const req: ConnectorSearchRequest = {
        requirements: {
          topic: 'crop production',
          geography: 'Invented User Geography', // Must NOT be adopted
          time_coverage: null,
          minimum_records: null,
          required_features: [],
          target: null,
          preferences: [],
          constraints: [],
        },
        derived: [],
        maxResults: 10,
      };

      const result = await connector.search(req, createMockContext());

      expect(result.status.status).toBe('success');
      expect(result.datasets).toHaveLength(1);
      const dataset = result.datasets[0]!;
      expect(dataset.dataset_id).toBe('datagovin:crop-yield-maharashtra-resource-01');
      expect(dataset.title).toContain('Crop Production Statistics');

      // Assert no invented fields
      expect(dataset.geography).toBeNull(); // Not invented from req.requirements.geography
      expect(dataset.license).toBe('unknown'); // Not hardcoded to GODL
      expect(dataset.access_type).toBeNull(); // Not assumed 'open'
      expect(dataset.file_formats).toEqual([]); // Not assumed ['csv']
      expect(dataset.record_count).toBeNull(); // Not invented

      // Provenance only for fields actually read
      expect(dataset.provenance['title']?.source_field_path).toBe('catalog.title');
      expect(dataset.provenance['description']?.source_field_path).toBe('catalog.desc');
      expect(dataset.provenance['tags']?.source_field_path).toBe('catalog.sector');
      expect(dataset.provenance['license']).toBeUndefined();
      expect(dataset.provenance['geography']).toBeUndefined();
    });

    it('does not execute a sample-resource fallback when catalog search yields no match', async () => {
      const fetchSpy = vi.spyOn(safeFetchModule, 'safeFetch');
      const connector = new DataGovInConnector({
        apiKey: 'VALID_KEY',
        cachedCatalog: [
          {
            id: 'transport-01',
            title: 'Bus routes',
            desc: 'Bus routes info',
          },
        ],
      });

      const req: ConnectorSearchRequest = {
        requirements: {
          topic: 'unmatched topic xyz',
          geography: null,
          time_coverage: null,
          minimum_records: null,
          required_features: [],
          target: null,
          preferences: [],
          constraints: [],
        },
        derived: [],
        maxResults: 5,
      };

      const result = await connector.search(req, createMockContext());
      expect(result.status.status).toBe('success');
      expect(result.datasets).toHaveLength(0);
      expect(fetchSpy).not.toHaveBeenCalled();
      vi.restoreAllMocks();
    });
  });

  describe('getDetails', () => {
    it('returns null for invalid datasetId format or path traversal ID', async () => {
      const connector = new DataGovInConnector({ apiKey: 'VALID_KEY' });
      expect(await connector.getDetails('huggingface:123', createMockContext())).toBeNull();
      expect(await connector.getDetails('datagovin:../secret', createMockContext())).toBeNull();
      expect(await connector.getDetails('datagovin:', createMockContext())).toBeNull();
    });

    it('returns dataset from local cache without network call', async () => {
      const fetchSpy = vi.spyOn(safeFetchModule, 'safeFetch');
      const cachedCatalog: CachedCatalogEntry[] = [
        {
          id: 'resource-cached-1',
          title: 'Cached Dataset Title',
          desc: 'Cached Description',
          geography: 'Kerala',
        },
      ];

      const connector = new DataGovInConnector({ apiKey: 'VALID_KEY', cachedCatalog });
      const ds = await connector.getDetails('datagovin:resource-cached-1', createMockContext());

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(ds).not.toBeNull();
      expect(ds?.title).toBe('Cached Dataset Title');
      expect(ds?.geography).toBe('Kerala');
      expect(ds?.license).toBe('unknown');
      expect(ds?.file_formats).toEqual([]);
      vi.restoreAllMocks();
    });

    it('falls back to live API when not in cache and extracts integer total', async () => {
      vi.spyOn(safeFetchModule, 'safeFetch').mockResolvedValueOnce({
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-type': 'application/json' }),
        url: 'https://api.data.gov.in/resource/live-01?api-key=VALID_KEY',
        redactedUrl: 'https://api.data.gov.in/resource/live-01?api-key=%5BREDACTED%5D',
        bytes: async () => new Uint8Array(),
        text: async () => '',
        json: async () => ({
          title: 'Live Resource Data',
          desc: 'Live resource description',
          total: 450,
          field: [{ name: 'district' }, { name: 'population' }],
          records: [{ district: 'Mumbai', population: 12000000 }],
        }),
      });

      const connector = new DataGovInConnector({ apiKey: 'VALID_KEY', cachedCatalog: [] });
      const ds = await connector.getDetails('datagovin:live-01', createMockContext());

      expect(ds).not.toBeNull();
      expect(ds?.title).toBe('Live Resource Data');
      expect(ds?.description).toBe('Live resource description');
      expect(ds?.record_count).toBe(450);
      expect(ds?.columns).toEqual(['district', 'population']);
      expect(ds?.license).toBe('unknown');
      expect(ds?.access_type).toBeNull();
      expect(ds?.file_formats).toEqual([]);
      expect(ds?.verification_level).toBe('metadata_only');
      expect(ds?.provenance['title']?.source_field_path).toBe('resource.title');
      expect(ds?.provenance['record_count']?.source_field_path).toBe('resource.total');
      vi.restoreAllMocks();
    });
  });

  describe('harvestCatalog', () => {
    it('pages through /catalogs, validates native IDs, respects limits, and returns entries', async () => {
      const page1Response = {
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-type': 'application/json' }),
        url: 'https://api.data.gov.in/catalogs',
        redactedUrl: 'https://api.data.gov.in/catalogs',
        bytes: async () =>
          new TextEncoder().encode(
            JSON.stringify({
              records: [
                { id: 'valid-res-1', title: 'Water Quality Survey', desc: 'pH and hardness' },
                { id: '../invalid-res', title: 'Malicious Path ID', desc: 'Should skip' },
                { id: 'valid-res-2', title: 'Power Grid Load', desc: 'Hourly megawatts', sector: 'Power' },
              ],
            }),
          ),
        text: async () => '',
        json: async () => ({}),
      };

      const page2Response = {
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-type': 'application/json' }),
        url: 'https://api.data.gov.in/catalogs',
        redactedUrl: 'https://api.data.gov.in/catalogs',
        bytes: async () =>
          new TextEncoder().encode(
            JSON.stringify({
              records: [
                { id: 'valid-res-3', title: 'Rainfall Statistics', desc: 'Monsoon metrics' },
              ],
            }),
          ),
        text: async () => '',
        json: async () => ({}),
      };

      const fetchSpy = vi.spyOn(safeFetchModule, 'safeFetch')
        .mockResolvedValueOnce(page1Response)
        .mockResolvedValueOnce(page2Response);

      const connector = new DataGovInConnector({ apiBaseUrl: 'https://api.data.gov.in' });
      const harvestResult = await connector.harvestCatalog({
        pageSize: 3,
        maxRecords: 10,
        maxPages: 5,
        pageDelayMs: 10,
      });

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(harvestResult.counts.fetched).toBe(3);
      expect(harvestResult.counts.skipped).toBe(1); // '../invalid-res' was skipped
      expect(harvestResult.datasets).toHaveLength(3);
      expect(harvestResult.rawEntries).toHaveLength(3);
      expect(harvestResult.datasets[0]?.dataset_id).toBe('datagovin:valid-res-1');
      expect(harvestResult.datasets[1]?.dataset_id).toBe('datagovin:valid-res-2');
      expect(harvestResult.datasets[2]?.dataset_id).toBe('datagovin:valid-res-3');

      vi.restoreAllMocks();
    });

    it('stops and emits a warning when maxPages safety cap is reached', async () => {
      const infinitePage = {
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-type': 'application/json' }),
        url: 'https://api.data.gov.in/catalogs',
        redactedUrl: 'https://api.data.gov.in/catalogs',
        bytes: async () =>
          new TextEncoder().encode(
            JSON.stringify({
              records: [{ id: 'p1', title: 'Item 1' }, { id: 'p2', title: 'Item 2' }],
            }),
          ),
        text: async () => '',
        json: async () => ({}),
      };

      vi.spyOn(safeFetchModule, 'safeFetch').mockResolvedValue(infinitePage);

      const connector = new DataGovInConnector();
      const result = await connector.harvestCatalog({
        pageSize: 2,
        maxPages: 2, // Hard cap at 2 pages
        pageDelayMs: 0,
      });

      expect(result.pagesFetched).toBe(2);
      expect(result.warnings.some((w) => w.includes('maximum page limit of 2'))).toBe(true);
      vi.restoreAllMocks();
    });
  });

  describe('Resource Sampling & inspectSample', () => {
    it('handles CSV response even when format=json was requested (quirk workaround)', async () => {
      const csvData = 'district,cases,cured\nSolapur,120,115\nSatara,98,92\n';
      vi.spyOn(safeFetchModule, 'safeFetch').mockResolvedValueOnce({
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-type': 'text/csv' }),
        url: `https://api.data.gov.in/resource/health-01?api-key=${CANARY_KEY}&format=json`,
        redactedUrl: 'https://api.data.gov.in/resource/health-01?api-key=%5BREDACTED%5D',
        bytes: async () => new TextEncoder().encode(csvData),
        text: async () => csvData,
        json: async () => ({}),
      });

      const connector = new DataGovInConnector({ apiKey: CANARY_KEY });
      const sample = await connector.fetchResourceSample({
        nativeId: 'health-01',
        limit: 10,
        filters: { DistrictName: 'Solapur' }, // Verify case preservation
      });

      expect(sample.format).toBe('csv');
      expect(sample.columns).toEqual(['district', 'cases', 'cured']);
      expect(sample.records).toHaveLength(2);
      expect(sample.records[0]).toEqual({ district: 'Solapur', cases: '120', cured: '115' });
      vi.restoreAllMocks();
    });

    it('inspects sample through inspectSample with bounded inspector', async () => {
      const jsonData = JSON.stringify({
        title: 'District School Enrollment',
        desc: 'Primary and secondary enrollments',
        total: 100,
        records: [
          { school_id: 'S101', students: 450, pass_rate: 94.5 },
          { school_id: 'S102', students: 380, pass_rate: 89.2 },
        ],
      });

      vi.spyOn(safeFetchModule, 'safeFetch').mockResolvedValueOnce({
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-type': 'application/json' }),
        url: `https://api.data.gov.in/resource/edu-01?api-key=${CANARY_KEY}`,
        redactedUrl: 'https://api.data.gov.in/resource/edu-01?api-key=%5BREDACTED%5D',
        bytes: async () => new TextEncoder().encode(jsonData),
        text: async () => jsonData,
        json: async () => JSON.parse(jsonData),
      });

      const connector = new DataGovInConnector({ apiKey: CANARY_KEY });
      const dataset: Dataset = {
        dataset_id: 'datagovin:edu-01',
        source: 'datagovin',
        source_url: 'https://data.gov.in/resource/edu-01',
        title: 'District School Enrollment',
        description: null,
        license: null,
        access_type: null,
        api_endpoint: 'https://api.data.gov.in/resource/edu-01',
        file_formats: [],
        record_count: 100,
        columns: [],
        geography: null,
        time_coverage: null,
        tags: [],
        last_updated: null,
        retrieved_at: new Date().toISOString(),
        raw_snapshot_key: null,
        verification_level: 'metadata_only',
        provenance: {},
      };

      const limits: InspectionLimits = {
        maxBytes: 1024 * 1024,
        maxRows: 50,
        maxColumns: 20,
        timeoutMs: 5000,
      };

      const inspection = await connector.inspectSample(dataset, limits, createMockContext());
      expect(inspection.status).toBe('ok');
      expect(inspection.verificationLevel).toBe('sample_checked');
      expect(inspection.rowsExamined).toBe(2);
      expect(inspection.columns.map((c) => c.name)).toEqual(['school_id', 'students', 'pass_rate']);
      vi.restoreAllMocks();
    });
  });

  describe('Security and Canary Redaction', () => {
    it('guarantees that API key never appears in error messages when safeFetch throws', async () => {
      vi.spyOn(safeFetchModule, 'safeFetch').mockImplementationOnce(async (url) => {
        // Intentionally throw an error that contains the full URL with CANARY_KEY
        throw new Error(`Connection failed to endpoint: ${url}`);
      });

      const connector = new DataGovInConnector({ apiKey: CANARY_KEY });

      let caughtError: Error | null = null;
      try {
        await connector.fetchResourceSample({ nativeId: 'secret-res-01' });
      } catch (err: unknown) {
        caughtError = err as Error;
      }

      expect(caughtError).not.toBeNull();
      // Crucial assertion: the canary secret MUST NOT be present in the error message
      expect(caughtError?.message).not.toContain(CANARY_KEY);
      expect(caughtError?.message).toContain('[REDACTED]');

      vi.restoreAllMocks();
    });

    it('redacts canary key in catalog harvest failures', async () => {
      vi.spyOn(safeFetchModule, 'safeFetch').mockImplementationOnce(async (url) => {
        throw new Error(`Upstream 429 received from: ${url}`);
      });

      const connector = new DataGovInConnector({ apiKey: CANARY_KEY });
      const harvest = await connector.harvestCatalog({ maxPages: 1 });

      expect(harvest.counts.failed).toBe(1);
      expect(harvest.warnings).toHaveLength(1);
      const warningText = harvest.warnings[0]!;
      expect(warningText).not.toContain(CANARY_KEY);
      expect(warningText).toContain('[REDACTED]');

      vi.restoreAllMocks();
    });
  });
});
