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
