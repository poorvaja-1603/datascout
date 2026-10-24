import type {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
} from 'aws-lambda';
import {
  type ErrorCode,
  type ErrorObject,
  type ContractVersions,
  ERROR_HTTP_STATUS,
  ERROR_RETRYABLE,
  ErrorObjectSchema,
} from '@datascout/contracts';
import { randomUUID } from 'node:crypto';

export interface RequestContextInfo {
  requestId: string;
  sub: string | null;
  scopes: string[];
}

export const DEFAULT_ERROR_VERSIONS: ContractVersions = {
  contract_version: '1.0.0',
  prompt_version: 'not_applicable',
  schema_version: '1.0.0',
  scoring_version: 'not_applicable',
  model_id: 'not_applicable',
};

export function extractContextInfo(event: APIGatewayProxyEvent): RequestContextInfo {
  const requestId =
    event.requestContext?.requestId ||
    (event.headers?.['x-request-id'] as string) ||
    randomUUID();

  const claims = (event.requestContext?.authorizer as Record<string, any>)?.claims;
  const sub =
    claims?.sub ||
    (event.headers?.['x-user-sub'] as string) ||
    null;

  const scopeHeader =
    claims?.scope ||
    (event.headers?.['x-token-scopes'] as string) ||
    '';
  const scopes = scopeHeader.split(' ').map((s: string) => s.trim()).filter(Boolean);

  return { requestId, sub, scopes };
}

export function createCorsHeaders(origin: string = '*'): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers':
      'Content-Type,Authorization,X-Amz-Date,X-Api-Key,X-Amz-Security-Token,X-Request-Id',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  };
}

export function jsonResponse(
  statusCode: number,
  body: unknown,
  headers: Record<string, string> = createCorsHeaders(),
): APIGatewayProxyResult {
  return {
    statusCode,
    headers,
    body: JSON.stringify(body),
  };
}

export function errorResponse(
  code: ErrorCode,
  message: string,
  requestId: string,
  headers: Record<string, string> = createCorsHeaders(),
): APIGatewayProxyResult {
  const statusCode = ERROR_HTTP_STATUS[code];
  const errorObj: ErrorObject = {
    code,
    message,
    request_id: requestId,
    retryable: ERROR_RETRYABLE[code],
    ...DEFAULT_ERROR_VERSIONS,
  };

  ErrorObjectSchema.parse(errorObj);

  return jsonResponse(statusCode, errorObj, headers);
}
