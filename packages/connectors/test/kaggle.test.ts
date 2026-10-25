import { describe, expect, it, vi } from 'vitest';
import { KaggleConnector } from '../src/kaggle/connector.js';
import * as safeFetchModule from '../src/toolkit/safe-fetch.js';
import type { CallContext, ConnectorSearchRequest } from '@datascout/contracts';

function createMockContext(): CallContext {
  return {
    requestId: 'test-req-kaggle',
    signal: new AbortController().signal,
    deadlineMs: Date.now() + 10000,
    tracer: {
      trace: vi.fn(),
      span: vi.fn(() => ({ end: vi.fn() })),
    } as unknown as CallContext['tracer'],
  };
}

describe('KaggleConnector', () => {
  it('searches Kaggle datasets and parses canonical metadata', async () => {
    const mockKaggleItems = [
      {
        id: 12345,
        ref: 'researcher/climate-change-india',
        title: 'Climate Change India',
        subtitle: 'Annual temperature and rainfall from 1901 to 2021',
        url: 'https://www.kaggle.com/datasets/researcher/climate-change-india',
        licenseName: 'CC-BY-4.0',
        lastUpdated: '2026-02-15T10:00:00Z',
        isPrivate: false,
        tags: [
          { name: 'india', ref: 'india' },
          { name: 'climate', ref: 'climate' },
        ],
      },
      {
        id: 99999,
        ref: 'user/private-data',
        title: 'Private Survey',
        isPrivate: true,
      },
    ];

    vi.spyOn(safeFetchModule, 'safeFetch').mockImplementation(async (url) => {
      const urlStr = url.toString();
      if (urlStr.includes('/datasets/list?')) {
        return {
          status: 200,
          statusText: 'OK',
          headers: new Headers({ 'content-type': 'application/json' }),
          url: urlStr,
          ok: true,
          json: async () => mockKaggleItems,
          text: async () => JSON.stringify(mockKaggleItems),
          bytes: async () => new Uint8Array(),
        } as unknown as ReturnType<typeof safeFetchModule.safeFetch>;
      }
      return {
        status: 404,
        statusText: 'Not Found',
        headers: new Headers(),
        url: urlStr,
        ok: false,
      } as unknown as ReturnType<typeof safeFetchModule.safeFetch>;
    });

    const connector = new KaggleConnector({ apiToken: 'KGAT_test' });
    const req: ConnectorSearchRequest = {
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
      maxResults: 10,
    };

    const res = await connector.search(req, createMockContext());
    expect(res.source).toBe('kaggle');
    expect(res.status.status).toBe('success');
    expect(res.datasets).toHaveLength(1);

    const ds = res.datasets[0]!;
    expect(ds.dataset_id).toBe('kaggle:researcher/climate-change-india');
    expect(ds.source).toBe('kaggle');
    expect(ds.title).toBe('Climate Change India');
    expect(ds.description).toContain('Annual temperature');
    expect(ds.license).toBe('CC-BY-4.0');
    expect(ds.tags).toContain('india');
    expect(ds.tags).toContain('climate');
  });

  it('fetches dataset details using native ID', async () => {
    const mockDetail = {
      id: 12345,
      ref: 'researcher/climate-change-india',
      title: 'Climate Change India',
      description: 'Comprehensive annual temperature dataset',
      url: 'https://www.kaggle.com/datasets/researcher/climate-change-india',
      licenseName: 'CC-BY-4.0',
      lastUpdated: '2026-02-15T10:00:00Z',
      isPrivate: false,
      tags: [{ name: 'environment' }],
    };

    vi.spyOn(safeFetchModule, 'safeFetch').mockImplementation(async (url) => {
      const urlStr = url.toString();
      if (urlStr.includes('/datasets/view/researcher/climate-change-india')) {
        return {
          status: 200,
          statusText: 'OK',
          headers: new Headers({ 'content-type': 'application/json' }),
          url: urlStr,
          ok: true,
          json: async () => mockDetail,
          text: async () => JSON.stringify(mockDetail),
          bytes: async () => new Uint8Array(),
        } as unknown as ReturnType<typeof safeFetchModule.safeFetch>;
      }
      return {
        status: 404,
        statusText: 'Not Found',
        headers: new Headers(),
        url: urlStr,
        ok: false,
      } as unknown as ReturnType<typeof safeFetchModule.safeFetch>;
    });

    const connector = new KaggleConnector();
    const ds = await connector.getDetails(
      'kaggle:researcher/climate-change-india',
      createMockContext(),
    );
    expect(ds).not.toBeNull();
    expect(ds?.dataset_id).toBe('kaggle:researcher/climate-change-india');
    expect(ds?.title).toBe('Climate Change India');
    expect(ds?.license).toBe('CC-BY-4.0');
  });
});
