import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { CallContext, ConnectorSearchRequest } from '@datascout/contracts';
import * as safeFetchModule from '../src/toolkit/safe-fetch.js';
import {
  CkanConnector,
  DataverseConnector,
  UciConnector,
  ZenodoConnector,
} from '../src/extras/index.js';
import { OpenMLConnector } from '../src/openml/connector.js';
import { WorldBankConnector } from '../src/worldbank/connector.js';

function context(): CallContext {
  return {
    requestId: 'extras-test',
    signal: new AbortController().signal,
    deadlineMs: Date.now() + 10000,
    tracer: {
      trace: vi.fn(),
      span: vi.fn(() => ({ end: vi.fn() })),
    } as unknown as CallContext['tracer'],
  };
}
const request: ConnectorSearchRequest = {
  requirements: {
    topic: 'climate',
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
function response(body: unknown, status = 200) {
  return {
    status,
    statusText: 'OK',
    headers: new Headers({ 'content-type': 'application/json' }),
    url: '',
    redactedUrl: '',
    bytes: async () => new Uint8Array(),
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as Awaited<ReturnType<typeof safeFetchModule.safeFetch>>;
}
function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'),
  ) as unknown;
}

afterEach(() => vi.restoreAllMocks());

describe('optional catalog connectors', () => {
  it('keeps all optional sources disabled until an explicit feature flag is enabled', async () => {
    const connectors = [
      new UciConnector(),
      new ZenodoConnector(),
      new DataverseConnector(),
      new CkanConnector({ portals: [] }),
    ];
    for (const connector of connectors) {
      const result = await connector.search(request, context());
      expect(result.status.status).toBe('disabled');
      expect(result.datasets).toEqual([]);
    }
  });

  it('maps OpenML descriptions, features, and qualities from bounded metadata requests', async () => {
    vi.spyOn(safeFetchModule, 'safeFetch').mockImplementation(
      async (target) => {
        const url = String(target);
        if (url.includes('/data/list'))
          return response(fixture('extras-openml-list.json'));
        if (url.includes('/data/qualities/'))
          return response(fixture('extras-openml-qualities.json'));
        if (url.includes('/data/features/'))
          return response(fixture('extras-openml-features.json'));
        return response(fixture('extras-openml-detail.json'));
      },
    );
    const result = await new OpenMLConnector().search(request, context());
    expect(result.datasets[0]).toMatchObject({
      dataset_id: 'openml:7',
      record_count: 120,
      columns: ['temperature', 'rainfall'],
      verification_level: 'metadata_only',
    });
  });

  it('maps World Bank country-year indicator results and marks their grain', async () => {
    vi.spyOn(safeFetchModule, 'safeFetch').mockResolvedValue(
      response(fixture('extras-worldbank-indicators.json')),
    );
    const result = await new WorldBankConnector().search(request, context());
    expect(result.datasets[0]).toMatchObject({
      dataset_id: 'worldbank:CLIMATE.TEMP.ANNUAL',
      record_count: null,
      columns: ['country', 'year', 'value'],
      verification_level: 'metadata_only',
    });
    expect(result.datasets[0]?.description).toContain('country-year values');
  });

  it('maps UCI variable metadata and authoritative catalog fields without fetching data files', async () => {
    const fetch = vi
      .spyOn(safeFetchModule, 'safeFetch')
      .mockImplementation(async (target) => {
        const url = String(target);
        if (url.includes('/datasets/list'))
          return response(fixture('extras-uci-list.json'));
        return response(fixture('extras-uci-detail.json'));
      });
    const result = await new UciConnector({
      enabled: true,
      baseUrl: 'https://archive.ics.uci.edu/api',
    }).search(request, context());
    expect(result.status.status).toBe('success');
    expect(result.datasets[0]).toMatchObject({
      dataset_id: 'uci:42',
      record_count: 120,
      columns: ['temperature', 'rainfall'],
      verification_level: 'metadata_only',
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(String(fetch.mock.calls[1]?.[0])).toContain('/dataset?id=42');
  });

  it('returns a visible source failure for a failed UCI catalog request', async () => {
    vi.spyOn(safeFetchModule, 'safeFetch').mockRejectedValue(
      new Error('catalog unavailable'),
    );
    const result = await new UciConnector({ enabled: true }).search(
      request,
      context(),
    );
    expect(result.status.status).toBe('failed');
    expect(result.status.warning).toContain('catalog unavailable');
    expect(result.datasets).toEqual([]);
  });

  it('maps Zenodo records, format metadata, and access rights without downloading files', async () => {
    vi.spyOn(safeFetchModule, 'safeFetch').mockResolvedValue(
      response(fixture('extras-zenodo-search.json')),
    );
    const result = await new ZenodoConnector({ enabled: true }).search(
      request,
      context(),
    );
    expect(result.datasets[0]).toMatchObject({
      dataset_id: 'zenodo:771',
      license: 'CC-BY-4.0',
      access_type: 'open',
      file_formats: ['csv'],
      verification_level: 'metadata_only',
    });
  });

  it('maps published Dataverse datasets and rejects records containing restricted files', async () => {
    vi.spyOn(safeFetchModule, 'safeFetch').mockImplementation(
      async (target) => {
        const url = String(target);
        if (url.includes('/api/search'))
          return response(fixture('extras-dataverse-search.json'));
        return response(fixture('extras-dataverse-detail.json'));
      },
    );
    const result = await new DataverseConnector({
      enabled: true,
      baseUrl: 'https://dataverse.harvard.edu',
    }).search(request, context());
    expect(result.datasets[0]).toMatchObject({
      dataset_id: 'dataverse:100',
      source_url:
        'https://dataverse.harvard.edu/dataset.xhtml?persistentId=doi%3A10.7017%2FEXAMPLE',
      file_formats: ['csv'],
    });
  });

  it('omits Dataverse search results when any advertised file is restricted', async () => {
    vi.spyOn(safeFetchModule, 'safeFetch').mockImplementation(
      async (target) => {
        if (String(target).includes('/api/search'))
          return response(fixture('extras-dataverse-search.json'));
        return response({
          data: {
            datasetPersistentId: 'doi:10.7017/EXAMPLE',
            metadataBlocks: {
              citation: {
                fields: [{ typeName: 'title', value: 'Climate survey' }],
              },
            },
            files: [{ dataFile: { filename: 'survey.csv', restricted: true } }],
          },
        });
      },
    );
    const result = await new DataverseConnector({ enabled: true }).search(
      request,
      context(),
    );
    expect(result.status.status).toBe('success');
    expect(result.datasets).toEqual([]);
  });

  it('keeps CKAN portals host-scoped and reports partial results when a configured portal fails', async () => {
    vi.spyOn(safeFetchModule, 'safeFetch').mockImplementation(
      async (target) => {
        const url = String(target);
        if (url.includes('one.example'))
          return response(fixture('extras-ckan-search.json'));
        throw new Error('portal unavailable');
      },
    );
    const connector = new CkanConnector({
      enabled: true,
      portals: [
        { id: 'one', baseUrl: 'https://one.example' },
        { id: 'two', baseUrl: 'https://two.example' },
      ],
    });
    const result = await connector.search(request, context());
    expect(result.status.status).toBe('partial');
    expect(result.datasets[0]?.dataset_id).toBe('ckan:one/123');
    expect(result.status.warning).toContain('1 configured CKAN portal failed');
  });
});
