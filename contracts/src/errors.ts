import type { ErrorObject } from './schemas.js';
import { ERROR_RETRYABLE } from './schemas.js';

export const DATASCOUT_ERROR_CODES = {
  requestAborted: 'invalid_request',
  fakeNoCannedResponse: 'invalid_request',
  llmTimeout: 'timeout',
  llmThrottled: 'rate_limited',
  fixtureNotFound: 'internal_error',
  invalidConnectorRequest: 'invalid_request',
} as const satisfies Record<string, ErrorObject['code']>;

export class DataScoutError extends Error {
  constructor(
    readonly code: ErrorObject['code'],
    readonly safeMessage: string,
    retryable: boolean = ERROR_RETRYABLE[code],
  ) {
    if (retryable !== ERROR_RETRYABLE[code]) {
      throw new TypeError(
        `retryable does not match DataScoutError code ${code}.`,
      );
    }
    super(safeMessage);
    this.name = 'DataScoutError';
    this.retryable = retryable;
  }

  readonly retryable: boolean;
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
