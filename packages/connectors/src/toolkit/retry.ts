export interface RetryOptions {
  maxRetries?: number | undefined;
  initialDelayMs?: number | undefined;
  maxDelayMs?: number | undefined;
  backoffFactor?: number | undefined;
  jitter?: boolean | undefined;
  /** AbortSignal — if aborted, the retry loop stops immediately. */
  signal?: AbortSignal | undefined;
}

export class RetryableError extends Error {
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(message: string, status?: number | undefined, retryAfterMs?: number | undefined) {
    super(message);
    this.name = 'RetryableError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export function parseRetryAfter(headerValue: string | null | undefined): number | undefined {
  if (!headerValue) return undefined;

  const seconds = Number(headerValue);
  if (!isNaN(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const dateMs = Date.parse(headerValue);
  if (!isNaN(dateMs)) {
    const diff = dateMs - Date.now();
    return diff > 0 ? diff : 0;
  }

  return undefined;
}

export function isTransientStatus(status: number): boolean {
  return (
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  );
}

/**
 * Abortable sleep. Resolves early if `signal` fires, but still counts as a
 * completed delay for the caller — the caller is responsible for checking
 * signal.aborted after the sleep.
 */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  const initialDelay = options.initialDelayMs ?? 200;
  const maxDelay = options.maxDelayMs ?? 5000;
  const factor = options.backoffFactor ?? 2;
  const useJitter = options.jitter ?? true;
  const signal = options.signal;

  let attempt = 0;

  while (true) {
    // Abort check before each attempt.
    if (signal?.aborted) {
      throw new Error('Operation aborted before attempt');
    }

    try {
      return await operation(attempt);
    } catch (error: unknown) {
      attempt++;
      if (attempt > maxRetries) {
        throw error;
      }

      let shouldRetry = false;
      let explicitDelayMs: number | undefined;

      const err = error as Record<string, unknown>;

      if (error instanceof RetryableError) {
        shouldRetry = true;
        explicitDelayMs = error.retryAfterMs;
      } else if (typeof err?.['status'] === 'number' && isTransientStatus(err['status'] as number)) {
        shouldRetry = true;
      } else if (
        err?.['name'] === 'FetchError' ||
        err?.['code'] === 'ECONNRESET' ||
        err?.['code'] === 'ETIMEDOUT' ||
        err?.['code'] === 'UND_ERR_CONNECT_TIMEOUT'
      ) {
        shouldRetry = true;
      }

      if (!shouldRetry) {
        throw error;
      }

      // Clamp Retry-After: if it exceeds maxDelayMs, give up instead of
      // sleeping for an unbounded time.
      if (explicitDelayMs !== undefined && explicitDelayMs > maxDelay) {
        throw error;
      }

      // Abort check after catching — don't sleep if already cancelled.
      if (signal?.aborted) {
        throw new Error('Operation aborted during retry backoff', { cause: error });
      }

      let delay = explicitDelayMs;
      if (delay === undefined) {
        delay = Math.min(initialDelay * Math.pow(factor, attempt - 1), maxDelay);
        if (useJitter) {
          delay = delay * (0.5 + Math.random() * 0.5);
        }
      }

      await abortableSleep(delay, signal);

      // If signal fired during sleep, stop retrying.
      if (signal?.aborted) {
        throw new Error('Operation aborted during retry backoff', { cause: error });
      }
    }
  }
}
