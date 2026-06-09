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
import { ConfluenceClient } from './confluence-client.js';

const mockRequest = vi.mocked(request);

function jsonResponse(data: unknown): { statusCode: number; headers: Record<string, string>; body: { text: () => Promise<string> } } {
  return {
    statusCode: 200,
    headers: {},
    body: { text: async () => JSON.stringify(data) },
  };
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
