import { describe, it, expect, vi } from 'vitest';
import { DocsCache, type CachedDoc } from './redis-cache.js';

function makeDoc(url: string, title: string): CachedDoc {
  return { markdown: '# ' + title, title, url, fetchedAt: '2026-06-14T00:00:00Z', contentLength: 4 };
}

describe('DocsCache.listCachedDocs', () => {
  it('skips a corrupted cache entry instead of aborting the whole list', async () => {
    const good = makeDoc('https://a.example/doc', 'Alpha');
    const store: Record<string, string> = {
      'mcp:docs:url:1': JSON.stringify(good),
      'mcp:docs:url:2': '{not valid json', // corrupted
      'mcp:docs:url:3': JSON.stringify(makeDoc('https://b.example/doc', 'Beta')),
    };
    const fakeRedis = {
      scan: vi.fn().mockResolvedValue({ cursor: 0, keys: Object.keys(store) }),
      get: vi.fn(async (k: string) => store[k] ?? null),
    } as unknown as ConstructorParameters<typeof DocsCache>[0];

    const cache = new DocsCache(fakeRedis);
    const docs = await cache.listCachedDocs();

    // Both well-formed docs are returned; the corrupted one is skipped (not a throw).
    expect(docs.map((d) => d.title).sort()).toEqual(['Alpha', 'Beta']);
  });

  it('returns [] when redis is unavailable', async () => {
    const cache = new DocsCache(null);
    await expect(cache.listCachedDocs()).resolves.toEqual([]);
  });
});

describe('DocsCache cache identity and TTL (#1769)', () => {
  function recordingRedis() {
    const store = new Map<string, string>();
    const setEx = vi.fn(async (key: string, _ttl: number, value: string) => { store.set(key, value); });
    const redis = { get: async (key: string) => store.get(key) ?? null, setEx } as unknown as ConstructorParameters<typeof DocsCache>[0];
    return { store, setEx, redis };
  }

  function search(title: string) {
    return { query: 'kubernetes scaling', fetchedAt: '2026-11-11T00:00:00Z', results: [{ title, url: 'https://example.test/1', snippet: 's' }] };
  }

  it('keys a search by query, width and categories under mcp:docs:search:v3:', async () => {
    const { store, redis } = recordingRedis();
    const cache = new DocsCache(redis);

    await cache.setCachedSearch('kubernetes scaling', 5, 'it', search('it'));
    await cache.setCachedSearch('kubernetes scaling', 5, 'general', search('general'));

    expect([...store.keys()].sort()).toEqual([
      expect.stringMatching(/^mcp:docs:search:v3:[0-9a-f]{16}$/),
      expect.stringMatching(/^mcp:docs:search:v3:[0-9a-f]{16}$/),
    ]);
    expect(await cache.getCachedSearch('kubernetes scaling', 5, 'it')).toEqual(search('it'));
    expect(await cache.getCachedSearch('kubernetes scaling', 5, 'general')).toEqual(search('general'));
    expect(await cache.getCachedSearch('kubernetes scaling', 5, 'science')).toBeNull();
  });

  it('stores a document under mcp:docs:url: with the TTL it was constructed with', async () => {
    const { setEx, redis } = recordingRedis();

    await new DocsCache(redis, 60).setCachedDoc('https://docs.example/a', makeDoc('https://docs.example/a', 'Alpha'));

    expect(setEx).toHaveBeenCalledWith(expect.stringMatching(/^mcp:docs:url:[0-9a-f]{16}$/), 60, expect.any(String));
  });
});
