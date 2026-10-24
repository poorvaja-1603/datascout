import type {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
} from 'aws-lambda';
import {
  CompareRequestSchema,
  CompareResponseSchema,
} from '@datascout/contracts';
import {
  extractContextInfo,
  jsonResponse,
  errorResponse,
} from '../utils/http.js';
import compareSyntheticFixture from '../../../contracts/fixtures/compare-synthetic.json' with { type: 'json' };

export async function handler(
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> {
  const { requestId } = extractContextInfo(event);

  if (!event.body) {
    return errorResponse('invalid_request', 'Missing request body.', requestId);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(event.body);
  } catch {
    return errorResponse('invalid_request', 'Malformed JSON in request body.', requestId);
  }

  const parseResult = CompareRequestSchema.safeParse(parsedJson);
  if (!parseResult.success) {
    const issue = parseResult.error.issues[0]?.message ?? 'Invalid compare request schema.';
    return errorResponse('invalid_request', issue, requestId);
  }

  const validatedResponse = CompareResponseSchema.parse(compareSyntheticFixture);
  return jsonResponse(200, validatedResponse);
}
