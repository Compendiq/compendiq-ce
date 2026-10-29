import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createClient, type RedisClientType } from 'redis';
import { afterEach, describe, expect, it } from 'vitest';
import { searchWeb } from './search-web.js';

const redisUrl = process.env.MCP_DOCS_TEST_REDIS_URL;
if (!redisUrl) {
  throw new Error('MCP_DOCS_TEST_REDIS_URL must point to real Redis for the search cache regression');
}

describe('searchWeb cache width with real Redis and loopback SearXNG', () => {

  let redis: RedisClientType | undefined;
  let server: Server | undefined;
  let serverUrl: string;

  afterEach(async () => {
    if (server?.listening) {
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      server.close((error) => error ? reject(error) : resolve());
      await promise;
    }
    if (redis?.isOpen) await redis.quit();
  });

  it('isolates widths, reuses same-width entries, and caps requested width', async () => {
    redis = createClient({ url: redisUrl });
    await redis.connect();
    const searchCalls: string[] = [];
    const run = randomUUID();
    const smallQuery = `width regression ${run} small-first`;
    const largeQuery = `width regression ${run} large-first`;
    const cappedQuery = `width regression ${run} capped`;
    server = createServer((request, response) => {
      searchCalls.push(new URL(request.url ?? '/', 'http://localhost').searchParams.get('q') ?? '');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        results: Array.from({ length: 10 }, (_, index) => ({
          title: `Result ${index + 1}`,
          url: `https://example.test/${index + 1}`,
          content: `Snippet ${index + 1}`,
        })),
      }));
    });
    const { promise, resolve } = Promise.withResolvers<void>();
    server.listen(0, '127.0.0.1', resolve);
    await promise;
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Loopback server did not bind');
    serverUrl = `http://127.0.0.1:${address.port}`;

    const smallFirst = await searchWeb(smallQuery, redis, {
      numResults: 3, searxngUrl: serverUrl,
    });
    const largeSecond = await searchWeb(smallQuery, redis, {
      numResults: 10, searxngUrl: serverUrl,
    });
    const largeRepeat = await searchWeb(smallQuery, redis, {
      numResults: 10, searxngUrl: serverUrl,
    });
    const largeFirst = await searchWeb(largeQuery, redis, {
      numResults: 10, searxngUrl: serverUrl,
    });
    const smallSecond = await searchWeb(largeQuery, redis, {
      numResults: 3, searxngUrl: serverUrl,
    });
    const capped = await searchWeb(cappedQuery, redis, {
      numResults: 99, searxngUrl: serverUrl,
    });

    expect(smallFirst).toHaveLength(3);
    expect(largeSecond).toHaveLength(10);
    expect(largeRepeat).toHaveLength(10);
    expect(largeRepeat).toEqual(largeSecond);
    expect(largeFirst).toHaveLength(10);
    expect(smallSecond).toHaveLength(3);
    expect(capped).toHaveLength(10);
    expect(searchCalls).toEqual([
      smallQuery,
      smallQuery,
      largeQuery,
      largeQuery,
      cappedQuery,
    ]);
  });

  it('never adopts or overwrites a legacy query entry during an upgrade', async () => {
    redis = createClient({ url: redisUrl });
    await redis.connect();
    const query = `aspect ratio ${randomUUID()} 16`;
    const legacyQuery = `${query}:9`;
    const legacyKey = `mcp:docs:search:${createHash('sha256').update(legacyQuery).digest('hex').slice(0, 16)}`;
    const legacy = JSON.stringify({
      query: legacyQuery,
      results: [{ title: 'Legacy query', url: 'https://example.test/legacy', snippet: 'Wrong query' }],
      fetchedAt: new Date().toISOString(),
    });
    await redis.setEx(legacyKey, 60, legacy);
    const currentResults = [{ title: 'Current query', url: 'https://example.test/current', content: 'Correct query' }];
    const queries: string[] = [];
    server = createServer((request, response) => {
      queries.push(new URL(request.url ?? '/', 'http://localhost').searchParams.get('q') ?? '');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ results: currentResults }));
    });
    const { promise, resolve } = Promise.withResolvers<void>();
    server.listen(0, '127.0.0.1', resolve);
    await promise;
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Loopback server did not bind');
    const options = { numResults: 9, searxngUrl: `http://127.0.0.1:${address.port}` };
    const first = await searchWeb(query, redis, options);
    expect(first).toEqual([{ title: 'Current query', url: 'https://example.test/current', snippet: 'Correct query' }]);
    expect(await redis.get(legacyKey)).toBe(legacy);
    // An old replica may keep writing while the new replica serves its own cache.
    await redis.setEx(legacyKey, 60, legacy);
    expect(await searchWeb(query, redis, options)).toEqual(first);
    expect(queries).toEqual([query]);
  });
});
