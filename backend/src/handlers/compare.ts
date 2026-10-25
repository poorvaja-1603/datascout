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
import { getDatasetsStore } from '../storage/index.js';

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

  const datasets = await getDatasetsStore().batchGetComparisons(parseResult.data.dataset_ids);
  if (datasets.length !== parseResult.data.dataset_ids.length) {
    return errorResponse('not_found', 'One or more datasets were not found.', requestId);
  }
  const response = {
    datasets,
    contract_version: process.env.CONTRACT_VERSION ?? '1.0.0',
    prompt_version: process.env.PROMPT_VERSION ?? 'extract-v1',
    schema_version: process.env.SCHEMA_VERSION ?? '1.0.0',
    scoring_version: process.env.SCORING_VERSION ?? 'score-v1',
    model_id: process.env.MODEL_ID ?? 'not_applicable',
  };
  const validatedResponse = CompareResponseSchema.parse(response);
  return jsonResponse(200, validatedResponse);
}
