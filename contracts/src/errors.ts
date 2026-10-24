import type { ErrorObject } from './schemas.js';

export const DATASCOUT_ERROR_CODES = {
  requestAborted: 'REQUEST_ABORTED',
  fakeNoCannedResponse: 'FAKE_NO_CANNED_RESPONSE',
  llmTimeout: 'LLM_TIMEOUT',
  llmThrottled: 'LLM_THROTTLED',
  fixtureNotFound: 'FIXTURE_NOT_FOUND',
  invalidConnectorRequest: 'INVALID_CONNECTOR_REQUEST',
} as const satisfies Record<string, ErrorObject['code']>;

export class DataScoutError extends Error {
  constructor(
    readonly code: ErrorObject['code'],
    readonly safeMessage: string,
    readonly retryable: boolean,
  ) {
    super(safeMessage);
    this.name = 'DataScoutError';
  }
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DataScoutError(
      DATASCOUT_ERROR_CODES.requestAborted,
      'The request was cancelled.',
      false,
    );
  }
}
