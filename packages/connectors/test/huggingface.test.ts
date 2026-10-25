import { describe, expect, it, vi } from 'vitest';
import { HuggingFaceConnector } from '../src/huggingface/connector.js';
import * as safeFetchModule from '../src/toolkit/safe-fetch.js';
import type { CallContext, ConnectorSearchRequest } from '@datascout/contracts';

function createMockContext(): CallContext {
  return {
    requestId: 'test-req-hf',
    signal: new AbortController().signal,
    deadlineMs: Date.now() + 10000,
    tracer: {
      trace: vi.fn(),
      span: vi.fn(() => ({ end: vi.fn() })),
    } as unknown as CallContext['tracer'],
  };
}

describe('HuggingFaceConnector', () => {
  it('searches Hugging Face datasets and parses canonical metadata', async () => {
    const mockHubItems = [
      {
        id: 'owner/crop-yield',
        description: 'Indian crop yield dataset for Maharashtra',
        tags: ['tabular', 'agriculture'],
        license: 'mit',
        lastModified: '2026-01-10T12:00:00Z',
        gated: false,
        private: false,
      },
      {
        id: 'owner/gated-dataset',
        description: 'Private research dataset',
        tags: ['biology'],
        gated: true,
      },
    ];

    const mockInfo = {
      dataset_info: {
        default: {
          features: {
            district: { dtype: 'string' },
            rainfall: { dtype: 'float32' },
            yield: { dtype: 'float32' },
          },
          splits: {
            train: { num_examples: 2500 },
          },
        },
      },
    };

    vi.spyOn(safeFetchModule, 'safeFetch').mockImplementation(async (url) => {
      const urlStr = url.toString();
      if (urlStr.includes('/datasets?')) {
        return {
          status: 200,
          statusText: 'OK',
          headers: new Headers({ 'content-type': 'application/json' }),
          url: urlStr,
          redactedUrl: urlStr,
          bytes: async () => new Uint8Array(),
          text: async () => JSON.stringify(mockHubItems),
          json: async () => mockHubItems,
        };
      }
      if (urlStr.includes('/info?')) {
        return {
          status: 200,
          statusText: 'OK',
          headers: new Headers({ 'content-type': 'application/json' }),
          url: urlStr,
          redactedUrl: urlStr,
          bytes: async () => new Uint8Array(),
          text: async () => JSON.stringify(mockInfo),
          json: async () => mockInfo,
        };
      }
      return {
        status: 404,
        statusText: 'Not Found',
        headers: new Headers(),
        url: urlStr,
        redactedUrl: urlStr,
        bytes: async () => new Uint8Array(),
        text: async () => '',
        json: async () => ({}),
      };
    });

    const connector = new HuggingFaceConnector();
    const req: ConnectorSearchRequest = {
      requirements: {
        topic: 'crop yield',
        geography: 'Maharashtra',
        time_coverage: null,
        minimum_records: 1000,
        required_features: ['rainfall'],
        target: 'yield',
        preferences: [],
        constraints: [],
      },
      derived: [],
      maxResults: 5,
    };

    const result = await connector.search(req, createMockContext());

    expect(result.source).toBe('huggingface');
    expect(result.status.status).toBe('success');
    expect(result.datasets).toHaveLength(1); // Gated dataset skipped
    const ds = result.datasets[0]!;
    expect(ds.dataset_id).toBe('huggingface:owner/crop-yield');
    expect(ds.columns).toEqual(['district', 'rainfall', 'yield']);
    expect(ds.record_count).toBe(2500);
    expect(ds.license).toBe('MIT');
    expect(ds.provenance['columns']).toBeDefined();

    vi.restoreAllMocks();
  });

  it('handles search API failures gracefully and returns failed status', async () => {
    vi.spyOn(safeFetchModule, 'safeFetch').mockResolvedValueOnce({
      status: 503,
      statusText: 'Service Unavailable',
      headers: new Headers(),
      url: 'https://huggingface.co/api/datasets',
      redactedUrl: 'https://huggingface.co/api/datasets',
      bytes: async () => new Uint8Array(),
      text: async () => '',
      json: async () => ({}),
    });

    const connector = new HuggingFaceConnector();
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
      maxResults: 5,
    };

    const result = await connector.search(req, createMockContext());
    expect(result.status.status).toBe('failed');
    expect(result.datasets).toHaveLength(0);

    vi.restoreAllMocks();
  });
});
