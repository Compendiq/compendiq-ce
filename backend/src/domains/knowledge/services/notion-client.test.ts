import { afterEach, describe, expect, it } from 'vitest';
import { startFakeNotionServer, type FakeNotionServer } from './__fixtures__/fake-notion-server.js';
import {
  computeNotionRetryDelayMs,
  DEFAULT_NOTION_API_BASE_URL,
  NOTION_BACKOFF_BASE_MS,
  NOTION_MAX_BACKOFF_MS,
  NOTION_RATE_LIMIT_MAX_ATTEMPTS,
  NOTION_VERSION,
  NotionClient,
  NotionError,
  isNotionObjectMissing,
  paginateAll,
  setNotionApiBaseUrlForTests,
} from './notion-client.js';

const TOKEN = 'secret_test_ntn_never_echo';

describe('NotionClient (fake Notion HTTP)', () => {
  let server: FakeNotionServer | undefined;

  afterEach(async () => {
    setNotionApiBaseUrlForTests(null);
    await server?.close();
    server = undefined;
  });

  it('probes GET /v1/users/me and never calls api.notion.com', async () => {
    server = await startFakeNotionServer({ validToken: TOKEN });
    expect(server.baseUrl).not.toContain('api.notion.com');

    const client = new NotionClient(TOKEN, { baseUrl: server.baseUrl });
    const me = await client.probe();

    expect(me.workspaceName).toBe('Acme Wiki');
    expect(me.name).toBe('Compendiq Import');
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]).toMatchObject({
      method: 'GET',
      url: '/v1/users/me',
      authorization: `Bearer ${TOKEN}`,
      notionVersion: NOTION_VERSION,
    });
    expect(DEFAULT_NOTION_API_BASE_URL).toBe('https://api.notion.com');
  });

  it('throws NotionError 401 for an invalid token without echoing the secret', async () => {
    server = await startFakeNotionServer({ validToken: 'other-token' });
    const client = new NotionClient(TOKEN, { baseUrl: server.baseUrl });

    await expect(client.probe()).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(NotionError);
      const e = err as NotionError;
      expect(e.statusCode).toBe(401);
      expect(e.message).toBe('Invalid Notion token');
      expect(JSON.stringify(e)).not.toContain(TOKEN);
      expect(e.message).not.toContain(TOKEN);
      return true;
    });
  });

  it('paginates search results for later tree PRs', async () => {
    server = await startFakeNotionServer({
      validToken: TOKEN,
      searchResults: [
        { object: 'page', id: 'p1' },
        { object: 'database', id: 'db1' },
        { object: 'page', id: 'p2' },
      ],
    });
    const client = new NotionClient(TOKEN, { baseUrl: server.baseUrl });
    const items = await client.searchAll({ pageSize: 2 });
    expect(items.map((i) => i.id)).toEqual(['p1', 'db1', 'p2']);
    expect(server.requests.filter((r) => r.method === 'POST' && r.url === '/v1/search')).toHaveLength(2);
  });

  it('fetches a page and paginated block children', async () => {
    server = await startFakeNotionServer({
      validToken: TOKEN,
      pages: {
        'page-1': { object: 'page', id: 'page-1', url: 'https://www.notion.so/page-1' },
      },
      databases: {
        'db-1': { object: 'database', id: 'db-1', title: [] },
      },
      blockChildren: {
        'page-1': [
          { object: 'block', id: 'b1', type: 'paragraph' },
          { object: 'block', id: 'b2', type: 'heading_1' },
        ],
      },
    });
    const client = new NotionClient(TOKEN, { baseUrl: server.baseUrl });
    const page = await client.getPage('page-1');
    expect(page.id).toBe('page-1');
    const db = await client.getDatabase('db-1');
    expect(db.object).toBe('database');
    const blocks = await client.getAllBlockChildren('page-1');
    expect(blocks.map((b) => b.id)).toEqual(['b1', 'b2']);
  });

  it('flags GET /v1/pages on a database id as an object-type mismatch, not a plain 400', async () => {
    server = await startFakeNotionServer({
      validToken: TOKEN,
      databases: {
        'db-1': { object: 'database', id: 'db-1', title: [] },
      },
    });
    const client = new NotionClient(TOKEN, { baseUrl: server.baseUrl });
    await expect(client.getPage('db-1')).rejects.toMatchObject({
      statusCode: 400,
      objectTypeMismatch: true,
      message: 'Notion object is not a page',
    });
    expect(isNotionObjectMissing(await client.getPage('db-1').catch((e) => e))).toBe(true);
    await expect(client.getDatabase('db-1')).resolves.toMatchObject({ object: 'database', id: 'db-1' });
  });

  it('leaves an ordinary 400 unflagged, so it is a failure and not a fallback', async () => {
    server = await startFakeNotionServer({
      validToken: TOKEN,
      blockChildrenErrors: { 'blk-1': 400 },
    });
    const client = new NotionClient(TOKEN, { baseUrl: server.baseUrl });
    const err = await client.getBlockChildren('blk-1').catch((e: unknown) => e);
    expect(err).toMatchObject({ statusCode: 400, objectTypeMismatch: false });
    expect(isNotionObjectMissing(err)).toBe(false);
  });

  it('paginateAll stops when has_more is false', async () => {
    const pages = [
      { object: 'list' as const, results: [1, 2], next_cursor: 'c1', has_more: true },
      { object: 'list' as const, results: [3], next_cursor: null, has_more: false },
    ];
    let i = 0;
    const all = await paginateAll(async () => pages[i++]!);
    expect(all).toEqual([1, 2, 3]);
  });

  it('honours setNotionApiBaseUrlForTests so route tests can bind the fake server', async () => {
    server = await startFakeNotionServer({ validToken: TOKEN });
    setNotionApiBaseUrlForTests(server.baseUrl);
    const client = new NotionClient(TOKEN);
    await client.probe();
    expect(server.requests[0]?.url).toBe('/v1/users/me');
  });

  it('retries a 429 after Retry-After and returns the page', async () => {
    server = await startFakeNotionServer({
      validToken: TOKEN,
      transientFailures: [{ status: 429, retryAfter: '0' }],
      pages: {
        'page-1': { object: 'page', id: 'page-1', url: 'https://www.notion.so/page-1' },
      },
    });
    const client = new NotionClient(TOKEN, { baseUrl: server.baseUrl });

    const page = await client.getPage('page-1');

    expect(page.id).toBe('page-1');
    expect(server.requests.filter((r) => r.url.startsWith('/v1/pages/page-1'))).toHaveLength(2);
  });

  it('retries a 529 and a GET 500 the same way as a 429', async () => {
    server = await startFakeNotionServer({
      validToken: TOKEN,
      transientFailures: [{ status: 529, retryAfter: '0' }, { status: 500, retryAfter: '0' }],
      pages: {
        'page-1': { object: 'page', id: 'page-1' },
      },
    });
    const client = new NotionClient(TOKEN, { baseUrl: server.baseUrl });

    const page = await client.getPage('page-1');

    expect(page.id).toBe('page-1');
    expect(server.requests.filter((r) => r.url.startsWith('/v1/pages/page-1'))).toHaveLength(3);
  });

  it('retries POST search on 429', async () => {
    server = await startFakeNotionServer({
      validToken: TOKEN,
      transientFailures: [{ status: 429, retryAfter: '0' }],
      searchResults: [{ object: 'page', id: 'p1' }],
    });
    const client = new NotionClient(TOKEN, { baseUrl: server.baseUrl });

    const first = await client.search();

    expect(first.results).toEqual([{ object: 'page', id: 'p1' }]);
    expect(server.requests.filter((r) => r.url === '/v1/search')).toHaveLength(2);
  });

  it('retries a 500 on POST search, which is a read the pagination walk must survive', async () => {
    server = await startFakeNotionServer({
      validToken: TOKEN,
      transientFailures: [{ status: 500 }],
      searchResults: [{ object: 'page', id: 'p1' }],
    });
    const client = new NotionClient(TOKEN, { baseUrl: server.baseUrl });

    const result = await client.search();

    expect(result.results).toEqual([{ object: 'page', id: 'p1' }]);
    expect(server.requests.filter((r) => r.url === '/v1/search')).toHaveLength(2);
  });

  it('does not retry 401', async () => {
    server = await startFakeNotionServer({ validToken: 'other-token' });
    const client = new NotionClient(TOKEN, { baseUrl: server.baseUrl });

    await expect(client.probe()).rejects.toMatchObject({ statusCode: 401, message: 'Invalid Notion token' });
    expect(server.requests).toHaveLength(1);
  });

  it('throws after six persistent 429s', async () => {
    server = await startFakeNotionServer({
      validToken: TOKEN,
      pages: {
        'page-1': { object: 'page', id: 'page-1' },
      },
      pageErrors: { 'page-1': 429 },
    });
    const client = new NotionClient(TOKEN, { baseUrl: server.baseUrl });

    await expect(client.getPage('page-1')).rejects.toMatchObject({
      statusCode: 429,
      message: 'Notion API error: HTTP 429',
    });
    expect(server.requests.filter((r) => r.url.startsWith('/v1/pages/page-1'))).toHaveLength(
      NOTION_RATE_LIMIT_MAX_ATTEMPTS,
    );
  });

  it('retries fetchMedia after a 429', async () => {
    server = await startFakeNotionServer({
      validToken: TOKEN,
      transientFailures: [{ status: 429, retryAfter: '0' }],
      files: { '/files/img.png': { contentType: 'image/png', body: 'img' } },
    });
    const client = new NotionClient(TOKEN, { baseUrl: server.baseUrl });

    const media = await client.fetchMedia(`${server.baseUrl}/files/img.png`);

    expect(media.contentType).toBe('image/png');
    expect(media.bytes.toString()).toBe('img');
    expect(server.requests.filter((r) => r.url.startsWith('/files/img.png'))).toHaveLength(2);
  });

  it('backs off on its own when a 429 carries no Retry-After', async () => {
    server = await startFakeNotionServer({
      validToken: TOKEN,
      transientFailures: [{ status: 429, retryAfter: null }],
      pages: { 'page-1': { object: 'page', id: 'page-1' } },
    });
    const client = new NotionClient(TOKEN, { baseUrl: server.baseUrl });

    const startedAt = Date.now();
    const page = await client.getPage('page-1');

    expect(page.id).toBe('page-1');
    expect(server.requests.filter((r) => r.url.startsWith('/v1/pages/page-1'))).toHaveLength(2);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(NOTION_BACKOFF_BASE_MS);
  });

  it('paces request starts at the configured interval', async () => {
    const ids = ['p-0', 'p-1', 'p-2', 'p-3'];
    server = await startFakeNotionServer({
      validToken: TOKEN,
      pages: Object.fromEntries(ids.map((id) => [id, { object: 'page', id }])),
    });
    const client = new NotionClient(TOKEN, { baseUrl: server.baseUrl, minIntervalMs: 80 });

    await Promise.all(ids.map((id) => client.getPage(id)));

    const starts = server.requests.map((r) => r.startedAt);
    // Four starts, three 80ms gaps. Unpaced they all land inside a few ms.
    expect(starts[3]! - starts[0]!).toBeGreaterThanOrEqual(3 * 80 - 20);
  });

  it('paces starts without serializing them, so callers keep their own concurrency', async () => {
    const ids = ['c-0', 'c-1', 'c-2', 'c-3', 'c-4', 'c-5'];
    server = await startFakeNotionServer({
      validToken: TOKEN,
      lookupDelayMs: 200,
      pages: Object.fromEntries(ids.map((id) => [id, { object: 'page', id }])),
    });
    const client = new NotionClient(TOKEN, { baseUrl: server.baseUrl });

    await Promise.all(ids.map((id) => client.getPage(id)));

    // A client that serialized on completion instead of pacing starts peaks at
    // 1 here and makes every caller-side pLimit(5) inert (#1553).
    expect(server.peakConcurrentLookups).toBeGreaterThan(2);
  });
});

describe('computeNotionRetryDelayMs', () => {
  /** Upper bound of the jitter the client adds to every delay. */
  const JITTER_MS = 250;

  it('doubles the backoff base on each attempt when no Retry-After is sent', () => {
    for (const attempt of [0, 1, 2, 3, 4]) {
      const floor = NOTION_BACKOFF_BASE_MS * 2 ** attempt;
      const delay = computeNotionRetryDelayMs(attempt, undefined);
      expect(delay).toBeGreaterThanOrEqual(floor);
      expect(delay).toBeLessThan(floor + JITTER_MS);
    }
  });

  it('prefers Retry-After over the ladder', () => {
    const delay = computeNotionRetryDelayMs(4, '2');
    expect(delay).toBeGreaterThanOrEqual(2000);
    expect(delay).toBeLessThan(2000 + JITTER_MS);
  });

  it('caps an absurd Retry-After — this sleep sits outside AbortSignal.timeout', () => {
    expect(computeNotionRetryDelayMs(0, '3600')).toBe(NOTION_MAX_BACKOFF_MS);
  });

  it('floors Retry-After: 0 at one pacing slot, so the ladder is never a hot loop', () => {
    const delay = computeNotionRetryDelayMs(0, '0', { floorMs: 334 });
    expect(delay).toBeGreaterThanOrEqual(334);
    expect(delay).toBeLessThan(334 + JITTER_MS);
  });

  it('ignores a Retry-After it cannot read as seconds', () => {
    for (const header of ['soon', '-5', 'Wed, 21 Oct 2015 07:28:00 GMT', '']) {
      const delay = computeNotionRetryDelayMs(0, header, { baseMs: 500 });
      expect(delay).toBeGreaterThanOrEqual(500);
      expect(delay).toBeLessThan(500 + JITTER_MS);
    }
  });
});
