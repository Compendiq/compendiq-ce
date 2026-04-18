import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

    await expect(fetchUrl(TEST_URL, null, {})).rejects.toThrow(/Response too large: 5242881 bytes exceeds/);

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
