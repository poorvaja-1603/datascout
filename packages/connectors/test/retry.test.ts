import { describe, expect, it } from 'vitest';
import {
  parseRetryAfter,
  isTransientStatus,
  withRetry,
  RetryableError,
} from '../src/toolkit/retry.js';

describe('Retry Toolkit', () => {
  describe('parseRetryAfter', () => {
    it('parses integer seconds into milliseconds', () => {
      expect(parseRetryAfter('5')).toBe(5000);
      expect(parseRetryAfter('0')).toBe(0);
    });

    it('returns undefined for invalid or null inputs', () => {
      expect(parseRetryAfter(null)).toBeUndefined();
      expect(parseRetryAfter('invalid')).toBeUndefined();
    });

    it('parses HTTP date string into millisecond difference', () => {
      const future = new Date(Date.now() + 10_000).toUTCString();
      const diff = parseRetryAfter(future);
      expect(diff).toBeDefined();
      expect(diff).toBeGreaterThan(5000);
      expect(diff).toBeLessThanOrEqual(10000);
    });
  });

  describe('isTransientStatus', () => {
    it('identifies 429 and 5xx as transient', () => {
      expect(isTransientStatus(429)).toBe(true);
      expect(isTransientStatus(500)).toBe(true);
      expect(isTransientStatus(502)).toBe(true);
      expect(isTransientStatus(503)).toBe(true);
      expect(isTransientStatus(504)).toBe(true);
    });

    it('identifies client errors (400, 401, 403, 404) as non-transient', () => {
      expect(isTransientStatus(400)).toBe(false);
      expect(isTransientStatus(401)).toBe(false);
      expect(isTransientStatus(403)).toBe(false);
      expect(isTransientStatus(404)).toBe(false);
    });
  });

  describe('withRetry', () => {
    it('succeeds without retry on first successful attempt', async () => {
      let calls = 0;
      const res = await withRetry(async () => {
        calls++;
        return 'success';
      });
      expect(res).toBe('success');
      expect(calls).toBe(1);
    });

    it('retries on RetryableError until success', async () => {
      let attempts = 0;
      const res = await withRetry(
        async () => {
          attempts++;
          if (attempts < 3) {
            throw new RetryableError('Temporary failure', 503);
          }
          return 'eventual success';
        },
        { initialDelayMs: 10, maxRetries: 3, jitter: false },
      );
      expect(res).toBe('eventual success');
      expect(attempts).toBe(3);
    });

    it('fails immediately without retry on non-retryable error', async () => {
      let attempts = 0;
      await expect(
        withRetry(
          async () => {
            attempts++;
            const err = new Error('Not found') as Error & { status: number };
            err.status = 404;
            throw err;
          },
          { maxRetries: 3, initialDelayMs: 10 },
        ),
      ).rejects.toThrow('Not found');
      expect(attempts).toBe(1);
    });

    it('gives up immediately when Retry-After exceeds maxDelayMs', async () => {
      let attempts = 0;
      const start = Date.now();
      await expect(
        withRetry(
          async () => {
            attempts++;
            // Server says wait 86400 seconds (1 day) — unacceptable
            throw new RetryableError('Rate limited', 429, 86_400_000);
          },
          { maxRetries: 3, initialDelayMs: 10, maxDelayMs: 5000, jitter: false },
        ),
      ).rejects.toThrow('Rate limited');
      const elapsed = Date.now() - start;
      // Must not have slept — should finish in well under 1 second
      expect(elapsed).toBeLessThan(1000);
      expect(attempts).toBe(1);
    });

    it('aborts retry sleep when signal fires', async () => {
      const controller = new AbortController();
      let attempts = 0;

      // Abort 50ms after the test starts
      setTimeout(() => controller.abort(), 50);

      const start = Date.now();
      await expect(
        withRetry(
          async () => {
            attempts++;
            throw new RetryableError('Temporary failure', 503);
          },
          {
            maxRetries: 5,
            initialDelayMs: 10_000, // 10s — would be very slow without abort
            jitter: false,
            signal: controller.signal,
          },
        ),
      ).rejects.toThrow(/abort/i);
      const elapsed = Date.now() - start;
      // Should finish much faster than the 10s sleep
      expect(elapsed).toBeLessThan(2000);
      expect(attempts).toBeGreaterThanOrEqual(1);
    });

    it('throws immediately when signal is pre-aborted', async () => {
      const controller = new AbortController();
      controller.abort();

      let attempts = 0;
      await expect(
        withRetry(
          async () => {
            attempts++;
            return 'should never reach';
          },
          { maxRetries: 3, signal: controller.signal },
        ),
      ).rejects.toThrow(/abort/i);
      expect(attempts).toBe(0);
    });
  });
});
