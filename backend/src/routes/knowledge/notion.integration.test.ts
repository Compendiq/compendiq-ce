import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { cacheStore } = vi.hoisted(() => ({
  cacheStore: new Map<string, unknown>(),
}));

vi.mock('../../core/services/redis-cache.js', () => ({
  RedisCache: class {
    async get(userId: string, type: string, identifier: string) {
      return cacheStore.get(`${userId}:${type}:${identifier}`) ?? null;
    }
    async set(userId: string, type: string, identifier: string, data: unknown) {
      cacheStore.set(`${userId}:${type}:${identifier}`, data);
    }
    async invalidate(userId: string, type: string) {
      for (const key of [...cacheStore.keys()]) {
        if (key.startsWith(`${userId}:${type}:`)) cacheStore.delete(key);
      }
    }
    async invalidateAcrossUsers() {}
  },
}));
import {
  isDbAvailable,
  setupTestDb,
  teardownTestDb,
  truncateAllTables,
} from '../../test-db-helper.js';
import { query } from '../../core/db/postgres.js';
import { decryptPat, isEncryptedSecretFormat } from '../../core/utils/crypto.js';
import { startFakeNotionServer, type FakeNotionServer } from '../../domains/knowledge/services/__fixtures__/fake-notion-server.js';
import { setNotionApiBaseUrlForTests } from '../../domains/knowledge/services/notion-client.js';
import { buildKnowledgeTestApp, insertUser } from './pages.test-helpers.js';
import { notionRoutes } from './notion.js';

const dbAvailable = await isDbAvailable();
const TOKEN = 'secret_route_ntn_must_never_appear_on_get';

beforeEach(() => {
  cacheStore.clear();
});

describe.skipIf(!dbAvailable)('GET/PUT/DELETE /api/notion/connection (#1462)', () => {
  let server: FakeNotionServer;
  let userId: string;

  beforeAll(async () => {
    await setupTestDb();
    server = await startFakeNotionServer({ validToken: TOKEN });
    setNotionApiBaseUrlForTests(server.baseUrl);
  });

  afterAll(async () => {
    setNotionApiBaseUrlForTests(null);
    await server.close();
    await teardownTestDb();
  });

  beforeEach(async () => {
    await truncateAllTables();
    userId = await insertUser('notion-route-user');
  });

  afterEach(() => {
    expect(JSON.stringify(server.requests.map((r) => r.url))).not.toContain('api.notion.com');
  });

  async function app() {
    return buildKnowledgeTestApp(() => userId, async (fastify) => {
      await fastify.register(notionRoutes, { prefix: '/api' });
    });
  }

  it('GET never echoes the token and reports hasToken only', async () => {
    const instance = await app();
    try {
      const empty = await instance.inject({ method: 'GET', url: '/api/notion/connection' });
      expect(empty.statusCode).toBe(200);
      expect(empty.json()).toEqual({ hasToken: false });
      expect(empty.body).not.toContain(TOKEN);

      const connected = await instance.inject({
        method: 'PUT',
        url: '/api/notion/connection',
        payload: { token: TOKEN },
      });
      expect(connected.statusCode).toBe(200);
      expect(connected.json()).toEqual({ hasToken: true });
      expect(connected.body).not.toContain(TOKEN);

      const got = await instance.inject({ method: 'GET', url: '/api/notion/connection' });
      expect(got.json()).toEqual({ hasToken: true });
      expect(got.body).not.toContain(TOKEN);
      expect(Object.keys(got.json() as object).sort()).toEqual(['hasToken']);
    } finally {
      await instance.close();
    }
  });

  it('PUT stores ciphertext only', async () => {
    const instance = await app();
    try {
      const res = await instance.inject({
        method: 'PUT',
        url: '/api/notion/connection',
        payload: { token: TOKEN },
      });
      expect(res.statusCode).toBe(200);

      const row = await query<{ notion_integration_token: string }>(
        'SELECT notion_integration_token FROM user_settings WHERE user_id = $1',
        [userId],
      );
      const stored = row.rows[0]!.notion_integration_token;
      expect(stored).not.toBe(TOKEN);
      expect(isEncryptedSecretFormat(stored)).toBe(true);
      expect(decryptPat(stored)).toBe(TOKEN);
    } finally {
      await instance.close();
    }
  });

  it('DELETE clears the stored secret', async () => {
    const instance = await app();
    try {
      await instance.inject({ method: 'PUT', url: '/api/notion/connection', payload: { token: TOKEN } });
      const res = await instance.inject({ method: 'DELETE', url: '/api/notion/connection' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ hasToken: false });
      expect(res.body).not.toContain(TOKEN);

      const row = await query<{ notion_integration_token: string | null }>(
        'SELECT notion_integration_token FROM user_settings WHERE user_id = $1',
        [userId],
      );
      expect(row.rows[0]!.notion_integration_token).toBeNull();
    } finally {
      await instance.close();
    }
  });

  it('invalid token is an honest 4xx from fake Notion with no secret in the body', async () => {
    const instance = await app();
    try {
      const res = await instance.inject({
        method: 'PUT',
        url: '/api/notion/connection',
        payload: { token: TOKEN + '-wrong' },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ message: 'Invalid Notion token', statusCode: 401 });
      expect(res.body).not.toContain(TOKEN);
      expect(res.body).not.toContain(TOKEN + '-wrong');

      const status = await instance.inject({ method: 'GET', url: '/api/notion/connection' });
      expect(status.json()).toEqual({ hasToken: false });
    } finally {
      await instance.close();
    }
  });

  it('GET /notion/connection handler source never decrypts or names the secret', () => {
    const src = readFileSync(new URL('./notion.ts', import.meta.url), 'utf8');
    const start = src.indexOf("fastify.get('/notion/connection'");
    const end = src.indexOf("fastify.put('/notion/connection'");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const connectionGet = src.slice(start, end);
    expect(connectionGet).not.toContain('getDecryptedNotionToken');
    expect(connectionGet).not.toContain('decryptPat');
    expect(connectionGet).toContain('getNotionConnectionStatus');
  });
});

describe.skipIf(!dbAvailable)('GET /api/notion/tree (#1463)', () => {
  let server: FakeNotionServer;
  let userId: string;

  beforeAll(async () => {
    await setupTestDb();
    server = await startFakeNotionServer({
      validToken: TOKEN,
      searchResults: [
        {
          object: 'page',
          id: 'handbook',
          parent: { type: 'workspace', workspace: true },
          properties: {
            title: {
              type: 'title',
              title: [{ type: 'text', plain_text: 'Handbook' }],
            },
          },
        },
        {
          object: 'database',
          id: 'crm',
          parent: { type: 'page_id', page_id: 'handbook' },
          title: [{ type: 'text', plain_text: 'CRM' }],
        },
        {
          object: 'page',
          id: 'nested',
          parent: { type: 'page_id', page_id: 'handbook' },
          properties: {
            title: {
              type: 'title',
              title: [{ type: 'text', plain_text: 'Nested notes' }],
            },
          },
        },
      ],
      databaseQueryResults: {
        crm: [
          {
            object: 'page',
            id: 'row-only-via-query',
            properties: {
              title: { type: 'title', title: [{ type: 'text', plain_text: 'Secret row' }] },
            },
          },
        ],
      },
    });
    setNotionApiBaseUrlForTests(server.baseUrl);
  });

  afterAll(async () => {
    setNotionApiBaseUrlForTests(null);
    await server.close();
    await teardownTestDb();
  });

  beforeEach(async () => {
    await truncateAllTables();
    userId = await insertUser('notion-tree-user');
    server.requests.length = 0;
  });

  afterEach(() => {
    expect(JSON.stringify(server.requests.map((r) => r.url))).not.toContain('api.notion.com');
    expect(server.requests.some((r) => r.url.includes('/query'))).toBe(false);
  });

  async function app() {
    return buildKnowledgeTestApp(() => userId, async (fastify) => {
      await fastify.register(notionRoutes, { prefix: '/api' });
    });
  }

  it('returns 400 when no token is stored and never echoes a secret', async () => {
    const instance = await app();
    try {
      const res = await instance.inject({ method: 'GET', url: '/api/notion/tree' });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ statusCode: 400 });
      expect(res.body).not.toContain(TOKEN);
      expect(res.body).not.toMatch(/ntn_|secret_/);
    } finally {
      await instance.close();
    }
  });

  it('returns pages and selectable databases with import hints; GET body never includes the token', async () => {
    const instance = await app();
    try {
      await instance.inject({ method: 'PUT', url: '/api/notion/connection', payload: { token: TOKEN } });
      const res = await instance.inject({ method: 'GET', url: '/api/notion/tree' });
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain(TOKEN);
      const body = res.json() as {
        nodes: Array<{
          id: string;
          type: string;
          selectable: boolean;
          skipReason?: string;
          children: Array<{
            id: string;
            type: string;
            selectable: boolean;
            skipReason?: string;
            recommendedMode?: string;
            rowContent?: string;
            isWiki?: boolean;
            rowCount?: number;
            columns?: string[];
          }>;
        }>;
      };
      expect(Object.keys(body).sort()).toEqual(['nodes']);
      const handbook = body.nodes.find((n) => n.id === 'handbook');
      expect(handbook).toMatchObject({ type: 'page', selectable: true });
      const crm = handbook?.children.find((c) => c.id === 'crm');
      const nested = handbook?.children.find((c) => c.id === 'nested');
      expect(crm).toMatchObject({
        type: 'database',
        selectable: true,
        isWiki: false,
      });
      expect(crm?.skipReason).toBeUndefined();
      expect(nested).toMatchObject({ type: 'page', selectable: true });
      expect(JSON.stringify(body)).not.toContain('row-only-via-query');
    } finally {
      await instance.close();
    }
  });

  it('serves a second tree GET from cache without another Notion search', async () => {
    const instance = await app();
    try {
      await instance.inject({ method: 'PUT', url: '/api/notion/connection', payload: { token: TOKEN } });
      server.requests.length = 0;
      const first = await instance.inject({ method: 'GET', url: '/api/notion/tree' });
      expect(first.statusCode).toBe(200);
      expect(server.requests.filter((r) => r.url.includes('/v1/search')).length).toBeGreaterThan(0);
      const firstBody = first.json();
      server.requests.length = 0;
      const second = await instance.inject({ method: 'GET', url: '/api/notion/tree' });
      expect(second.statusCode).toBe(200);
      expect(second.json()).toEqual(firstBody);
      expect(server.requests.filter((r) => r.url.includes('/v1/search'))).toEqual([]);
    } finally {
      await instance.close();
    }
  });

  it('invalidates the tree cache when the Notion token is replaced', async () => {
    const instance = await app();
    try {
      await instance.inject({ method: 'PUT', url: '/api/notion/connection', payload: { token: TOKEN } });
      await instance.inject({ method: 'GET', url: '/api/notion/tree' });
      server.requests.length = 0;
      await instance.inject({ method: 'PUT', url: '/api/notion/connection', payload: { token: TOKEN } });
      const after = await instance.inject({ method: 'GET', url: '/api/notion/tree' });
      expect(after.statusCode).toBe(200);
      expect(server.requests.filter((r) => r.url.includes('/v1/search')).length).toBeGreaterThan(0);
    } finally {
      await instance.close();
    }
  });
});

describe.skipIf(!dbAvailable)('GET /api/notion/tree upstream failures (#1463)', () => {
  let server: FakeNotionServer;
  let userId: string;

  beforeAll(async () => {
    await setupTestDb();
  });

  afterAll(async () => {
    setNotionApiBaseUrlForTests(null);
    await teardownTestDb();
  });

  beforeEach(async () => {
    await truncateAllTables();
    userId = await insertUser('notion-tree-5xx-user');
    server = await startFakeNotionServer({
      validToken: TOKEN,
      searchResults: [
        {
          object: 'page',
          id: 'handbook',
          parent: { type: 'workspace', workspace: true },
          properties: {
            title: { type: 'title', title: [{ type: 'text', plain_text: 'Handbook' }] },
          },
        },
      ],
      blockChildrenErrors: { handbook: 503 },
    });
    setNotionApiBaseUrlForTests(server.baseUrl);
  });

  afterEach(async () => {
    expect(JSON.stringify(server.requests.map((r) => r.url))).not.toContain('api.notion.com');
    await server.close();
    setNotionApiBaseUrlForTests(null);
  });

  it('returns the Search tree when Notion page bodies are unavailable and never echoes the token', async () => {
    const instance = await buildKnowledgeTestApp(() => userId, async (fastify) => {
      await fastify.register(notionRoutes, { prefix: '/api' });
    });
    try {
      await instance.inject({ method: 'PUT', url: '/api/notion/connection', payload: { token: TOKEN } });
      const res = await instance.inject({ method: 'GET', url: '/api/notion/tree' });
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain(TOKEN);
      expect(res.json()).toMatchObject({
        nodes: [{ id: 'handbook', title: 'Handbook', type: 'page', selectable: true }],
      });
      expect(server.requests.filter((request) => request.url.includes('/children'))).toEqual([]);
    } finally {
      await instance.close();
    }
  });
});

describe.skipIf(!dbAvailable)('POST /api/notion/import (#1465)', () => {
  let server: FakeNotionServer;
  let userId: string;

  beforeAll(async () => {
    await setupTestDb();
    server = await startFakeNotionServer({
      validToken: TOKEN,
      pages: {
        notes: {
          object: 'page',
          id: 'notes',
          parent: { type: 'workspace', workspace: true },
          properties: {
            title: { type: 'title', title: [{ type: 'text', plain_text: 'Notes' }] },
          },
        },
      },
      databases: {
        crm: { object: 'database', id: 'crm', title: [{ type: 'text', plain_text: 'CRM' }] },
      },
      databaseQueryResults: {
        crm: [{ object: 'page', id: 'hidden-row' }],
      },
      blockChildren: {
        notes: [
          {
            object: 'block',
            id: 'p1',
            type: 'paragraph',
            paragraph: {
              rich_text: [{ type: 'text', plain_text: 'Imported via route', text: { content: 'Imported via route' } }],
            },
          },
        ],
      },
    });
    setNotionApiBaseUrlForTests(server.baseUrl);
  });

  afterAll(async () => {
    setNotionApiBaseUrlForTests(null);
    await server.close();
    await teardownTestDb();
  });

  beforeEach(async () => {
    await truncateAllTables();
    userId = await insertUser('notion-import-route-user');
    server.requests.length = 0;
  });

  afterEach(() => {
    expect(JSON.stringify(server.requests.map((r) => r.url))).not.toContain('api.notion.com');
    // Row enumeration via POST /v1/databases/:id/query is deliberate now: a
    // database imported as a table has to read every row.
  });

  async function app() {
    return buildKnowledgeTestApp(() => userId, async (fastify) => {
      await fastify.register(notionRoutes, { prefix: '/api' });
    });
  }

  it('returns 400 when Notion is not connected and never echoes a secret', async () => {
    const instance = await app();
    try {
      const res = await instance.inject({
        method: 'POST',
        url: '/api/notion/import',
        payload: { pageIds: ['notes'] },
      });
      expect(res.statusCode).toBe(400);
      expect(res.body).not.toContain(TOKEN);
    } finally {
      await instance.close();
    }
  });

  it('imports a selected database as one table beside a page, and never returns the token', async () => {
    const instance = await app();
    try {
      await instance.inject({ method: 'PUT', url: '/api/notion/connection', payload: { token: TOKEN } });
      const res = await instance.inject({
        method: 'POST',
        url: '/api/notion/import',
        payload: { pageIds: ['crm', 'notes'], visibility: 'private', databaseModes: { crm: 'table' } },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain(TOKEN);
      const body = res.json() as {
        items: Array<{
          notionPageId: string;
          status: string;
          localPageId?: number;
          reason?: string;
          importedAs?: string;
        }>;
      };
      expect(Object.keys(body).sort()).toEqual(['items']);
      const byId = Object.fromEntries(body.items.map((i) => [i.notionPageId, i]));
      expect(byId.crm).toMatchObject({ status: 'success', importedAs: 'table' });
      expect(byId.notes).toMatchObject({ status: 'success' });
      expect(typeof byId.notes?.localPageId).toBe('number');

      const dbPage = await query<{ notion_page_id: string | null; body_html: string }>(
        'SELECT notion_page_id, body_html FROM pages WHERE id = $1',
        [byId.crm!.localPageId],
      );
      expect(dbPage.rows[0]!.notion_page_id).toBe('crm');
      expect(dbPage.rows[0]!.body_html).toContain('<table>');

      const page = await query<{ source: string; visibility: string; body_html: string }>(
        'SELECT source, visibility, body_html FROM pages WHERE id = $1',
        [byId.notes!.localPageId],
      );
      expect(page.rows[0]).toMatchObject({ source: 'standalone', visibility: 'private' });
      expect(page.rows[0]!.body_html).toContain('Imported via route');

      const again = await instance.inject({
        method: 'POST',
        url: '/api/notion/import',
        payload: { pageIds: ['notes'] },
      });
      expect(again.json().items[0]).toMatchObject({
        notionPageId: 'notes',
        status: 'already_imported',
        localPageId: byId.notes!.localPageId,
      });
      expect(again.body).not.toContain(TOKEN);

      const get = await instance.inject({ method: 'GET', url: '/api/notion/connection' });
      expect(get.json()).toEqual({ hasToken: true });
      expect(get.body).not.toContain(TOKEN);
    } finally {
      await instance.close();
    }
  });

  it('invalidates the tree cache after a successful import', async () => {
    const instance = await app();
    try {
      await instance.inject({ method: 'PUT', url: '/api/notion/connection', payload: { token: TOKEN } });
      const first = await instance.inject({ method: 'GET', url: '/api/notion/tree' });
      expect(first.statusCode).toBe(200);
      server.requests.length = 0;
      const imported = await instance.inject({
        method: 'POST',
        url: '/api/notion/import',
        payload: { pageIds: ['notes'], visibility: 'private' },
      });
      expect(imported.statusCode).toBe(200);
      const after = await instance.inject({ method: 'GET', url: '/api/notion/tree' });
      expect(after.statusCode).toBe(200);
      expect(server.requests.filter((r) => r.url.includes('/v1/search')).length).toBeGreaterThan(0);
    } finally {
      await instance.close();
    }
  });

  it('audits overwrite of an existing page as PAGE_UPDATED', async () => {
    const orig = await query<{ id: number }>(
      `INSERT INTO pages (title, body_html, body_text, version, source, created_by_user_id, notion_page_id)
       VALUES ('Old Notes', '<p>old</p>', 'old', 1, 'standalone', $1, 'notes') RETURNING id`,
      [userId],
    );
    const pageId = orig.rows[0]!.id;
    const instance = await app();
    try {
      await instance.inject({ method: 'PUT', url: '/api/notion/connection', payload: { token: TOKEN } });
      const res = await instance.inject({
        method: 'POST',
        url: '/api/notion/import',
        payload: { pageIds: ['notes'], visibility: 'private', overwriteExisting: true },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().items[0]).toMatchObject({
        notionPageId: 'notes',
        status: 'success',
        localPageId: pageId,
      });
      const audit = await query<{ action: string }>(
        `SELECT action FROM audit_log WHERE resource_type = 'page' AND resource_id = $1 ORDER BY created_at`,
        [String(pageId)],
      );
      expect(audit.rows.map((r) => r.action)).toEqual(['PAGE_UPDATED']);
    } finally {
      await instance.close();
    }
  });

  it('GET handlers still never decrypt the token after the import route is added', () => {
    const src = readFileSync(new URL('./notion.ts', import.meta.url), 'utf8');
    const start = src.indexOf("fastify.get('/notion/connection'");
    const end = src.indexOf("fastify.put('/notion/connection'");
    const connectionGet = src.slice(start, end);
    expect(connectionGet).not.toContain('getDecryptedNotionToken');
    expect(src).not.toMatch(/queryDatabase|\/v1\/databases\/.*query/);
  });
});
