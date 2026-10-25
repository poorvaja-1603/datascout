import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CompareResponseSchema,
  DatasetDetailSchema,
  ErrorObjectSchema,
  SearchResponseSchema,
} from '../src/index.js';
import { createMockApiServer } from '../src/mock-api.js';

const validSearch = {
  query: 'Find synthetic rainfall data.',
};
const compareDatasetIds = [
  'datagovin:fixture-rainfall-monthly',
  'openml:datascout-fixtures/diagnosis-table',
];

let baseUrl: string;
let server: Awaited<ReturnType<typeof createMockApiServer>>;

function authorized(token = 'mock-access-token'): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function responseJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

describe('P0-6 fixture-backed mock API', () => {
  beforeAll(async () => {
    server = await createMockApiServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Mock API did not bind to a TCP port.');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    if (server?.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it('serves fixture-backed responses for all four contracted routes', async () => {
    const searchResponse = await fetch(`${baseUrl}/search`, {
      method: 'POST',
      headers: {
        ...authorized(),
        'content-type': 'application/json',
        prefer: 'example=search-partial',
      },
      body: JSON.stringify(validSearch),
    });
    expect(searchResponse.status).toBe(200);
    expect(
      SearchResponseSchema.parse(await responseJson(searchResponse)),
    ).toMatchObject({
      request_id: 'fixture-search-partial',
      source_statuses: [{ status: 'success' }, { status: 'failed' }],
    });

    const resultResponse = await fetch(
      `${baseUrl}/results/fixture-search-clarification`,
      {
        headers: {
          ...authorized('mock-read-token'),
          prefer: 'example=search-clarification',
        },
      },
    );
    expect(resultResponse.status).toBe(200);
    expect(
      SearchResponseSchema.parse(await responseJson(resultResponse)).outcome,
    ).toBe('clarification_needed');

    const datasetResponse = await fetch(
      `${baseUrl}/dataset/${encodeURIComponent('datagovin:fixture-crop-yield')}`,
      { headers: authorized('mock-read-token') },
    );
    expect(datasetResponse.status).toBe(200);
    expect(
      DatasetDetailSchema.parse(await responseJson(datasetResponse)).dataset
        .dataset_id,
    ).toBe('datagovin:fixture-crop-yield');

    const compareResponse = await fetch(`${baseUrl}/compare`, {
      method: 'POST',
      headers: {
        ...authorized('mock-compare-token'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ dataset_ids: compareDatasetIds }),
    });
    expect(compareResponse.status).toBe(200);
    expect(
      CompareResponseSchema.parse(await responseJson(compareResponse)).datasets,
    ).toHaveLength(2);
  });

  it('returns contract ErrorObjects for missing auth, wrong scopes, and invalid requests', async () => {
    const noAuth = await fetch(`${baseUrl}/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validSearch),
    });
    expect(noAuth.status).toBe(401);
    expect(ErrorObjectSchema.parse(await responseJson(noAuth)).code).toBe(
      'unauthorized',
    );

    const wrongScope = await fetch(`${baseUrl}/compare`, {
      method: 'POST',
      headers: {
        ...authorized('mock-search-token'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ dataset_ids: compareDatasetIds }),
    });
    expect(wrongScope.status).toBe(403);
    expect(ErrorObjectSchema.parse(await responseJson(wrongScope)).code).toBe(
      'forbidden',
    );

    const invalidRequest = await fetch(`${baseUrl}/search`, {
      method: 'POST',
      headers: {
        ...authorized(),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ query: '' }),
    });
    expect(invalidRequest.status).toBe(400);
    expect(
      ErrorObjectSchema.parse(await responseJson(invalidRequest)).code,
    ).toBe('invalid_request');
  });

  it('returns not-found errors for unknown fixture IDs and rejects unknown example names', async () => {
    const missingResult = await fetch(`${baseUrl}/results/not-a-fixture`, {
      headers: authorized('mock-read-token'),
    });
    expect(missingResult.status).toBe(404);
    expect(
      ErrorObjectSchema.parse(await responseJson(missingResult)).code,
    ).toBe('not_found');

    const unknownExample = await fetch(`${baseUrl}/search`, {
      method: 'POST',
      headers: {
        ...authorized(),
        'content-type': 'application/json',
        prefer: 'example=unknown',
      },
      body: JSON.stringify(validSearch),
    });
    expect(unknownExample.status).toBe(400);
    expect(
      ErrorObjectSchema.parse(await responseJson(unknownExample)).code,
    ).toBe('invalid_request');
  });
});
