import type {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
} from 'aws-lambda';
import { SearchResponseSchema } from '@datascout/contracts';
import {
  extractContextInfo,
  jsonResponse,
  errorResponse,
} from '../utils/http.js';
import searchResultsFixture from '../../../contracts/fixtures/search-results.json' with { type: 'json' };

export async function handler(
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> {
  const { requestId, sub } = extractContextInfo(event);
  const targetRequestId = event.pathParameters?.request_id;

  if (!targetRequestId) {
    return errorResponse('invalid_request', 'Missing request_id path parameter.', requestId);
  }

  // Check authentication / ownership
  if (!sub) {
    return errorResponse('unauthorized', 'User identity required to retrieve cached results.', requestId);
  }

  // Simulate ownership: only permit retrieval if authorized user owns this request ID
  // In development/skeleton mode, test requests owned by the user return the fixture
  const response = {
    ...searchResultsFixture,
    request_id: targetRequestId,
  };

  const validatedResponse = SearchResponseSchema.parse(response);
  return jsonResponse(200, validatedResponse);
}
