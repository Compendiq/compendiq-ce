import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { searchWeb } from './search-web.js';
import { DocsCache } from '../cache/redis-cache.js';

describe('searchWeb error signaling', () => {
  let setCachedSearchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.spyOn(DocsCache.prototype, 'getCachedSearch').mockResolvedValue(null);
    setCachedSearchSpy = vi
      .spyOn(DocsCache.prototype, 'setCachedSearch')
      .mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('throws on a network failure and does NOT cache it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    await expect(searchWeb('hello world', null, {})).rejects.toThrow(/unavailable/);
    expect(setCachedSearchSpy).not.toHaveBeenCalled();
  });

  it('throws on a non-2xx response and does NOT cache it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    await expect(searchWeb('hello world', null, {})).rejects.toThrow(/unavailable/);
    expect(setCachedSearchSpy).not.toHaveBeenCalled();
  });

  it('returns [] and caches a genuinely-empty successful response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [] }),
    }));
    const out = await searchWeb('hello world', null, {});
    expect(out).toEqual([]);
    expect(setCachedSearchSpy).toHaveBeenCalledOnce();
  });
});

describe('searchWeb categories (#1769)', () => {
  let getCachedSearchSpy: ReturnType<typeof vi.spyOn>;
  let setCachedSearchSpy: ReturnType<typeof vi.spyOn>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    getCachedSearchSpy = vi.spyOn(DocsCache.prototype, 'getCachedSearch').mockResolvedValue(null);
    setCachedSearchSpy = vi.spyOn(DocsCache.prototype, 'setCachedSearch').mockResolvedValue(undefined);
    fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ results: [] }) });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function requestedCategories(): string | null {
    return new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams.get('categories');
  }

  it('asks SearXNG for the default category general when none is given', async () => {
    await searchWeb('hello world', null, {});
    expect(requestedCategories()).toBe('general');
  });

  it('asks SearXNG for the given categories verbatim', async () => {
    await searchWeb('hello world', null, { categories: 'general,it' });
    expect(requestedCategories()).toBe('general,it');
  });

  it('reads and writes the cache under the requested categories', async () => {
    await searchWeb('hello world', null, { numResults: 3, categories: 'it' });

    expect(getCachedSearchSpy).toHaveBeenCalledWith('hello world', 3, 'it');
    expect(setCachedSearchSpy).toHaveBeenCalledWith('hello world', 3, 'it', expect.objectContaining({ query: 'hello world' }));
  });
});
