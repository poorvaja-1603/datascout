export interface RetryOptions {
  maxRetries?: number | undefined;
  initialDelayMs?: number | undefined;
  maxDelayMs?: number | undefined;
  backoffFactor?: number | undefined;
  jitter?: boolean | undefined;
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

export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  const initialDelay = options.initialDelayMs ?? 200;
  const maxDelay = options.maxDelayMs ?? 5000;
  const factor = options.backoffFactor ?? 2;
  const useJitter = options.jitter ?? true;

  let attempt = 0;

  while (true) {
    try {
      return await operation(attempt);
    } catch (error: any) {
      attempt++;
      if (attempt > maxRetries) {
        throw error;
      }

      let shouldRetry = false;
      let explicitDelayMs: number | undefined;

      if (error instanceof RetryableError) {
        shouldRetry = true;
        explicitDelayMs = error.retryAfterMs;
      } else if (error?.status && isTransientStatus(error.status)) {
        shouldRetry = true;
      } else if (
        error?.name === 'FetchError' ||
        error?.code === 'ECONNRESET' ||
        error?.code === 'ETIMEDOUT' ||
        error?.code === 'UND_ERR_CONNECT_TIMEOUT'
      ) {
        shouldRetry = true;
      }

      if (!shouldRetry) {
        throw error;
      }

      let delay = explicitDelayMs;
      if (delay === undefined) {
        delay = Math.min(initialDelay * Math.pow(factor, attempt - 1), maxDelay);
        if (useJitter) {
          delay = delay * (0.5 + Math.random() * 0.5);
        }
      }

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
