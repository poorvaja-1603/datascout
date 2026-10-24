import { describe, expect, it, vi } from 'vitest';
import { safeFetch } from '../src/toolkit/safe-fetch.js';
import { SsrfError } from '../src/toolkit/ssrf.js';

describe('safeFetch', () => {
  it('blocks requests to private IP ranges before sending', async () => {
    await expect(safeFetch('https://127.0.0.1/api')).rejects.toThrow(SsrfError);
    await expect(safeFetch('https://169.254.169.254/latest/meta-data')).rejects.toThrow(SsrfError);
  });

  it('rejects non-HTTPS schemes', async () => {
    await expect(safeFetch('http://example.com')).rejects.toThrow(/Only HTTPS is permitted/);
    await expect(safeFetch('file:///etc/hosts')).rejects.toThrow(/Only HTTPS is permitted/);
  });

  it('enforces maximum response bytes limit', async () => {
    // Mock global.fetch returning a large stream
    const mockData = 'x'.repeat(1000);
    const mockResponse = new Response(mockData, {
      status: 200,
      headers: { 'Content-Type': 'text/plain', 'Content-Length': '1000' },
    });

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockResponse);

    await expect(
      safeFetch('https://example.com/huge-file', {
        maxBytes: 500,
        ssrfOptions: {
          dnsResolver: async () => [{ address: '93.184.216.34', family: 4 }],
        },
        retryOptions: { maxRetries: 0 },
      }),
    ).rejects.toThrow(/Response size 1000 bytes exceeds maximum limit/);

    vi.restoreAllMocks();
  });

  it('enforces allowed content-types when specified', async () => {
    const mockResponse = new Response('<html>Not JSON</html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    });

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockResponse);

    await expect(
      safeFetch('https://example.com/api', {
        allowedContentTypes: ['application/json'],
        ssrfOptions: {
          dnsResolver: async () => [{ address: '93.184.216.34', family: 4 }],
        },
        retryOptions: { maxRetries: 0 },
      }),
    ).rejects.toThrow(/Unexpected Content-Type 'text\/html'/);

    vi.restoreAllMocks();
  });

  it('fetches and parses JSON successfully for safe endpoints', async () => {
    const payload = { datasets: [{ id: '1', name: 'rainfall' }] };
    const mockResponse = new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockResponse);

    const res = await safeFetch('https://api.data.gov.in/catalogs', {
      ssrfOptions: {
        dnsResolver: async () => [{ address: '93.184.216.34', family: 4 }],
      },
      retryOptions: { maxRetries: 0 },
    });

    expect(res.status).toBe(200);
    const json = await res.json<{ datasets: Array<{ id: string; name: string }> }>();
    expect(json.datasets).toHaveLength(1);
    expect(json.datasets[0]?.name).toBe('rainfall');

    vi.restoreAllMocks();
  });
});
