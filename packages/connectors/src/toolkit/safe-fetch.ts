import { validateUrlForSsrf, type SsrfGuardOptions } from './ssrf.js';
import { redactUrl, redactErrorMessage } from './redaction.js';
import {
  parseRetryAfter,
  RetryableError,
  withRetry,
  type RetryOptions,
} from './retry.js';

export interface SafeFetchOptions extends RequestInit {
  timeoutMs?: number | undefined;
  maxBytes?: number | undefined;
  maxRedirects?: number | undefined;
  allowedContentTypes?: readonly string[] | undefined;
  ssrfOptions?: SsrfGuardOptions | undefined;
  retryOptions?: RetryOptions | undefined;
}

export interface SafeFetchResponse {
  readonly status: number;
  readonly statusText: string;
  readonly headers: Headers;
  readonly url: string;
  readonly redactedUrl: string;
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
  bytes(): Promise<Uint8Array>;
}

export async function safeFetch(
  targetUrl: string | URL,
  options: SafeFetchOptions = {},
): Promise<SafeFetchResponse> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
  const maxRedirects = options.maxRedirects ?? 3;
  const allowedContentTypes = options.allowedContentTypes;
  const callerSignal = options.signal as AbortSignal | undefined;

  // Pass the caller's signal into the retry loop so it can abort sleeps.
  const retryOpts: RetryOptions = {
    ...(options.retryOptions ?? {}),
    signal: callerSignal,
  };

  return withRetry(async () => {
    let currentUrl =
      typeof targetUrl === 'string' ? new URL(targetUrl) : targetUrl;
    let redirectCount = 0;

    while (true) {
      await validateUrlForSsrf(currentUrl, options.ssrfOptions);

      // Create an internal controller that fires on timeout.
      // Link caller's signal so pre-aborted or mid-flight cancellation
      // propagates without overwriting it.
      const controller = new AbortController();

      const timer = setTimeout(
        () =>
          controller.abort(new Error(`Request timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );

      // If the caller's signal is already aborted, abort immediately.
      if (callerSignal?.aborted) {
        clearTimeout(timer);
        controller.abort(callerSignal.reason ?? new Error('Caller aborted'));
      }

      // Forward future caller aborts to our internal controller.
      const onCallerAbort = (): void => {
        controller.abort(callerSignal?.reason ?? new Error('Caller aborted'));
      };
      callerSignal?.addEventListener('abort', onCallerAbort, { once: true });

      let response: Response;
      try {
        response = await fetch(currentUrl.href, {
          ...options,
          redirect: 'manual',
          signal: controller.signal,
        });
      } catch (err: unknown) {
        clearTimeout(timer);
        callerSignal?.removeEventListener('abort', onCallerAbort);
        const errObj = err as Error;
        const safeMsg = redactErrorMessage(
          errObj.message || 'Network fetch failed',
        );
        if (errObj.name === 'AbortError') {
          // Distinguish caller abort from timeout.
          if (callerSignal?.aborted) {
            throw new Error(`Fetch cancelled by caller: ${safeMsg}`, {
              cause: err,
            });
          }
          throw new RetryableError(`Fetch timeout: ${safeMsg}`);
        }
        throw new RetryableError(`Fetch error: ${safeMsg}`);
      }

      // DO NOT clear the timer here — it must keep running during body reads
      // so slow-drip responses still hit the deadline.

      if (response.status >= 300 && response.status < 400) {
        clearTimeout(timer);
        callerSignal?.removeEventListener('abort', onCallerAbort);
        redirectCount++;
        if (redirectCount > maxRedirects) {
          throw new Error(
            `Exceeded maximum allowed redirects (${maxRedirects})`,
          );
        }

        const location = response.headers.get('location');
        if (!location) {
          throw new Error(
            `Redirect response (${response.status}) missing Location header`,
          );
        }

        currentUrl = new URL(location, currentUrl);
        continue;
      }

      if (response.status === 429) {
        clearTimeout(timer);
        callerSignal?.removeEventListener('abort', onCallerAbort);
        const retryAfterMs = parseRetryAfter(
          response.headers.get('retry-after'),
        );
        throw new RetryableError(
          `Rate limited (429) by ${redactUrl(currentUrl)}`,
          429,
          retryAfterMs,
        );
      }

      if (response.status >= 500) {
        clearTimeout(timer);
        callerSignal?.removeEventListener('abort', onCallerAbort);
        throw new RetryableError(
          `Upstream server error (${response.status}) from ${redactUrl(currentUrl)}`,
          response.status,
        );
      }

      const contentType = response.headers.get('content-type') || '';
      if (allowedContentTypes && allowedContentTypes.length > 0) {
        const matches = allowedContentTypes.some((allowed) =>
          contentType.toLowerCase().includes(allowed.toLowerCase()),
        );
        if (!matches) {
          clearTimeout(timer);
          callerSignal?.removeEventListener('abort', onCallerAbort);
          throw new Error(
            `Unexpected Content-Type '${contentType}' from ${redactUrl(currentUrl)}. Allowed: ${allowedContentTypes.join(', ')}`,
          );
        }
      }

      const contentLengthHeader = response.headers.get('content-length');
      if (contentLengthHeader) {
        const declaredSize = Number(contentLengthHeader);
        if (!isNaN(declaredSize) && declaredSize > maxBytes) {
          clearTimeout(timer);
          callerSignal?.removeEventListener('abort', onCallerAbort);
          throw new Error(
            `Response size ${declaredSize} bytes exceeds maximum limit of ${maxBytes} bytes`,
          );
        }
      }

      const redactedUrlStr = redactUrl(currentUrl);

      // Body-reading helpers. The timeout timer is still running, so if the
      // body drips slowly past the deadline the AbortController fires and
      // reader.read() rejects with AbortError.
      async function readBoundedBytes(): Promise<Uint8Array> {
        try {
          if (!response.body) {
            return new Uint8Array(0);
          }

          if (controller.signal.aborted) {
            throw controller.signal.reason ?? new Error('Request aborted');
          }

          const reader = response.body.getReader();
          const chunks: Uint8Array[] = [];
          let totalBytes = 0;

          let onAbort: (() => void) | undefined;
          const abortPromise = new Promise<never>((_, reject) => {
            onAbort = () => {
              const reason =
                controller.signal.reason ??
                new Error(`Request timed out after ${timeoutMs}ms`);
              reject(reason);
              reader.cancel().catch(() => {});
            };
            controller.signal.addEventListener('abort', onAbort, {
              once: true,
            });
          });

          try {
            while (true) {
              if (controller.signal.aborted) {
                throw (
                  controller.signal.reason ??
                  new Error(`Request timed out after ${timeoutMs}ms`)
                );
              }
              const { done, value } = await Promise.race([
                reader.read(),
                abortPromise,
              ]);
              if (done) {
                if (controller.signal.aborted) {
                  throw (
                    controller.signal.reason ??
                    new Error(`Request timed out after ${timeoutMs}ms`)
                  );
                }
                break;
              }
              if (value) {
                totalBytes += value.length;
                if (totalBytes > maxBytes) {
                  await reader.cancel();
                  throw new Error(
                    `Response payload exceeded maximum allowed size of ${maxBytes} bytes`,
                  );
                }
                chunks.push(value);
              }
            }
          } finally {
            if (onAbort) {
              controller.signal.removeEventListener('abort', onAbort);
            }
            reader.releaseLock();
          }

          const concatenated = new Uint8Array(totalBytes);
          let offset = 0;
          for (const chunk of chunks) {
            concatenated.set(chunk, offset);
            offset += chunk.length;
          }

          return concatenated;
        } finally {
          clearTimeout(timer);
          callerSignal?.removeEventListener('abort', onCallerAbort);
        }
      }

      async function readText(): Promise<string> {
        const rawBytes = await readBoundedBytes();
        return new TextDecoder().decode(rawBytes);
      }

      return {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
        url: currentUrl.href,
        redactedUrl: redactedUrlStr,
        bytes: readBoundedBytes,
        text: readText,
        async json<T = unknown>() {
          const str = await readText();
          return JSON.parse(str) as T;
        },
      };
    }
  }, retryOpts);
}
