import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
  extractContextInfo,
  jsonResponse,
  errorResponse,
} from '../utils/http.js';
import { getResultsStore } from '../storage/index.js';

export async function handler(
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> {
  const { requestId, sub } = extractContextInfo(event);
  const targetRequestId = event.pathParameters?.request_id;

  if (!targetRequestId) {
    return errorResponse(
      'invalid_request',
      'Missing request_id path parameter.',
      requestId,
    );
  }

  // Check authentication
  if (!sub) {
    return errorResponse(
      'unauthorized',
      'User identity required to retrieve cached results.',
      requestId,
    );
  }

  const resultsStore = getResultsStore();
  const stored = await resultsStore.getResult(targetRequestId);

  // Return 404 with identical error if not found or belongs to someone else (never reveal which)
  if (!stored || stored.ownerSub !== sub) {
    return errorResponse(
      'not_found',
      'Search result not found or expired.',
      requestId,
    );
  }

  return jsonResponse(200, stored.searchResponse);
}
