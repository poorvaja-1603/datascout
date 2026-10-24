import { validateUrlForSsrf, type SsrfGuardOptions, SsrfError } from './ssrf.js';
import { redactUrl, redactErrorMessage } from './redaction.js';
import { parseRetryAfter, RetryableError, withRetry, type RetryOptions } from './retry.js';

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

  return withRetry(async () => {
    let currentUrl = typeof targetUrl === 'string' ? new URL(targetUrl) : targetUrl;
    let redirectCount = 0;

    while (true) {
      await validateUrlForSsrf(currentUrl, options.ssrfOptions);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs);

      let response: Response;
      try {
        response = await fetch(currentUrl.href, {
          ...options,
          redirect: 'manual',
          signal: controller.signal,
        });
      } catch (err: any) {
        clearTimeout(timer);
        const safeMsg = redactErrorMessage(err.message || 'Network fetch failed');
        if (err.name === 'AbortError') {
          throw new RetryableError(`Fetch timeout: ${safeMsg}`);
        }
        throw new RetryableError(`Fetch error: ${safeMsg}`);
      } finally {
        clearTimeout(timer);
      }

      if (response.status >= 300 && response.status < 400) {
        redirectCount++;
        if (redirectCount > maxRedirects) {
          throw new Error(`Exceeded maximum allowed redirects (${maxRedirects})`);
        }

        const location = response.headers.get('location');
        if (!location) {
          throw new Error(`Redirect response (${response.status}) missing Location header`);
        }

        currentUrl = new URL(location, currentUrl);
        continue;
      }

      if (response.status === 429) {
        const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
        throw new RetryableError(
          `Rate limited (429) by ${redactUrl(currentUrl)}`,
          429,
          retryAfterMs,
        );
      }

      if (response.status >= 500) {
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
          throw new Error(
            `Unexpected Content-Type '${contentType}' from ${redactUrl(currentUrl)}. Allowed: ${allowedContentTypes.join(', ')}`,
          );
        }
      }

      const contentLengthHeader = response.headers.get('content-length');
      if (contentLengthHeader) {
        const declaredSize = Number(contentLengthHeader);
        if (!isNaN(declaredSize) && declaredSize > maxBytes) {
          throw new Error(
            `Response size ${declaredSize} bytes exceeds maximum limit of ${maxBytes} bytes`,
          );
        }
      }

      const redactedUrlStr = redactUrl(currentUrl);

      async function readBoundedBytes(): Promise<Uint8Array> {
        if (!response.body) {
          return new Uint8Array(0);
        }

        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let totalBytes = 0;

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
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
          reader.releaseLock();
        }

        const concatenated = new Uint8Array(totalBytes);
        let offset = 0;
        for (const chunk of chunks) {
          concatenated.set(chunk, offset);
          offset += chunk.length;
        }

        return concatenated;
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
  }, options.retryOptions);
}
