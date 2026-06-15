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
