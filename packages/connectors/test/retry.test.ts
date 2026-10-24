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
            const err: any = new Error('Not found');
            err.status = 404;
            throw err;
          },
          { maxRetries: 3, initialDelayMs: 10 },
        ),
      ).rejects.toThrow('Not found');
      expect(attempts).toBe(1);
    });
  });
});
