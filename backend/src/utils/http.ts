import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
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

function isLocalOrTestEnvironment(): boolean {
  return (
    process.env.ENVIRONMENT === 'local' ||
    process.env.NODE_ENV === 'test' ||
    process.env.VITEST === 'true' ||
    Boolean(process.env.VITEST)
  );
}

export function extractContextInfo(
  event: APIGatewayProxyEvent,
): RequestContextInfo {
  const requestId =
    event.requestContext?.requestId ||
    (event.headers?.['x-request-id'] as string) ||
    randomUUID();

  const authorizer = event.requestContext?.authorizer as
    Record<string, unknown> | undefined;
  const claims = authorizer?.claims as Record<string, unknown> | undefined;

  let sub: string | null = null;
  if (typeof claims?.sub === 'string' && claims.sub.trim().length > 0) {
    sub = claims.sub.trim();
  } else if (
    isLocalOrTestEnvironment() &&
    typeof event.headers?.['x-user-sub'] === 'string'
  ) {
    sub = event.headers['x-user-sub'].trim() || null;
  }

  let scopeHeader = '';
  if (typeof claims?.scope === 'string') {
    scopeHeader = claims.scope;
  } else if (
    isLocalOrTestEnvironment() &&
    typeof event.headers?.['x-token-scopes'] === 'string'
  ) {
    scopeHeader = event.headers['x-token-scopes'];
  }
  const scopes = scopeHeader
    .split(' ')
    .map((s: string) => s.trim())
    .filter(Boolean);

  return { requestId, sub, scopes };
}

export function createCorsHeaders(
  origin: string = '*',
): Record<string, string> {
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
