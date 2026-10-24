import type {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
} from 'aws-lambda';
import {
  SearchRequestSchema,
  SearchResponseSchema,
  SEARCH_QUERY_MAX_LENGTH,
} from '@datascout/contracts';
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

  if (!event.body) {
    return errorResponse('invalid_request', 'Missing request body.', requestId);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(event.body);
  } catch {
    return errorResponse('invalid_request', 'Malformed JSON in request body.', requestId);
  }

  if (
    typeof (parsedJson as any)?.query === 'string' &&
    (parsedJson as any).query.trim().length > SEARCH_QUERY_MAX_LENGTH
  ) {
    return errorResponse(
      'payload_too_large',
      `Search query exceeds maximum allowed length of ${SEARCH_QUERY_MAX_LENGTH} characters.`,
      requestId,
    );
  }

  const parseResult = SearchRequestSchema.safeParse(parsedJson);
  if (!parseResult.success) {
    const issue = parseResult.error.issues[0]?.message ?? 'Invalid search request schema.';
    return errorResponse('invalid_request', issue, requestId);
  }

  // Build the SearchResponse fixture with dynamic request_id
  const response = {
    ...searchResultsFixture,
    request_id: requestId,
  };

  const validatedResponse = SearchResponseSchema.parse(response);
  return jsonResponse(200, validatedResponse);
}
