import { describe, expect, it } from 'vitest';
import type { APIGatewayProxyEvent, ScheduledEvent } from 'aws-lambda';
import { handler as searchHandler } from '../src/handlers/search.js';
import { handler as resultsHandler } from '../src/handlers/results.js';
import { handler as datasetHandler } from '../src/handlers/dataset.js';
import { handler as compareHandler } from '../src/handlers/compare.js';
import { handler as refreshHandler } from '../src/handlers/refresh.js';

function mockEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    body: null,
    headers: {},
    multiValueHeaders: {},
    httpMethod: 'POST',
    isBase64Encoded: false,
    path: '/',
    pathParameters: null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    requestContext: {
      accountId: '123456789012',
      apiId: 'mockapi',
      authorizer: {
        claims: {
          sub: 'user-12345',
          email: 'test@example.com',
          scope: 'datascout-api/search datascout-api/read datascout-api/compare',
        },
      },
      httpMethod: 'POST',
      identity: {
        accessKey: null,
        accountId: null,
        apiKey: null,
        apiKeyId: null,
        caller: null,
        clientCert: null,
        cognitoAuthenticationProvider: null,
        cognitoAuthenticationType: null,
        cognitoIdentityId: null,
        cognitoIdentityPoolId: null,
        principalOrgId: null,
        sourceIp: '127.0.0.1',
        user: null,
        userAgent: 'test-agent',
        userArn: null,
      },
      path: '/',
      protocol: 'HTTP/1.1',
      requestId: 'test-req-001',
      requestTimeEpoch: 0,
      resourceId: 'res-001',
      resourcePath: '/',
      stage: 'dev',
    },
    resource: '/',
    ...overrides,
  };
}

describe('Backend Lambda Handlers', () => {
  describe('POST /search', () => {
    it('returns 400 when body is missing', async () => {
      const res = await searchHandler(mockEvent({ body: null }));
      expect(res.statusCode).toBe(400);
      const parsed = JSON.parse(res.body);
      expect(parsed.code).toBe('invalid_request');
      expect(res.headers?.['Access-Control-Allow-Origin']).toBe('*');
    });

    it('returns 400 when JSON is malformed', async () => {
      const res = await searchHandler(mockEvent({ body: '{invalid-json' }));
      expect(res.statusCode).toBe(400);
      const parsed = JSON.parse(res.body);
      expect(parsed.code).toBe('invalid_request');
    });

    it('returns 413 when query exceeds 1,000 characters', async () => {
      const longQuery = 'a'.repeat(1001);
      const res = await searchHandler(
        mockEvent({ body: JSON.stringify({ query: longQuery }) }),
      );
      expect(res.statusCode).toBe(413);
      const parsed = JSON.parse(res.body);
      expect(parsed.code).toBe('payload_too_large');
    });

    it('returns 200 with schema-valid SearchResponse on valid query', async () => {
      const res = await searchHandler(
        mockEvent({
          body: JSON.stringify({
            query: 'Indian crop yield dataset for Maharashtra with rainfall',
          }),
        }),
      );
      expect(res.statusCode).toBe(200);
      const parsed = JSON.parse(res.body);
      expect(parsed.request_id).toBe('test-req-001');
      expect(parsed.outcome).toBe('results');
      expect(parsed.results).toHaveLength(1);
      expect(parsed.results[0].dataset_id).toBe('datagovin:fixture-crop-yield');
    });
  });

  describe('GET /results/{request_id}', () => {
    it('returns 400 when request_id path parameter is missing', async () => {
      const res = await resultsHandler(mockEvent({ pathParameters: null }));
      expect(res.statusCode).toBe(400);
      const parsed = JSON.parse(res.body);
      expect(parsed.code).toBe('invalid_request');
    });

    it('returns 401 when sub is missing from authorizer context', async () => {
      const event = mockEvent({
        pathParameters: { request_id: 'test-req-001' },
        requestContext: {
          ...mockEvent().requestContext,
          authorizer: {},
        },
      });
      const res = await resultsHandler(event);
      expect(res.statusCode).toBe(401);
      const parsed = JSON.parse(res.body);
      expect(parsed.code).toBe('unauthorized');
    });

    it('returns 200 with cached search result when authorized', async () => {
      const res = await resultsHandler(
        mockEvent({ pathParameters: { request_id: 'test-req-001' } }),
      );
      expect(res.statusCode).toBe(200);
      const parsed = JSON.parse(res.body);
      expect(parsed.request_id).toBe('test-req-001');
    });
  });

  describe('GET /dataset/{dataset_id}', () => {
    it('returns 400 when dataset_id does not match canonical pattern', async () => {
      const res = await datasetHandler(
        mockEvent({ pathParameters: { dataset_id: 'invalid-id-no-source' } }),
      );
      expect(res.statusCode).toBe(400);
      const parsed = JSON.parse(res.body);
      expect(parsed.code).toBe('invalid_request');
    });

    it('returns 200 with DatasetDetail when canonical ID is provided', async () => {
      const res = await datasetHandler(
        mockEvent({
          pathParameters: {
            dataset_id: encodeURIComponent('datagovin:fixture-crop-yield'),
          },
        }),
      );
      expect(res.statusCode).toBe(200);
      const parsed = JSON.parse(res.body);
      expect(parsed.dataset.dataset_id).toBe('datagovin:fixture-crop-yield');
      expect(parsed.dataset.source).toBe('datagovin');
    });
  });

  describe('POST /compare', () => {
    it('returns 400 when body has fewer than 2 dataset IDs', async () => {
      const res = await compareHandler(
        mockEvent({
          body: JSON.stringify({ dataset_ids: ['datagovin:fixture-1'] }),
        }),
      );
      expect(res.statusCode).toBe(400);
      const parsed = JSON.parse(res.body);
      expect(parsed.code).toBe('invalid_request');
    });

    it('returns 200 with CompareResponse for valid dataset IDs', async () => {
      const res = await compareHandler(
        mockEvent({
          body: JSON.stringify({
            dataset_ids: ['datagovin:crop-yield', 'huggingface:agri-stats'],
          }),
        }),
      );
      expect(res.statusCode).toBe(200);
      const parsed = JSON.parse(res.body);
      expect(parsed.datasets).toBeDefined();
    });
  });

  describe('RefreshFunction', () => {
    it('returns completed refresh report', async () => {
      const scheduledEvent: ScheduledEvent = {
        version: '0',
        id: 'evt-001',
        'detail-type': 'Scheduled Event',
        source: 'aws.events',
        account: '123456789012',
        time: '2026-10-24T12:00:00Z',
        region: 'ap-south-1',
        resources: ['arn:aws:events:...'],
        detail: {},
      };
      const res = await refreshHandler(scheduledEvent);
      expect(res.status).toBe('completed');
      expect(res.sourcesProcessed).toContain('datagovin');
      expect(res.sourcesProcessed).toContain('huggingface');
    });
  });
});
