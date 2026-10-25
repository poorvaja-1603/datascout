import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DatasetDetailSchema, DATASET_ID_PATTERN } from '@datascout/contracts';
import {
  extractContextInfo,
  jsonResponse,
  errorResponse,
} from '../utils/http.js';
import datasetDetailFixture from '../../../contracts/fixtures/dataset-detail.json' with { type: 'json' };
import { getDatasetsStore } from '../storage/index.js';

const datasetIdRegex = new RegExp(DATASET_ID_PATTERN);

export async function handler(
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> {
  const { requestId } = extractContextInfo(event);
  const rawDatasetId = event.pathParameters?.dataset_id;

  if (!rawDatasetId) {
    return errorResponse(
      'invalid_request',
      'Missing dataset_id path parameter.',
      requestId,
    );
  }

  const datasetId = decodeURIComponent(rawDatasetId);

  if (!datasetIdRegex.test(datasetId)) {
    return errorResponse(
      'invalid_request',
      `Dataset ID '${datasetId}' does not match canonical pattern {source}:{native_id}.`,
      requestId,
    );
  }

  try {
    const stored = await getDatasetsStore().getDataset(datasetId);
    if (stored) return jsonResponse(200, DatasetDetailSchema.parse(stored));
  } catch {
    return errorResponse(
      'internal_error',
      'Dataset detail could not be loaded.',
      requestId,
    );
  }

  const response = {
    ...datasetDetailFixture,
    dataset: {
      ...datasetDetailFixture.dataset,
      dataset_id: datasetId,
    },
  };

  const validatedResponse = DatasetDetailSchema.parse(response);
  return jsonResponse(200, validatedResponse);
}
