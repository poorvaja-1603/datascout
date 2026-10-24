import { describe, expect, it } from 'vitest';
import {
  redactUrl,
  redactHeaders,
  redactErrorMessage,
} from '../src/toolkit/redaction.js';

describe('Redaction Toolkit', () => {
  describe('redactUrl', () => {
    it('redacts api-key and secret query parameters', () => {
      const url =
        'https://api.data.gov.in/resource/1234?api-key=SECRET12345&format=json&offset=0';
      const redacted = redactUrl(url);
      expect(redacted).not.toContain('SECRET12345');
      expect(redacted).toContain('api-key=%5BREDACTED%5D');
      expect(redacted).toContain('format=json');
      expect(redacted).toContain('offset=0');
    });

    it('redacts tokens and AWS signature parameters', () => {
      const url =
        'https://bucket.s3.amazonaws.com/data.parquet?AWSAccessKeyId=AKIAIOSFODNN7EXAMPLE&Signature=vjbyPxybdZaNmGa%2ByT272YEAiv4%3D';
      const redacted = redactUrl(url);
      expect(redacted).not.toContain('AKIAIOSFODNN7EXAMPLE');
      expect(redacted).toContain('AWSAccessKeyId=%5BREDACTED%5D');
      expect(redacted).toContain('Signature=%5BREDACTED%5D');
    });

    it('leaves non-sensitive query parameters untouched', () => {
      const url = 'https://huggingface.co/api/datasets?limit=10&search=crop';
      expect(redactUrl(url)).toBe(url);
    });
  });

  describe('redactHeaders', () => {
    it('redacts Authorization and x-api-key headers', () => {
      const headers = {
        Authorization: 'Bearer super-secret-jwt-token',
        'x-api-key': 'secret-api-key-value',
        'Content-Type': 'application/json',
      };
      const redacted = redactHeaders(headers);
      expect(redacted['Authorization']).toBe('[REDACTED]');
      expect(redacted['x-api-key']).toBe('[REDACTED]');
      expect(redacted['Content-Type']).toBe('application/json');
    });
  });

  describe('redactErrorMessage', () => {
    it('masks query parameters embedded in error strings', () => {
      const message =
        'Failed to fetch https://api.data.gov.in/resource?api-key=MY_SECRET_KEY&id=1: 403 Forbidden';
      const redacted = redactErrorMessage(message);
      expect(redacted).not.toContain('MY_SECRET_KEY');
      expect(redacted).toContain('api-key=[REDACTED]');
    });

    it('masks Bearer tokens embedded in error strings', () => {
      const message =
        'Authorization header "Bearer hf_9876543210abcdef" was rejected';
      const redacted = redactErrorMessage(message);
      expect(redacted).not.toContain('hf_9876543210abcdef');
      expect(redacted).toContain('Bearer [REDACTED]');
    });
  });
});
