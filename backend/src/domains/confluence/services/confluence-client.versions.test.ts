import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock undici request (same pattern as confluence-client.test.ts)
vi.mock('undici', () => ({
  request: vi.fn(),
}));

vi.mock('../../../core/utils/ssrf-guard.js', () => ({
  validateUrl: vi.fn(),
  addAllowedBaseUrl: vi.fn(),
  resolveConfluenceUrl: vi.fn((url: string) => url),
}));

vi.mock('../../../core/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../core/utils/tls-config.js', () => ({
  confluenceDispatcher: { isDefaultDispatcher: true },
  buildConnectOptions: vi.fn().mockReturnValue(undefined),
  isVerifySslEnabled: vi.fn().mockReturnValue(true),
}));

vi.mock('./confluence-rate-limiter.js', () => ({
  acquireToken: vi.fn().mockResolvedValue(undefined),
}));

import { request } from 'undici';
import { ConfluenceClient, ConfluenceError } from './confluence-client.js';

const mockRequest = vi.mocked(request);

function jsonResponse(data: unknown, statusCode = 200): { statusCode: number; headers: Record<string, string>; body: { text: () => Promise<string> } } {
  return {
    statusCode,
    headers: {},
    body: { text: async () => JSON.stringify(data) },
  };
}

/** URL (first positional arg) of the n-th `request()` call. */
function calledUrl(n: number): string {
  return String(mockRequest.mock.calls[n]?.[0]);
}

describe('ConfluenceClient version methods (#722)', () => {
  const baseUrl = 'https://confluence.example.com';
  const pat = 'test-pat';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('getPageVersions flattens pagination and maps metadata', async () => {
    // page 1 has a next link, page 2 is final
    mockRequest
      .mockResolvedValueOnce(jsonResponse({
        results: [{ number: 3, when: '2026-01-03T00:00:00Z', by: { displayName: 'A' }, message: 'm3', minorEdit: false }],
        size: 1,
        _links: { next: '/next' },
      }) as never)
      .mockResolvedValueOnce(jsonResponse({
        results: [{ number: 2, when: '2026-01-02T00:00:00Z', by: { displayName: 'B' } }],
        size: 1,
        _links: {},
      }) as never);

    const client = new ConfluenceClient(baseUrl, pat);
    const versions = await client.getPageVersions('123');
    expect(versions.map((v) => v.number)).toEqual([3, 2]);
    expect(versions[0]).toMatchObject({ author: 'A', message: 'm3' });
    expect(versions[1]).toMatchObject({ author: 'B', message: null });
  });

  it('getPageVersions queries the Data Center (experimental) version endpoint, for every pagination page (#780)', async () => {
    // Confluence DC has NO `GET /rest/api/content/{id}/version` (only DELETE of
    // a single version) — the list lives at /rest/experimental/... only. Hitting
    // the stable path 404s on DC, which made every backfill fail (#780).
    mockRequest
      .mockResolvedValueOnce(jsonResponse({
        results: [{ number: 2, when: '2026-01-02T00:00:00Z' }],
        size: 1,
        _links: { next: '/next' },
      }) as never)
      .mockResolvedValueOnce(jsonResponse({
        results: [{ number: 1, when: '2026-01-01T00:00:00Z' }],
        size: 1,
        _links: {},
      }) as never);

    const client = new ConfluenceClient(baseUrl, pat);
    const versions = await client.getPageVersions('123');

    expect(versions.map((v) => v.number)).toEqual([2, 1]);
    expect(calledUrl(0)).toContain('/rest/experimental/content/123/version?');
    expect(calledUrl(0)).toContain('start=0');
    // Pagination must keep using the path that worked — no re-probing.
    expect(calledUrl(1)).toContain('/rest/experimental/content/123/version?');
    expect(calledUrl(1)).toContain('start=100');
  });

  it('getPageVersions falls back to the stable (Cloud-style) path when the experimental one 404s (#780)', async () => {
    mockRequest
      // experimental → 404 (deployment without the experimental resource)
      .mockResolvedValueOnce(jsonResponse({ message: 'no such resource' }, 404) as never)
      // stable path → works, paginated
      .mockResolvedValueOnce(jsonResponse({
        results: [{ number: 2, when: '2026-01-02T00:00:00Z', by: { displayName: 'A' } }],
        size: 1,
        _links: { next: '/next' },
      }) as never)
      .mockResolvedValueOnce(jsonResponse({
        results: [{ number: 1, when: '2026-01-01T00:00:00Z' }],
        size: 1,
        _links: {},
      }) as never);

    const client = new ConfluenceClient(baseUrl, pat);
    const versions = await client.getPageVersions('123');

    expect(versions.map((v) => v.number)).toEqual([2, 1]);
    expect(calledUrl(0)).toContain('/rest/experimental/content/123/version?');
    expect(calledUrl(1)).toContain('/rest/api/content/123/version?');
    // Page 2 reuses the stable path directly — the experimental one is not re-probed.
    expect(calledUrl(2)).toContain('/rest/api/content/123/version?');
    expect(calledUrl(2)).toContain('start=100');
    expect(mockRequest).toHaveBeenCalledTimes(3);
  });

  it('getPageVersions throws a combined ConfluenceError when both paths 404 (#780)', async () => {
    mockRequest.mockResolvedValue(jsonResponse({ message: 'nope' }, 404) as never);

    const client = new ConfluenceClient(baseUrl, pat);
    await expect(client.getPageVersions('123')).rejects.toThrow(
      /rest\/experimental\/content\/123\/version.*rest\/api\/content\/123\/version/s,
    );
    expect(mockRequest).toHaveBeenCalledTimes(2);
  });

  it('getPageVersions does NOT fall back on non-404 errors (e.g. 403) — the real error propagates', async () => {
    mockRequest.mockResolvedValue(jsonResponse({ message: 'forbidden' }, 403) as never);

    const client = new ConfluenceClient(baseUrl, pat);
    await expect(client.getPageVersions('123')).rejects.toThrow(ConfluenceError);
    await expect(client.getPageVersions('123')).rejects.toThrow(/permission/i);
    // 403 is not retried and not fallback-eligible: exactly one HTTP call per attempt.
    expect(mockRequest).toHaveBeenCalledTimes(2);
  });

  it('getPageVersions stops on an empty page even when a next link persists (pagination guard)', async () => {
    // Page 1 has data + a next link; page 2 is EMPTY but STILL advertises a
    // next link (a misbehaving / self-referential API). Without the guard this
    // would loop forever; the empty-results break stops it after page 2.
    mockRequest
      .mockResolvedValueOnce(jsonResponse({
        results: [{ number: 1, when: '2026-01-01T00:00:00Z' }],
        size: 1,
        _links: { next: '/next' },
      }) as never)
      .mockResolvedValue(jsonResponse({
        results: [],
        size: 0,
        _links: { next: '/self-referential' },
      }) as never);

    const client = new ConfluenceClient(baseUrl, pat);
    const versions = await client.getPageVersions('789');
    expect(versions).toHaveLength(1);
    // Exactly two fetches: the data page and the empty page that triggers the break.
    expect(mockRequest).toHaveBeenCalledTimes(2);
  });

  it('getPageVersions handles missing by field gracefully', async () => {
    mockRequest.mockResolvedValueOnce(jsonResponse({
      results: [{ number: 1, when: '2026-01-01T00:00:00Z' }],
      size: 1,
      _links: {},
    }) as never);

    const client = new ConfluenceClient(baseUrl, pat);
    const versions = await client.getPageVersions('456');
    expect(versions[0]).toMatchObject({ number: 1, author: null, message: null, minorEdit: false });
  });

  it('getHistoricalPageBody returns the historical storage XHTML', async () => {
    mockRequest.mockResolvedValueOnce(jsonResponse({
      body: { storage: { value: '<p>old</p>' } },
    }) as never);

    const client = new ConfluenceClient(baseUrl, pat);
    expect(await client.getHistoricalPageBody('123', 2)).toBe('<p>old</p>');
  });

  it('getHistoricalPageBody returns empty string when body is absent', async () => {
    mockRequest.mockResolvedValueOnce(jsonResponse({}) as never);

    const client = new ConfluenceClient(baseUrl, pat);
    expect(await client.getHistoricalPageBody('123', 2)).toBe('');
  });
});
