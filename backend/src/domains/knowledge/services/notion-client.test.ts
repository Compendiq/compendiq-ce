import { afterEach, describe, expect, it } from 'vitest';
import { startFakeNotionServer, type FakeNotionServer } from './__fixtures__/fake-notion-server.js';
import {
  DEFAULT_NOTION_API_BASE_URL,
  NOTION_VERSION,
  NotionClient,
  NotionError,
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
});
