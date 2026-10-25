import { describe, expect, it, vi } from 'vitest';
import { safeFetch } from '../src/toolkit/safe-fetch.js';
import { SsrfError } from '../src/toolkit/ssrf.js';

// Helper: create a mock Response whose body is a ReadableStream that drips
// chunks on a timer, simulating a slow server.
function slowDripResponse(
  chunkSize: number,
  chunkCount: number,
  intervalMs: number,
): Response {
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (sent >= chunkCount) {
        controller.close();
        return;
      }
      await new Promise((r) => setTimeout(r, intervalMs));
      controller.enqueue(new Uint8Array(chunkSize).fill(0x41));
      sent++;
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'application/octet-stream' },
  });
}

const publicDns = {
  dnsResolver: async () => [{ address: '93.184.216.34', family: 4 as const }],
};

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
        ssrfOptions: publicDns,
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
        ssrfOptions: publicDns,
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
      ssrfOptions: publicDns,
      retryOptions: { maxRetries: 0 },
    });

    expect(res.status).toBe(200);
    const json = await res.json<{ datasets: Array<{ id: string; name: string }> }>();
    expect(json.datasets).toHaveLength(1);
    expect(json.datasets[0]?.name).toBe('rainfall');

    vi.restoreAllMocks();
  });

  // --- New tests for Commit 1 fixes ---

  it('rejects immediately when caller signal is pre-aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    // Mock fetch to verify it's never called.
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await expect(
      safeFetch('https://example.com/api', {
        signal: controller.signal,
        ssrfOptions: publicDns,
        retryOptions: { maxRetries: 0 },
      }),
    ).rejects.toThrow(/abort/i);

    // fetch should never have been called — the abort fires before
    // the request is sent.
    expect(fetchSpy).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });

  it('aborts slow-drip body read when deadline expires', async () => {
    // 10 chunks of 100 bytes each, dripped every 200ms = 2s total.
    // With a 500ms timeout, the body read should be aborted mid-stream.
    const mockResponse = slowDripResponse(100, 10, 200);
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockResponse);

    const start = Date.now();
    const res = await safeFetch('https://example.com/slow-drip', {
      timeoutMs: 500,
      ssrfOptions: publicDns,
      retryOptions: { maxRetries: 0 },
    });

    // Headers arrive immediately (status 200), but reading the body should fail.
    expect(res.status).toBe(200);
    await expect(res.bytes()).rejects.toThrow();

    const elapsed = Date.now() - start;
    // Should have given up well before the 2s it takes for all chunks.
    expect(elapsed).toBeLessThan(1500);

    vi.restoreAllMocks();
  });
});
