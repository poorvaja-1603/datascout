import { describe, expect, it, vi } from 'vitest';
import { DataGovInConnector } from '../src/datagovin/connector.js';
import * as safeFetchModule from '../src/toolkit/safe-fetch.js';
import type { CallContext, ConnectorSearchRequest } from '@datascout/contracts';

function createMockContext(): CallContext {
  return {
    requestId: 'test-req-gov',
    signal: new AbortController().signal,
    deadlineMs: Date.now() + 10000,
    tracer: {
      trace: vi.fn(),
      span: vi.fn(() => ({ end: vi.fn() })),
    } as unknown as CallContext['tracer'],
  };
}

describe('DataGovInConnector', () => {
  it('searches cached catalog index locally when full-text search is invoked', async () => {
    const cachedCatalog = [
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

    const connector = new DataGovInConnector({ cachedCatalog });
    const req: ConnectorSearchRequest = {
      requirements: {
        topic: 'crop production',
        geography: 'Maharashtra',
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
    expect(result.status.status).toBe('success');
    expect(result.datasets).toHaveLength(1);
    const dataset = result.datasets[0]!;
    expect(dataset.dataset_id).toBe(
      'datagovin:crop-yield-maharashtra-resource-01',
    );
    expect(dataset.title).toContain('Crop Production Statistics');
    expect(dataset.geography).toBe('Maharashtra');
    expect(dataset.api_endpoint).not.toContain('api-key=');
  });

  it('redacts api-key query parameters when hitting resource API', async () => {
    vi.spyOn(safeFetchModule, 'safeFetch').mockResolvedValueOnce({
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'application/json' }),
      url: 'https://api.data.gov.in/resource/1234?api-key=SECRET_KEY_123',
      redactedUrl:
        'https://api.data.gov.in/resource/1234?api-key=%5BREDACTED%5D',
      bytes: async () => new Uint8Array(),
      text: async () =>
        JSON.stringify({
          title: 'Live Crop Resource',
          desc: 'Crop metrics',
          records: [{ district: 'Pune', yield: 120 }],
        }),
      json: async () => ({
        title: 'Live Crop Resource',
        desc: 'Crop metrics',
        records: [{ district: 'Pune', yield: 120 }],
      }),
    });

    const connector = new DataGovInConnector({
      apiKey: 'SECRET_KEY_123',
      cachedCatalog: [],
    });

    const req: ConnectorSearchRequest = {
      requirements: {
        topic: 'crop',
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

    expect(result.datasets).toHaveLength(1);
    const ds = result.datasets[0]!;
    expect(ds.api_endpoint).not.toContain('SECRET_KEY_123');
    expect(ds.columns).toEqual(['district', 'yield']);

    vi.restoreAllMocks();
  });
});
