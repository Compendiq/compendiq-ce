import { createHash, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { createClient, type RedisClientType } from 'redis';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { fetchUrl } from './fetch-url.js';
import { listCached } from './list-cached.js';
import { DocsCache } from '../cache/redis-cache.js';
import * as auditLogger from '../security/audit-logger.js';
import * as domainFilter from '../security/domain-filter.js';

/**
 * #1770 — a cached document holds at most the first 100 000 characters of its
 * markdown, whatever the download size (up to MAX_RESPONSE_BYTES = 5 MiB), and
 * paging stays correct: a window the stored prefix cannot answer in full is
 * fetched again.
 *
 * `fetchUrl`, `DocsCache` and `listCached` run for real against real Redis.
 * Only the network hop and the admin domain policy are replaced: the SSRF
 * guard refuses loopback and every private range, so a local HTTP server
 * cannot serve the document — DNS resolves to a public address and the global
 * `fetch` is a counting upstream.
 *
 * The numbers below are LITERAL on purpose (100 000 characters, 512 KiB,
 * 5 138 022 bytes): they pin the bound from outside the implementation.
 *
 * Real Redis is mandatory (docs/claude/content-pipeline.md → SearXNG Sidecar):
 * a missing MCP_DOCS_TEST_REDIS_URL fails the file and an unreachable Redis
 * fails every test — nothing is skipped.
 */

const redisUrl = process.env.MCP_DOCS_TEST_REDIS_URL;
if (!redisUrl) {
  throw new Error('MCP_DOCS_TEST_REDIS_URL must point to real Redis for the document-cache bound regression');
}

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
}));

// 5 MiB fixtures: against an unbounded cache every read moves ~5.6 MB through
// Redis, so a loaded machine needs more than the 5 s default to fail on the
// assertion instead of the clock.
vi.setConfig({ testTimeout: 30_000 });

const KIB = 1024;
/** 4.9 MiB — below MAX_RESPONSE_BYTES (5 242 880), so the download is accepted. */
const BIG_LENGTH = 5_138_022;

/** `length` characters of 10-character records `000000000\n`, `000000001\n`, …: every offset is identifiable. */
function numberedText(length: number): string {
  let text = '';
  for (let record = 0; text.length < length; record += 1) text += `${String(record).padStart(9, '0')}\n`;
  return text.slice(0, length);
}

const BIG = numberedText(BIG_LENGTH);

/** The document-cache key — its namespace and derivation are unchanged by #1770. */
function docKey(url: string): string {
  return `mcp:docs:url:${createHash('sha256').update(url).digest('hex').slice(0, 16)}`;
}

interface StoredEntry {
  markdown: string;
  title: string;
  url: string;
  fetchedAt: string;
  contentLength: number;
  storedLength?: number;
}

// No reconnect loop: an unreachable Redis rejects the connect at once.
const redis: RedisClientType = createClient({ url: redisUrl, socket: { reconnectStrategy: false } });
/** The fake upstream: one document per URL and how often it was requested. */
const upstream = new Map<string, { body: string; contentType: string; status: number; requests: number }>();
const createdKeys: string[] = [];
let auditSpy: MockInstance<typeof auditLogger.logOutboundRequest>;

/** Registers a document on the fake upstream under a URL no earlier run has cached. */
function serve(name: string, body: string, contentType = 'text/plain; charset=utf-8'): string {
  const url = `https://docs.example.com/${randomUUID()}/${name}`;
  upstream.set(url, { body, contentType, status: 200, requests: 0 });
  createdKeys.push(docKey(url));
  return url;
}

function requests(url: string): number {
  return upstream.get(url)?.requests ?? 0;
}

async function storedEntry(url: string): Promise<StoredEntry> {
  const raw = await redis.get(docKey(url));
  if (raw === null) throw new Error(`no cache entry for ${url}`);
  return JSON.parse(raw) as StoredEntry;
}

afterAll(async () => {
  if (redis.isOpen) await redis.quit();
});

beforeEach(async () => {
  // Connected here rather than in beforeAll: with Redis unreachable every test
  // then FAILS — a failed beforeAll would report them as skipped.
  if (!redis.isOpen) await redis.connect();
  vi.mocked(lookup).mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never);
  auditSpy = vi.spyOn(auditLogger, 'logOutboundRequest').mockImplementation(() => {});
  // The domain policy is admin configuration read from the same Redis
  // (mcp:docs:config:domains). Pin the default, so a policy another suite left
  // there cannot refuse the fixture host.
  vi.spyOn(domainFilter, 'getDomainConfig').mockResolvedValue({ mode: 'blocklist', allowedDomains: ['*'], blockedDomains: [] });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const doc = upstream.get(href);
    if (!doc) return new Response('no such document', { status: 404, statusText: 'Not Found' });
    doc.requests += 1;
    if (doc.status !== 200) return new Response('upstream failure', { status: doc.status, statusText: 'Upstream Failure' });
    return new Response(doc.body, { status: 200, headers: { 'content-type': doc.contentType } });
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  upstream.clear();
  // Only the keys this file created; shared Redis is never flushed.
  if (createdKeys.length > 0) await redis.del(createdKeys.splice(0));
});

describe('a first call returns what the pre-#1770 sidecar returned and leaves a bounded entry (#1770, golden)', () => {
  // Captured from origin/dev 3a7761fe (unbounded cache) with this fixture: the
  // SHA-256 of the markdown a first call returned, per requested window. The
  // response is asserted first, so origin/dev gets past it and fails on the
  // stored entry — proof that the literals are its output.
  it.each([
    {
      window: 'the default first page',
      options: {},
      slice: [0, 10_000],
      markdownSha256: 'd0e29071658456b738e531df1383a7bb4d99e70e2dc542b98f76b680515199b9',
      truncated: true,
    },
    {
      window: 'max_length 100000',
      options: { maxLength: 100_000 },
      slice: [0, 100_000],
      markdownSha256: '3716aadb054b729255c25b7337a1d0a1832c3e30ca3f44a0b3bf9a0c62ccb4b2',
      truncated: true,
    },
    {
      window: 'start_index 5100000, max_length 100000',
      options: { startIndex: 5_100_000, maxLength: 100_000 },
      slice: [5_100_000, 5_138_022],
      markdownSha256: 'a4f3d5a3e27ca150d3ad1e90627c58538e2ff7b33bdbc7edf1ea5396d1a77233',
      truncated: false,
    },
  ])('4.9 MiB plain-text document, $window: same response, at most 100 000 characters and < 512 KiB stored', async ({ options, slice, markdownSha256, truncated }) => {
    const url = serve('big.txt', BIG);

    const first = await fetchUrl(url, redis, { userId: 'golden', ...options });

    expect({ ...first, markdown: createHash('sha256').update(first.markdown).digest('hex') }).toEqual({
      markdown: markdownSha256,
      title: 'big.txt',
      url,
      cached: false,
      contentLength: 5_138_022,
      truncated,
    });
    expect(first.markdown === BIG.slice(slice[0], slice[1])).toBe(true);
    expect(requests(url)).toBe(1);
    const serializedBytes = await redis.strLen(docKey(url));
    expect(serializedBytes).toBeGreaterThan(100_000);
    expect(serializedBytes).toBeLessThan(512 * KIB);
    const entry = await storedEntry(url);
    expect(Object.keys(entry).sort()).toEqual(['contentLength', 'fetchedAt', 'markdown', 'storedLength', 'title', 'url']);
    expect(entry.markdown === BIG.slice(0, 100_000)).toBe(true);
    expect(entry).toMatchObject({ title: 'big.txt', url, contentLength: 5_138_022, storedLength: 100_000 });
  });

  it('short HTML document: same response, stored in full with storedLength === contentLength', async () => {
    const url = serve(
      'guide.html',
      '<html><head><title> Install Guide </title></head><body><nav>skip me</nav>'
        + '<main><h1>Install</h1><p>Run <code>npm ci</code> first.</p><ul><li>one</li><li>two</li></ul></main>'
        + '<footer>skip me too</footer></body></html>',
      'text/html; charset=utf-8',
    );

    const first = await fetchUrl(url, redis, { userId: 'golden', maxLength: 5_000 });

    expect(first).toEqual({
      markdown: '# Install\n\nRun `npm ci` first.\n\n*   one\n*   two',
      title: 'Install Guide',
      url,
      cached: false,
      contentLength: 47,
      truncated: false,
    });
    expect(await storedEntry(url)).toMatchObject({
      markdown: '# Install\n\nRun `npm ci` first.\n\n*   one\n*   two',
      title: 'Install Guide',
      url,
      contentLength: 47,
      storedLength: 47,
    });
  });
});

describe('document cache bound against real Redis and a counting upstream (#1770)', () => {
  it('serves a 100 000-character first page of the bounded entry from the cache: one upstream request in total', async () => {
    const url = serve('big.txt', BIG);
    await fetchUrl(url, redis, { cacheTtl: 600 });

    const second = await fetchUrl(url, redis, { startIndex: 0, maxLength: 100_000, userId: 'first-page-reader', cacheTtl: 60 });

    expect(await redis.strLen(docKey(url))).toBeLessThan(512 * KIB);
    expect(second).toMatchObject({ title: 'big.txt', url, cached: true, contentLength: 5_138_022, truncated: true });
    expect(second.markdown.length).toBe(100_000);
    expect(second.markdown === BIG.slice(0, 100_000)).toBe(true);
    expect(requests(url)).toBe(1);
    // Audited as a cache hit with the full length, as before.
    expect(auditSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ tool: 'fetch_url', url, userId: 'first-page-reader', cached: true, contentLength: 5_138_022 }),
    );
    // A hit never rewrites the entry, so its TTL is still the first call's.
    expect(await redis.ttl(docKey(url))).toBeGreaterThan(60);
  });

  it('serves the largest page fetch_url can return from the cache: the stored bound is not below the tool ceiling', async () => {
    const url = serve('big.txt', BIG);
    await fetchUrl(url, redis, {});

    // Any max_length above the tool ceiling (ABSOLUTE_MAX_LENGTH) is clamped to it.
    const second = await fetchUrl(url, redis, { maxLength: 9_999_999 });

    expect(await redis.strLen(docKey(url))).toBeLessThan(512 * KIB);
    expect(second.cached).toBe(true);
    expect(second.markdown.length).toBe(100_000);
    expect(requests(url)).toBe(1);
  });

  it('refetches a page that starts at the stored bound: one more upstream request, the exact characters, Cached false, entry re-stored bounded', async () => {
    const url = serve('big.txt', BIG);
    await fetchUrl(url, redis, { cacheTtl: 600 });
    auditSpy.mockClear();

    const deep = await fetchUrl(url, redis, { startIndex: 100_000, userId: 'deep-reader', cacheTtl: 120 });

    expect(requests(url)).toBe(2);
    expect(deep).toMatchObject({ title: 'big.txt', url, cached: false, contentLength: 5_138_022, truncated: true });
    expect(deep.markdown).toBe(BIG.slice(100_000, 110_000));
    // The refetch is an outbound request and is audited as one — not as a cache hit.
    expect(auditSpy.mock.calls.map(([entry]) => entry)).toEqual([
      expect.objectContaining({ tool: 'fetch_url', url, userId: 'deep-reader', cached: false, statusCode: 200, contentLength: 5_138_022 }),
    ]);
    // Re-stored bounded, with the TTL of the call that refetched.
    expect(await redis.strLen(docKey(url))).toBeLessThan(512 * KIB);
    expect(await storedEntry(url)).toMatchObject({ contentLength: 5_138_022, storedLength: 100_000 });
    const ttl = await redis.ttl(docKey(url));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(120);
  });

  it('pages a deep window of the maximum size correctly after a refetch', async () => {
    const url = serve('big.txt', BIG);
    await fetchUrl(url, redis, {});

    const deep = await fetchUrl(url, redis, { startIndex: 5_100_000, maxLength: 100_000 });

    expect(requests(url)).toBe(2);
    expect(deep.cached).toBe(false);
    expect(deep.markdown.length).toBe(38_022);
    expect(deep.markdown === BIG.slice(5_100_000)).toBe(true);
    expect(deep.truncated).toBe(false);
  });

  it('never answers with a short slice: a window crossing the stored bound is refetched, a window ending on it is a hit', async () => {
    const url = serve('big.txt', BIG);
    await fetchUrl(url, redis, {});

    const endsOnBound = await fetchUrl(url, redis, { startIndex: 90_000, maxLength: 10_000 });
    const requestsAfterHit = requests(url);
    const crossesBound = await fetchUrl(url, redis, { startIndex: 95_000, maxLength: 10_000 });

    expect(endsOnBound.cached).toBe(true);
    expect(endsOnBound.markdown).toBe(BIG.slice(90_000, 100_000));
    expect(requestsAfterHit).toBe(1);
    expect(crossesBound.markdown.length).toBe(10_000);
    expect(crossesBound.markdown).toBe(BIG.slice(95_000, 105_000));
    expect(crossesBound.cached).toBe(false);
    expect(requests(url)).toBe(2);
  });

  it('answers an empty window of a bounded entry from the cache: at or past the end, or zero characters, nothing is refetched', async () => {
    const url = serve('big.txt', BIG);
    await fetchUrl(url, redis, {});

    const atEnd = await fetchUrl(url, redis, { startIndex: 5_138_022 });
    const pastEnd = await fetchUrl(url, redis, { startIndex: 9_999_999, maxLength: 100 });
    const zeroWide = await fetchUrl(url, redis, { startIndex: 200_000, maxLength: 0 });

    expect(await redis.strLen(docKey(url))).toBeLessThan(512 * KIB);
    expect(atEnd).toMatchObject({ markdown: '', cached: true, contentLength: 5_138_022, truncated: false });
    expect(pastEnd).toMatchObject({ markdown: '', cached: true, contentLength: 5_138_022, truncated: false });
    expect(zeroWide).toMatchObject({ markdown: '', cached: true, contentLength: 5_138_022, truncated: true });
    expect(requests(url)).toBe(1);
  });

  it.each([
    [60_000],
    [100_000],
  ])('stores a %i-character document in full with storedLength === contentLength and serves deep reads from the cache', async (length) => {
    const text = numberedText(length);
    const url = serve('short.txt', text);

    const first = await fetchUrl(url, redis, {});
    const tail = await fetchUrl(url, redis, { startIndex: length - 5_000 });
    const middle = await fetchUrl(url, redis, { startIndex: 30_000, maxLength: 100_000 });
    const atEnd = await fetchUrl(url, redis, { startIndex: length });

    expect(first).toMatchObject({ markdown: text.slice(0, 10_000), cached: false, contentLength: length, truncated: true });
    expect(tail).toMatchObject({ markdown: text.slice(length - 5_000), cached: true, contentLength: length, truncated: false });
    expect(middle.markdown === text.slice(30_000)).toBe(true);
    expect(middle).toMatchObject({ cached: true, truncated: false });
    expect(atEnd).toMatchObject({ markdown: '', cached: true, truncated: false });
    expect(requests(url)).toBe(1);
    const entry = await storedEntry(url);
    expect(entry.markdown === text).toBe(true);
    expect(entry.contentLength).toBe(length);
    expect(entry.storedLength).toBe(length);
  });

  it('bounds the converted markdown of an HTML document, not its HTML source, and refetches and reconverts a deep page', async () => {
    // 1 200 paragraphs of 105 characters: few DOM nodes, yet 128 398 characters of markdown.
    const lines = Array.from({ length: 1_200 }, (_, index) => `paragraph ${String(index).padStart(4, '0')} ${'abcdefghij'.repeat(9)}`);
    const markdown = lines.join('\n\n');
    const url = serve(
      'manual.html',
      `<html><head><title>Manual</title></head><body><main>${lines.map((line) => `<p>${line}</p>`).join('')}</main></body></html>`,
      'text/html; charset=utf-8',
    );

    const first = await fetchUrl(url, redis, {});
    const deep = await fetchUrl(url, redis, { startIndex: 100_000 });

    expect(markdown.length).toBe(128_398);
    expect(first).toMatchObject({ markdown: markdown.slice(0, 10_000), title: 'Manual', cached: false, contentLength: 128_398, truncated: true });
    const entry = await storedEntry(url);
    expect(entry.storedLength).toBe(100_000);
    expect(entry.markdown === markdown.slice(0, 100_000)).toBe(true);
    expect(entry).toMatchObject({ title: 'Manual', contentLength: 128_398 });
    expect(deep).toMatchObject({ markdown: markdown.slice(100_000, 110_000), title: 'Manual', cached: false, contentLength: 128_398, truncated: true });
    expect(requests(url)).toBe(2);
  });

  it('keeps the bound exact and the text intact when it falls inside a surrogate pair; the character past it is refetched', async () => {
    // 100 001 UTF-16 units: the pair of U+1F600 occupies indices 99 999 and 100 000.
    const text = `${numberedText(99_999)}\u{1F600}`;
    const url = serve('emoji.txt', text);
    await fetchUrl(url, redis, {});

    const firstPage = await fetchUrl(url, redis, { maxLength: 100_000 });
    const lastStored = await fetchUrl(url, redis, { startIndex: 99_990, maxLength: 10 });
    const requestsAfterHits = requests(url);
    const acrossBound = await fetchUrl(url, redis, { startIndex: 99_995, maxLength: 10 });

    expect(firstPage).toMatchObject({ cached: true, contentLength: 100_001, truncated: true });
    expect(firstPage.markdown === text.slice(0, 100_000)).toBe(true);
    expect(lastStored).toMatchObject({ markdown: text.slice(99_990, 100_000), cached: true, truncated: true });
    expect(lastStored.markdown.charCodeAt(9)).toBe(0xd83d);
    expect(requestsAfterHits).toBe(1);
    expect(acrossBound.cached).toBe(false);
    expect(acrossBound).toMatchObject({ markdown: text.slice(99_995), contentLength: 100_001, truncated: false });
    expect(requests(url)).toBe(2);
    expect(await storedEntry(url)).toMatchObject({ contentLength: 100_001, storedLength: 100_000 });
  });

  it('surfaces a failed refetch and leaves the bounded entry usable', async () => {
    const url = serve('big.txt', BIG);
    await fetchUrl(url, redis, {});
    const before = await redis.get(docKey(url));
    upstream.get(url)!.status = 503;

    await expect(fetchUrl(url, redis, { startIndex: 200_000, maxLength: 10 })).rejects.toThrow('Fetch failed: 503 Upstream Failure');

    expect(requests(url)).toBe(2);
    expect((await redis.get(docKey(url))) === before).toBe(true);
    const firstPage = await fetchUrl(url, redis, {});
    expect(firstPage).toMatchObject({ markdown: BIG.slice(0, 10_000), cached: true, contentLength: 5_138_022 });
    expect(requests(url)).toBe(2);
  });

  it('a refetch serves and re-stores the fresh document when the upstream changed in between', async () => {
    const url = serve('big.txt', BIG);
    await fetchUrl(url, redis, {});
    const fresh = numberedText(150_000).replaceAll('0', 'x');
    upstream.get(url)!.body = fresh;

    const deep = await fetchUrl(url, redis, { startIndex: 100_000 });
    const firstPageAgain = await fetchUrl(url, redis, {});

    expect(requests(url)).toBe(2);
    expect(deep).toMatchObject({ markdown: fresh.slice(100_000, 110_000), cached: false, contentLength: 150_000, truncated: true });
    expect(firstPageAgain).toMatchObject({ markdown: fresh.slice(0, 10_000), cached: true, contentLength: 150_000, truncated: true });
    const entry = await storedEntry(url);
    expect(entry.markdown === fresh.slice(0, 100_000)).toBe(true);
    expect(entry).toMatchObject({ contentLength: 150_000, storedLength: 100_000 });
  });

  it('reads a legacy entry without storedLength next to a bounded one: every legacy window from the cache, both listed with their full contentLength', async () => {
    // An upgraded sidecar finds entries of the previous release beside its own.
    const boundedUrl = serve('big.txt', BIG);
    const directory = boundedUrl.slice(0, boundedUrl.lastIndexOf('/') + 1);
    const legacyUrl = `${directory}legacy.txt`;
    createdKeys.push(docKey(legacyUrl));
    const legacyText = numberedText(250_000);
    // Exactly what the previous release wrote: the whole document, no storedLength.
    const legacy = JSON.stringify({
      markdown: legacyText,
      title: 'Legacy document',
      url: legacyUrl,
      fetchedAt: '2026-11-01T00:00:00.000Z',
      contentLength: 250_000,
    });
    await redis.setEx(docKey(legacyUrl), 300, legacy);

    const firstPage = await fetchUrl(legacyUrl, redis, {});
    const deep = await fetchUrl(legacyUrl, redis, { startIndex: 150_000, maxLength: 100_000 });
    await fetchUrl(boundedUrl, redis, {});
    const listed = await listCached(redis, directory);

    expect(firstPage).toEqual({
      markdown: legacyText.slice(0, 10_000), title: 'Legacy document', url: legacyUrl, cached: true, contentLength: 250_000, truncated: true,
    });
    expect(deep.markdown === legacyText.slice(150_000)).toBe(true);
    expect(deep).toMatchObject({ cached: true, contentLength: 250_000, truncated: false });
    // The legacy document is never requested upstream (the one request is the new document's), and a hit never rewrites its entry.
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(requests(boundedUrl)).toBe(1);
    expect((await redis.get(docKey(legacyUrl))) === legacy).toBe(true);
    expect(listed).toHaveLength(2);
    expect(listed).toContainEqual({ title: 'Legacy document', url: legacyUrl, fetchedAt: '2026-11-01T00:00:00.000Z', contentLength: 250_000 });
    expect(listed).toContainEqual({ title: 'big.txt', url: boundedUrl, fetchedAt: expect.any(String), contentLength: 5_138_022 });
    expect(await storedEntry(boundedUrl)).toMatchObject({ contentLength: 5_138_022, storedLength: 100_000 });
  });

  it('list_cached reports the full contentLength of a bounded entry in the unchanged summary shape', async () => {
    const url = serve('big.txt', BIG);
    await fetchUrl(url, redis, {});

    const listed = await listCached(redis, url);

    expect(listed).toEqual([{
      title: 'big.txt',
      url,
      fetchedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
      contentLength: 5_138_022,
    }]);
    expect((await storedEntry(url)).markdown.length).toBe(100_000);
  });

  it('DocsCache.setCachedDoc bounds the stored markdown whatever the caller passes and records storedLength', async () => {
    const url = `https://docs.example.com/${randomUUID()}/direct.txt`;
    createdKeys.push(docKey(url));
    const cache = new DocsCache(redis, 120);

    await cache.setCachedDoc(url, {
      markdown: BIG, title: 'Direct', url, fetchedAt: '2026-11-11T00:00:00.000Z', contentLength: 5_138_022,
    });

    const entry = await storedEntry(url);
    expect(entry.markdown.length).toBe(100_000);
    expect(entry.markdown === BIG.slice(0, 100_000)).toBe(true);
    expect(entry).toMatchObject({
      title: 'Direct', url, fetchedAt: '2026-11-11T00:00:00.000Z', contentLength: 5_138_022, storedLength: 100_000,
    });
    expect(await redis.strLen(docKey(url))).toBeLessThan(512 * KIB);
    expect(await cache.getCachedDoc(url)).toEqual(entry);
  });

  it('keeps the entry of a 4.9 MiB multi-byte document below 512 KiB: the bound counts characters, three bytes each here', async () => {
    // 1 712 674 × U+6F22 (漢) = 5 138 022 UTF-8 bytes. Three bytes per character is the most ordinary text costs.
    const text = '\u6f22'.repeat(1_712_674);
    const url = serve('cjk.txt', text);

    const first = await fetchUrl(url, redis, {});
    const firstPage = await fetchUrl(url, redis, { maxLength: 100_000 });

    expect(first).toMatchObject({ cached: false, contentLength: 1_712_674, truncated: true });
    expect(first.markdown === text.slice(0, 10_000)).toBe(true);
    expect(firstPage.markdown === text.slice(0, 100_000)).toBe(true);
    expect(requests(url)).toBe(1);
    const serializedBytes = await redis.strLen(docKey(url));
    expect(serializedBytes).toBeGreaterThan(300_000);
    expect(serializedBytes).toBeLessThan(512 * KIB);
    expect(firstPage.cached).toBe(true);
    expect(await storedEntry(url)).toMatchObject({ contentLength: 1_712_674, storedLength: 100_000 });
  });
});
