import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createClient, type RedisClientType } from 'redis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * #1769 — the admin settings the backend forwards as tool arguments, proven on
 * the REAL sidecar: `src/index.ts` is spawned from this worktree with real
 * Redis and a loopback SearXNG, and driven through the MCP SDK client.
 *
 *  - `fetch_url.cache_ttl`   → the Redis TTL of the cached document
 *    (`CACHE_TTL_SECONDS` when the argument is absent);
 *  - `search_web.categories` → the `categories` parameter SearXNG receives and
 *    part of the search-cache identity under `mcp:docs:search:v3:`.
 *
 * The numbers and the pattern below are LITERAL on purpose. The sidecar does
 * not depend on `@compendiq/contracts`, whose `MCP_DOCS_*` and
 * `SEARXNG_CATEGORIES_*` the admin API and UI use;
 * `packages/contracts/src/schemas/mcp-docs.test.ts` and
 * `searxng.categories.test.ts` pin the same literals there, so neither side
 * can drift alone.
 *
 * Real Redis is mandatory (docs/claude/content-pipeline.md → SearXNG Sidecar):
 * a missing MCP_DOCS_TEST_REDIS_URL fails the file, it never skips.
 */

const redisUrl = process.env.MCP_DOCS_TEST_REDIS_URL;
if (!redisUrl) {
  throw new Error('MCP_DOCS_TEST_REDIS_URL must point to real Redis for the admin-settings wiring test');
}

const mcpDocsDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const docHostStub = pathToFileURL(join(mcpDocsDir, 'src', 'test-support', 'stub-doc-host.mjs')).href;
const TOKEN = 'admin-settings-token';
/** The spawned sidecar's CACHE_TTL_SECONDS: distinct from every `cache_ttl` sent below and from the 3600 default. */
const SIDECAR_DEFAULT_TTL = 900;
/** Served by test-support/stub-doc-host.mjs inside the child (RFC 5737 TEST-NET-3). */
const DOC_HOST = 'http://203.0.113.10';

// A real child process and real sockets are involved, so readiness and
// shutdown are polled against the wall clock on purpose: fake timers cannot
// advance another process.

async function freePort(): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const probe = createNetServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const address = probe.address();
    if (!address || typeof address === 'string') {
      probe.close();
      reject(new Error('Loopback probe did not bind'));
      return;
    }
    const { port } = address;
    probe.close((err) => (err ? reject(err) : resolve(port)));
  });
  return promise;
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms).unref();
  return promise;
}

async function waitForHealth(baseUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      const body = (await response.json()) as { status?: string; redis?: string };
      if (body.status === 'ok' && body.redis === 'connected') return;
      if (body.status === 'ok') throw new Error(`mcp-docs cannot reach Redis at ${redisUrl}`);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('mcp-docs cannot reach Redis')) throw err;
      // not listening yet
    }
    await sleep(100);
  }
  throw new Error(`mcp-docs did not report /health ok within ${timeoutMs} ms`);
}

/** Spawns `src/index.ts` (with the document-host stub preloaded) on a free loopback port; retries a lost port race. */
async function startSidecar(searxngUrl: string): Promise<{ child: ChildProcess; baseUrl: string }> {
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const child = spawn(process.execPath, ['--import', 'tsx', '--import', docHostStub, 'src/index.ts'], {
      cwd: mcpDocsDir,
      env: {
        ...process.env,
        PORT: String(port),
        MCP_DOCS_HOST: '127.0.0.1',
        REDIS_URL: redisUrl,
        SEARXNG_URL: searxngUrl,
        CACHE_TTL_SECONDS: String(SIDECAR_DEFAULT_TTL),
        MCP_DOCS_TOKEN: TOKEN,
        NODE_ENV: 'production',
        LOG_LEVEL: 'warn',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    const gone = Promise.withResolvers<never>();
    child.once('exit', (code, signal) => gone.reject(new Error(`mcp-docs exited early (code ${code}, signal ${signal})`)));
    child.once('error', (err) => gone.reject(new Error(`mcp-docs could not be spawned: ${err.message}`)));
    gone.promise.catch(() => {}); // observed through Promise.race below; never unhandled
    try {
      await Promise.race([waitForHealth(baseUrl, 30_000), gone.promise]);
      return { child, baseUrl };
    } catch (err) {
      lastError = new Error(`${err instanceof Error ? err.message : String(err)} (attempt ${attempt})\n--- mcp-docs output ---\n${output}`);
      child.kill('SIGKILL');
    }
  }
  throw lastError ?? new Error('mcp-docs did not start');
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = Promise.withResolvers<void>();
  child.once('exit', () => exited.resolve());
  child.kill('SIGTERM');
  await Promise.race([exited.promise, sleep(5_000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

async function listen(server: Server): Promise<string> {
  const listening = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', listening.resolve);
  await listening.promise;
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Loopback server did not bind');
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server | undefined): Promise<void> {
  if (!server?.listening) return;
  const closed = Promise.withResolvers<void>();
  server.close(() => closed.resolve());
  await closed.promise;
}

interface SearxngRequest { q: string; categories: string | null }

const searxngRequests: SearxngRequest[] = [];
let decoyRequests = 0;
let searxng: Server;
let decoy: Server;
let decoyUrl = '';
let child: ChildProcess;
let transport: StreamableHTTPClientTransport;
let client: Client;
let redis: RedisClientType;

beforeAll(async () => {
  redis = createClient({ url: redisUrl });
  await redis.connect();

  // The fake answers with the category it was asked for, so a result served
  // from another category's cache entry is visible in the result titles.
  searxng = createServer((request, response) => {
    const params = new URL(request.url ?? '/', 'http://localhost').searchParams;
    const categories = params.get('categories');
    searxngRequests.push({ q: params.get('q') ?? '', categories });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      results: [1, 2, 3].map((n) => ({
        title: `${categories} result ${n}`,
        url: `https://example.test/${categories}/${n}`,
        content: `Snippet ${n}`,
      })),
    }));
  });
  // A second loopback "SearXNG" nothing may ever be redirected to.
  decoy = createServer((_request, response) => {
    decoyRequests += 1;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ results: [{ title: 'decoy', url: 'https://decoy.test/', content: 'decoy' }] }));
  });
  const searxngUrl = await listen(searxng);
  decoyUrl = await listen(decoy);

  const started = await startSidecar(searxngUrl);
  child = started.child;
  transport = new StreamableHTTPClientTransport(new URL(`${started.baseUrl}/mcp`), {
    requestInit: { headers: { 'x-mcp-docs-token': TOKEN } },
  });
  client = new Client({ name: 'admin-settings-test', version: '0' });
  await client.connect(transport);
}, 60_000);

afterAll(async () => {
  await transport?.terminateSession().catch(() => {});
  await client?.close().catch(() => {});
  if (child) await stopChild(child);
  await close(searxng);
  await close(decoy);
  // A client that never connected is "open" but not ready: quit() would wait
  // for a connection and hide the real failure behind a hook timeout.
  if (redis?.isReady) await redis.quit();
  else redis?.destroy();
});

async function callTool(name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  const first: unknown = Array.isArray(result.content) ? result.content[0] : undefined;
  const text = typeof first === 'object' && first !== null && 'text' in first && typeof first.text === 'string'
    ? first.text
    : '';
  return { isError: result.isError === true, text };
}

async function toolProperties(name: string): Promise<Record<string, object>> {
  const tool = (await client.listTools()).tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`tool ${name} is not registered`);
  return tool.inputSchema.properties ?? {};
}

describe('fetch_url cache_ttl against the running sidecar and real Redis (#1769)', () => {
  /** The document-cache key — its namespace and derivation are unchanged by #1769. */
  function docKey(url: string): string {
    return `mcp:docs:url:${createHash('sha256').update(url).digest('hex').slice(0, 16)}`;
  }

  /** A URL no earlier run has cached, so the fetch is fresh and writes the entry. */
  function freshDocUrl(): string {
    return `${DOC_HOST}/doc/${randomUUID()}`;
  }

  it('caches a freshly fetched document for cache_ttl 60 seconds', async () => {
    const url = freshDocUrl();

    const outcome = await callTool('fetch_url', { url, user_id: 'ttl-test', cache_ttl: 60 });

    expect(outcome.isError, outcome.text).toBe(false);
    expect(outcome.text).toContain('Cached: false');
    const ttl = await redis.ttl(docKey(url));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
  });

  it('caches a freshly fetched document for cache_ttl 7200 seconds', async () => {
    const url = freshDocUrl();

    const outcome = await callTool('fetch_url', { url, user_id: 'ttl-test', cache_ttl: 7200 });

    expect(outcome.isError, outcome.text).toBe(false);
    const ttl = await redis.ttl(docKey(url));
    expect(ttl).toBeGreaterThan(3600);
    expect(ttl).toBeLessThanOrEqual(7200);
  });

  it('uses CACHE_TTL_SECONDS when no cache_ttl argument is sent', async () => {
    const url = freshDocUrl();

    const outcome = await callTool('fetch_url', { url, user_id: 'ttl-test' });

    expect(outcome.isError, outcome.text).toBe(false);
    const ttl = await redis.ttl(docKey(url));
    expect(ttl).toBeGreaterThan(SIDECAR_DEFAULT_TTL - 60);
    expect(ttl).toBeLessThanOrEqual(SIDECAR_DEFAULT_TTL);
  });

  it('serves a cached document without rewriting its TTL', async () => {
    const url = freshDocUrl();
    await callTool('fetch_url', { url, cache_ttl: 7200 });

    const second = await callTool('fetch_url', { url, cache_ttl: 60 });

    expect(second.text).toContain('Cached: true');
    expect(await redis.ttl(docKey(url))).toBeGreaterThan(3600);
  });

  it.each([
    [59, 'Too small: expected number to be >=60 at cache_ttl'],
    [86_401, 'Too big: expected number to be <=86400 at cache_ttl'],
    [60.5, 'expected int, received number at cache_ttl'],
  ])('rejects cache_ttl %s with -32602 and caches nothing', async (cacheTtl, message) => {
    const url = freshDocUrl();

    const outcome = await callTool('fetch_url', { url, cache_ttl: cacheTtl });

    expect(outcome.isError).toBe(true);
    expect(outcome.text).toMatch(/MCP error -32602/);
    expect(outcome.text).toContain(message);
    expect(await redis.exists(docKey(url))).toBe(0);
  });

  it('declares cache_ttl as an integer 60–86400 and keeps max_length capped at 100000', async () => {
    const properties = await toolProperties('fetch_url');

    expect(Object.keys(properties).sort()).toEqual(['cache_ttl', 'max_length', 'start_index', 'url', 'user_id']);
    expect(properties.cache_ttl).toMatchObject({ type: 'integer', minimum: 60, maximum: 86400 });
    expect(properties.max_length).toMatchObject({ type: 'number', maximum: 100000 });
  });
});

describe('search_web categories against the running sidecar, a loopback SearXNG and real Redis (#1769)', () => {
  /** A query no earlier run has cached. */
  function freshQuery(): string {
    return `categories ${randomUUID()}`;
  }

  function requestsFor(query: string): SearxngRequest[] {
    return searxngRequests.filter((request) => request.q === query);
  }

  function titles(text: string): string[] {
    return [...text.matchAll(/^\d+\. \*\*(.+)\*\*$/gm)].map((match) => match[1]!);
  }

  /** Every search-cache key, in any namespace version, whose stored entry answers `query`. */
  async function searchKeysHolding(query: string): Promise<string[]> {
    const keys: string[] = [];
    for await (const batch of redis.scanIterator({ MATCH: 'mcp:docs:search:*', COUNT: 500 })) {
      for (const key of batch) {
        const raw = await redis.get(key);
        if (!raw) continue;
        const entry: unknown = JSON.parse(raw);
        if (typeof entry === 'object' && entry !== null && 'query' in entry && entry.query === query) keys.push(key);
      }
    }
    return keys.sort();
  }

  it.each(['it', 'general,it'])('sends categories %j to SearXNG exactly as given', async (categories) => {
    const query = freshQuery();

    const outcome = await callTool('search_web', { query, num_results: 3, user_id: 'categories-test', categories });

    expect(outcome.isError, outcome.text).toBe(false);
    expect(requestsFor(query)).toEqual([{ q: query, categories }]);
  });

  it('searches the default category general when categories is omitted', async () => {
    const query = freshQuery();

    await callTool('search_web', { query, num_results: 3 });

    expect(requestsFor(query)).toEqual([{ q: query, categories: 'general' }]);
  });

  it.each([
    'general; drop',
    'General',
    'general, it',
    'a,,b',
    '',
    'x'.repeat(201),
  ])('rejects categories %j with -32602 before any SearXNG request', async (categories) => {
    const query = freshQuery();

    const outcome = await callTool('search_web', { query, categories });

    expect(outcome.isError).toBe(true);
    expect(outcome.text).toMatch(/MCP error -32602/);
    expect(outcome.text).toMatch(/at categories/);
    expect(requestsFor(query)).toEqual([]);
  });

  it('keeps one cache entry per category list for the same query and width', async () => {
    const query = freshQuery();
    const search = (categories: string) => callTool('search_web', { query, num_results: 3, categories });

    const itFirst = await search('it');
    const generalFirst = await search('general');
    const itAgain = await search('it');
    const generalAgain = await search('general');

    // Each category list reached SearXNG once; the repeats were cache hits…
    expect(requestsFor(query)).toEqual([{ q: query, categories: 'it' }, { q: query, categories: 'general' }]);
    // …answered from their own entry, never the other category's.
    expect(titles(itFirst.text)).toEqual(['it result 1', 'it result 2', 'it result 3']);
    expect(titles(generalFirst.text)).toEqual(['general result 1', 'general result 2', 'general result 3']);
    expect(itAgain.text).toBe(itFirst.text);
    expect(generalAgain.text).toBe(generalFirst.text);
  });

  it('stores search results under mcp:docs:search:v3: only', async () => {
    const query = freshQuery();
    await callTool('search_web', { query, num_results: 3, categories: 'it' });
    await callTool('search_web', { query, num_results: 3, categories: 'general' });

    const keys = await searchKeysHolding(query);

    expect(keys).toHaveLength(2);
    for (const key of keys) {
      expect(key).toMatch(/^mcp:docs:search:v3:[0-9a-f]{16}$/);
      expect(await redis.ttl(key)).toBeGreaterThan(0);
    }
  });

  it('never reads or overwrites a pre-existing v2 entry for the same query and width', async () => {
    const query = freshQuery();
    // The v2 identity (query + width), exactly as the previous release wrote it.
    const v2Key = `mcp:docs:search:v2:${createHash('sha256').update(`${query.toLowerCase()}:3`).digest('hex').slice(0, 16)}`;
    const legacy = JSON.stringify({
      query,
      results: [{ title: 'Legacy v2 result', url: 'https://example.test/legacy', snippet: 'from the v2 cache' }],
      fetchedAt: new Date().toISOString(),
    });
    await redis.setEx(v2Key, 300, legacy);

    const outcome = await callTool('search_web', { query, num_results: 3 });

    expect(titles(outcome.text)).toEqual(['general result 1', 'general result 2', 'general result 3']);
    expect(requestsFor(query)).toHaveLength(1);
    expect(await redis.get(v2Key)).toBe(legacy);
  });

  it('exposes no search-host argument: an injected URL is ignored and SEARXNG_URL is used', async () => {
    const properties = await toolProperties('search_web');
    expect(Object.keys(properties).sort()).toEqual(['categories', 'num_results', 'query', 'user_id']);
    expect(properties.categories).toMatchObject({ type: 'string', maxLength: 200, pattern: '^[a-z0-9_]+(,[a-z0-9_]+)*$' });

    const query = freshQuery();
    const outcome = await callTool('search_web', {
      query, num_results: 3, searxng_url: decoyUrl, searxngUrl: decoyUrl, url: decoyUrl,
    });

    expect(outcome.isError, outcome.text).toBe(false);
    expect(requestsFor(query)).toHaveLength(1);
    expect(decoyRequests).toBe(0);
  });
});
