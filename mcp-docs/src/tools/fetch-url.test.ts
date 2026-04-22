import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ReadableStream } from 'node:stream/web';
import { fetchUrl } from './fetch-url.js';
import { DocsCache, type CachedDoc } from '../cache/redis-cache.js';
import * as auditLogger from '../security/audit-logger.js';

const TEST_URL = 'https://docs.example.com/api';

describe('fetchUrl — slice truncation (cached path)', () => {
  let getCachedDocSpy: ReturnType<typeof vi.spyOn>;
  let auditSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    auditSpy = vi.spyOn(auditLogger, 'logOutboundRequest').mockImplementation(() => {});
    getCachedDocSpy = vi.spyOn(DocsCache.prototype, 'getCachedDoc');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockCachedDoc(doc: Partial<CachedDoc>): void {
    const cached: CachedDoc = {
      markdown: doc.markdown ?? '',
      title: doc.title ?? 'Cached',
      url: doc.url ?? TEST_URL,
      fetchedAt: doc.fetchedAt ?? new Date().toISOString(),
      contentLength: doc.contentLength ?? (doc.markdown?.length ?? 0),
    };
    getCachedDocSpy.mockResolvedValue(cached);
  }

  it('startIndex past the end returns empty markdown with truncated=false', async () => {
    mockCachedDoc({ markdown: 'a'.repeat(1000), contentLength: 1000 });

    const result = await fetchUrl(TEST_URL, null, { maxLength: 100, startIndex: 999_999 });

    expect(result.markdown).toBe('');
    expect(result.truncated).toBe(false);
    expect(result.contentLength).toBe(1000);
    expect(result.cached).toBe(true);
  });

  it('startIndex exactly at contentLength returns empty with truncated=false', async () => {
    mockCachedDoc({ markdown: 'a'.repeat(500), contentLength: 500 });

    const result = await fetchUrl(TEST_URL, null, { maxLength: 100, startIndex: 500 });

    expect(result.markdown).toBe('');
    expect(result.truncated).toBe(false);
  });

  it('negative startIndex is clamped to 0', async () => {
    mockCachedDoc({ markdown: 'abcdefghij', contentLength: 10 });

    const result = await fetchUrl(TEST_URL, null, { maxLength: 5, startIndex: -50 });

    expect(result.markdown).toBe('abcde');
    expect(result.truncated).toBe(true);
  });

  it('partial slice (start + maxLength below contentLength) marks truncated=true', async () => {
    mockCachedDoc({ markdown: 'a'.repeat(1000), contentLength: 1000 });

    const result = await fetchUrl(TEST_URL, null, { maxLength: 100, startIndex: 0 });

    expect(result.markdown.length).toBe(100);
    expect(result.truncated).toBe(true);
  });

  it('reading the tail (start + maxLength === contentLength) marks truncated=false', async () => {
    mockCachedDoc({ markdown: 'a'.repeat(1000), contentLength: 1000 });

    const result = await fetchUrl(TEST_URL, null, { maxLength: 100, startIndex: 900 });

    expect(result.markdown.length).toBe(100);
    expect(result.truncated).toBe(false);
  });
});

describe('fetchUrl — response body size cap (uncached path)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let auditSpy: ReturnType<typeof vi.spyOn>;
  let getCachedDocSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    auditSpy = vi.spyOn(auditLogger, 'logOutboundRequest').mockImplementation(() => {});
    // Force cache miss so the fetch path runs
    getCachedDocSpy = vi.spyOn(DocsCache.prototype, 'getCachedDoc').mockResolvedValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects when declared Content-Length exceeds the cap', async () => {
    fetchSpy.mockResolvedValue(
      new Response('ignored', {
        status: 200,
        headers: {
          'Content-Type': 'text/html',
          'Content-Length': String(10 * 1024 * 1024), // 10 MB > 5 MB cap
        },
      }),
    );

    await expect(fetchUrl(TEST_URL, null, {})).rejects.toThrow(/Response too large: 10485760 bytes exceeds/);

    // Audit log fired even on rejection — security-visible event must be observable
    expect(auditSpy).toHaveBeenCalledTimes(1);
    expect(auditSpy.mock.calls[0]![0]).toMatchObject({
      tool: 'fetch_url',
      url: TEST_URL,
      cached: false,
      statusCode: 200,
    });
  });

  it('rejects when actual body exceeds the cap (no Content-Length header)', async () => {
    // Build a body whose decoded byte length exceeds 5 MB. ASCII char === 1 byte.
    const oversized = 'a'.repeat(5 * 1024 * 1024 + 1);
    fetchSpy.mockResolvedValue(
      new Response(oversized, {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      }),
    );

    await expect(fetchUrl(TEST_URL, null, {})).rejects.toThrow(/Response too large: streamed >5242880 bytes/);

    expect(auditSpy).toHaveBeenCalledTimes(1);
    expect(auditSpy.mock.calls[0]![0]).toMatchObject({
      tool: 'fetch_url',
      url: TEST_URL,
      cached: false,
    });
  });

  it('succeeds when body is under the cap', async () => {
    fetchSpy.mockResolvedValue(
      new Response('<html><title>OK</title><body><main>hello world</main></body></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      }),
    );

    const result = await fetchUrl(TEST_URL, null, {});

    expect(result.markdown).toContain('hello world');
    expect(result.title).toBe('OK');
    expect(result.cached).toBe(false);
  });

  it('succeeds when declared Content-Length is exactly at the cap', async () => {
    const body = 'short body';
    fetchSpy.mockResolvedValue(
      new Response(body, {
        status: 200,
        headers: {
          'Content-Type': 'text/plain',
          'Content-Length': String(5 * 1024 * 1024), // == cap, must not throw on header check
        },
      }),
    );

    const result = await fetchUrl(TEST_URL, null, {});
    expect(result.markdown).toBe(body);
  });
});

describe('fetchUrl — streaming reader (chunked, no Content-Length)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let auditSpy: ReturnType<typeof vi.spyOn>;
  let getCachedDocSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    auditSpy = vi.spyOn(auditLogger, 'logOutboundRequest').mockImplementation(() => {});
    getCachedDocSpy = vi.spyOn(DocsCache.prototype, 'getCachedDoc').mockResolvedValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Build a Response whose body is a lazy (pull-based) ReadableStream of
  // `chunkSize`-byte chunks, capped at `maxChunks`. Used for the happy-path
  // chunked test where we want a finite, well-formed body.
  function makeLazyChunkedResponse(opts: {
    chunkSize: number;
    maxChunks: number;
    contentType?: string;
    headers?: Record<string, string>;
  }): Response {
    let enqueuedCount = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (enqueuedCount >= opts.maxChunks) {
          controller.close();
          return;
        }
        controller.enqueue(new Uint8Array(opts.chunkSize).fill(0x61));
        enqueuedCount += 1;
      },
    });
    const headers: Record<string, string> = {
      'Content-Type': opts.contentType ?? 'text/plain',
      ...(opts.headers ?? {}),
    };
    // node:stream/web ReadableStream is structurally compatible with the global
    // ReadableStream that Response expects, but TS sees them as distinct types.
    return new Response(stream as unknown as BodyInit, { status: 200, headers });
  }

  it('aborts a chunked stream and propagates cancel(reason) to the producer', async () => {
    // Eagerly enqueue the entire oversized payload up front (no `pull` callback)
    // and wire `cancel(reason)` so we can prove that reader.cancel('Response too
    // large') in the implementation actually reached the underlying source.
    //
    // A pull-based producer would let the test pass even if reader.cancel() were
    // removed — the moment the consumer stops calling read(), pull() stops firing
    // on its own. Eager enqueue removes that loophole: chunks are queued whether
    // or not the consumer reads them, so only an explicit cancel() can fire the
    // source-side cancel callback.
    let cancelReason: string | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 10; i += 1) {
          controller.enqueue(new Uint8Array(1024 * 1024).fill(0x61));
        }
        // Intentionally do NOT close — leaves the queue full, simulating a
        // server that has already shipped a large prefix.
      },
      cancel(reason) {
        cancelReason = String(reason);
      },
    });
    const response = new Response(stream as unknown as BodyInit, {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    });
    fetchSpy.mockResolvedValue(response);

    await expect(fetchUrl(TEST_URL, null, {})).rejects.toThrow(/Response too large: streamed >5242880 bytes/);

    // Direct proof that reader.cancel('Response too large') propagated. Would
    // not fire if the implementation merely stopped reading without cancelling.
    expect(cancelReason).toBe('Response too large');

    expect(auditSpy).toHaveBeenCalledTimes(1);
    expect(auditSpy.mock.calls[0]![0]).toMatchObject({
      tool: 'fetch_url',
      url: TEST_URL,
      cached: false,
      statusCode: 200,
    });
  });

  it('successfully reads a chunked body that stays under the cap', async () => {
    // 4 chunks * 256 KB = 1 MB total, well under 5 MB cap.
    const response = makeLazyChunkedResponse({
      chunkSize: 256 * 1024,
      maxChunks: 4,
      contentType: 'text/plain',
    });
    fetchSpy.mockResolvedValue(response);

    const result = await fetchUrl(TEST_URL, null, { maxLength: 100 });

    // Body is all 'a' bytes; output is truncated to maxLength.
    expect(result.markdown.length).toBe(100);
    expect(result.markdown[0]).toBe('a');
    expect(result.contentLength).toBe(4 * 256 * 1024);
    expect(result.cached).toBe(false);
  });

  it('throws when response.body is null', async () => {
    // Some response shapes (e.g. 204 No Content, or a mock without a body)
    // have a null body. The streaming reader path must reject explicitly
    // rather than NPE.
    const response = new Response(null, {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    });
    // Force body to null even though the constructor might create one.
    Object.defineProperty(response, 'body', { value: null });
    fetchSpy.mockResolvedValue(response);

    await expect(fetchUrl(TEST_URL, null, {})).rejects.toThrow(/Response body is not readable/);
  });
});
