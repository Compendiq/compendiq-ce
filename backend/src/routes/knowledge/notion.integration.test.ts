import type { FastifyInstance } from 'fastify';
import { createClient, type RedisClientType } from 'redis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isDbAvailable,
  setupTestDb,
  teardownTestDb,
  truncateAllTables,
} from '../../test-db-helper.js';
import { isRedisAvailable } from '../../test-redis-helper.js';
import { query } from '../../core/db/postgres.js';
import { setRedisClient } from '../../core/services/redis-cache.js';
import { userCanAccessPage } from '../../core/services/rbac-service.js';
import { decryptPat, isEncryptedSecretFormat } from '../../core/utils/crypto.js';
import { startFakeNotionServer, type FakeNotionServer } from '../../domains/knowledge/services/__fixtures__/fake-notion-server.js';
import { setNotionApiBaseUrlForTests } from '../../domains/knowledge/services/notion-client.js';
import { resetNotionImportStatusForTests } from '../../domains/knowledge/services/notion-import-job.js';
import { buildKnowledgeTestApp, insertLocalSpace, insertUser } from './pages.test-helpers.js';
import { notionRoutes } from './notion.js';

const [dbAvailable, redisAvailable] = await Promise.all([
  isDbAvailable(),
  isRedisAvailable(),
]);
const dependenciesAvailable = dbAvailable && redisAvailable;
const TOKEN = 'secret_route_ntn_must_never_appear_on_get';
const testUserIds = new Set<string>();
let redis: RedisClientType;

beforeAll(async () => {
  if (!dependenciesAvailable) return;
  redis = createClient({
    url: process.env.REDIS_URL ?? 'redis://localhost:6379',
    socket: { connectTimeout: 1_000, reconnectStrategy: false },
  });
  await redis.connect();
  setRedisClient(redis);
});

beforeEach(() => {
  testUserIds.clear();
  resetNotionImportStatusForTests();
});

afterEach(async () => {
  if (!dependenciesAvailable) return;
  for (const userId of testUserIds) {
    await vi.waitFor(async () => {
      expect(await redis.exists(`notion:import:lock:${userId}`)).toBe(0);
    }, { timeout: 10_000, interval: 20 });
    await redis.del([
      `kb:${userId}:notion_tree:workspace`,
      `notion:import:status:${userId}`,
      `notion:import:lock:${userId}`,
    ]);
  }
  resetNotionImportStatusForTests();
});

afterAll(async () => {
  setNotionApiBaseUrlForTests(null);
  setRedisClient(null);
  if (redis?.isOpen) await redis.quit();
});

async function insertNotionUser(username: string): Promise<string> {
  const userId = await insertUser(username);
  testUserIds.add(userId);
  return userId;
}

async function buildNotionTestApp(getUserId: () => string): Promise<FastifyInstance> {
  return buildKnowledgeTestApp(getUserId, async (fastify) => {
    fastify.redis = redis;
    await fastify.register(notionRoutes, { prefix: '/api' });
  });
}

describe.skipIf(!dependenciesAvailable)('GET/PUT/DELETE /api/notion/connection (#1462)', () => {
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
    userId = await insertNotionUser('notion-route-user');
  });

  afterEach(() => {
    expect(JSON.stringify(server.requests.map((r) => r.url))).not.toContain('api.notion.com');
  });

  async function app() {
    return buildNotionTestApp(() => userId);
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

  it('keeps connection state private to the authenticated user', async () => {
    const ownerId = userId;
    const otherUserId = await insertNotionUser('notion-route-other-user');
    const instance = await app();
    try {
      const connected = await instance.inject({
        method: 'PUT',
        url: '/api/notion/connection',
        payload: { token: TOKEN },
      });
      expect(connected.statusCode).toBe(200);

      userId = otherUserId;
      const otherStatus = await instance.inject({ method: 'GET', url: '/api/notion/connection' });
      expect(otherStatus.statusCode).toBe(200);
      expect(otherStatus.json()).toEqual({ hasToken: false });
      expect(otherStatus.body).not.toContain(TOKEN);

      userId = ownerId;
      const ownerStatus = await instance.inject({ method: 'GET', url: '/api/notion/connection' });
      expect(ownerStatus.json()).toEqual({ hasToken: true });
      expect(ownerStatus.body).not.toContain(TOKEN);
    } finally {
      userId = ownerId;
      await instance.close();
    }
  });
});

describe.skipIf(!dependenciesAvailable)('GET /api/notion/tree (#1463)', () => {
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
    userId = await insertNotionUser('notion-tree-user');
    server.requests.length = 0;
  });

  afterEach(() => {
    expect(JSON.stringify(server.requests.map((r) => r.url))).not.toContain('api.notion.com');
    expect(server.requests.some((r) => r.url.includes('/query'))).toBe(false);
  });

  async function app() {
    return buildNotionTestApp(() => userId);
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

describe.skipIf(!dependenciesAvailable)('GET /api/notion/tree upstream failures (#1463)', () => {
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
    userId = await insertNotionUser('notion-tree-5xx-user');
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
    const instance = await buildNotionTestApp(() => userId);
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

describe('POST /api/notion/import (#1465)', () => {
  let server: FakeNotionServer;
  let userId: string;

  beforeAll(async () => {
    expect(dependenciesAvailable, '#1739 import regressions require real PostgreSQL and Redis').toBe(true);
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
    userId = await insertNotionUser('notion-import-route-user');
    server.requests.length = 0;
  });

  afterEach(() => {
    expect(JSON.stringify(server.requests.map((r) => r.url))).not.toContain('api.notion.com');
    // Row enumeration via POST /v1/databases/:id/query is deliberate now: a
    // database imported as a table has to read every row.
  });

  async function app() {
    return buildNotionTestApp(() => userId);
  }

  type ImportItem = {
    notionPageId: string;
    status: string;
    localPageId?: number;
    reason?: string;
    importedAs?: string;
  };

  async function waitForImportComplete(instance: FastifyInstance): Promise<{ items: ImportItem[] }> {
    const done = await vi.waitFor(
      async () => {
        const res = await instance.inject({ method: 'GET', url: '/api/notion/import/status' });
        expect(res.statusCode).toBe(200);
        const body = res.json() as { status: string; items?: ImportItem[]; error?: string };
        expect(body.status).not.toBe('importing');
        return body;
      },
      { timeout: 10_000, interval: 20 },
    );
    expect(done.status).toBe('complete');
    expect(Array.isArray(done.items)).toBe(true);
    return { items: done.items as ImportItem[] };
  }

  async function importUntilComplete(
    instance: FastifyInstance,
    payload: Record<string, unknown>,
  ): Promise<{ items: ImportItem[] }> {
    const post = await instance.inject({
      method: 'POST',
      url: '/api/notion/import',
      payload,
    });
    expect(post.statusCode).toBe(202);
    expect(post.json()).toEqual({ status: 'importing' });
    expect(post.body).not.toContain(TOKEN);
    return waitForImportComplete(instance);
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
      const body = await importUntilComplete(instance, {
        pageIds: ['crm', 'notes'],
        visibility: 'private',
        databaseModes: { crm: 'table' },
      });
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

      const again = await importUntilComplete(instance, { pageIds: ['notes'] });
      expect(again.items[0]).toMatchObject({
        notionPageId: 'notes',
        status: 'already_imported',
        localPageId: byId.notes!.localPageId,
      });


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
      await importUntilComplete(instance, { pageIds: ['notes'], visibility: 'private' });
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
      const res = await importUntilComplete(instance, {
        pageIds: ['notes'],
        visibility: 'private',
        overwriteExisting: true,
      });
      expect(res.items[0]).toMatchObject({
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

  it('holds one real import lock per authenticated user and exposes its status', async () => {
    const ownerId = userId;
    const otherUserId = await insertNotionUser('notion-import-route-other-user');
    const instance = await app();
    server.state.lookupDelayMs = 250;
    try {
      await instance.inject({ method: 'PUT', url: '/api/notion/connection', payload: { token: TOKEN } });
      const accepted = await instance.inject({
        method: 'POST',
        url: '/api/notion/import',
        payload: { pageIds: ['notes'], visibility: 'private' },
      });
      expect(accepted.statusCode).toBe(202);
      expect(accepted.json()).toEqual({ status: 'importing' });

      const active = await instance.inject({ method: 'GET', url: '/api/notion/import/status' });
      expect(active.statusCode).toBe(200);
      expect(active.json()).toEqual({ status: 'importing' });

      const duplicate = await instance.inject({
        method: 'POST',
        url: '/api/notion/import',
        payload: { pageIds: ['notes'], visibility: 'private' },
      });
      expect(duplicate.statusCode).toBe(409);
      expect(duplicate.json()).toMatchObject({
        message: 'Notion import already in progress',
        statusCode: 409,
      });

      userId = otherUserId;
      const otherStatus = await instance.inject({ method: 'GET', url: '/api/notion/import/status' });
      expect(otherStatus.statusCode).toBe(200);
      expect(otherStatus.json()).toEqual({ status: 'idle' });

      userId = ownerId;
      const completed = await waitForImportComplete(instance);
      expect(completed.items[0]).toMatchObject({
        notionPageId: 'notes',
        status: 'success',
      });
    } finally {
      server.state.lookupDelayMs = undefined;
      userId = ownerId;
      await instance.close();
    }
  });

  describe('#1739 bounded local destination parent', () => {
    async function persistedBoundaryState() {
      const state: Record<string, unknown> = {};
      for (const table of ['pages', 'page_versions', 'page_write_intents', 'page_relocation_preparations', 'page_baselines']) {
        state[table] = (await query<{ rows: unknown }>(
          `SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), '[]'::jsonb) AS rows FROM ${table} t`,
        )).rows[0]!.rows;
      }
      return state;
    }

    for (const parentId of [
      'abc', '2147483648', 2_147_483_648, '3000000000', 3_000_000_000,
      '9007199254740993', 9_007_199_254_740_992,
    ]) {
      it(`#1739 RED R-P30 rejects parent ${String(parentId)} (${typeof parentId}) before allocating a job`, async () => {
        await insertLocalSpace('IDLOCAL', userId);
        await query(
          `INSERT INTO pages (source, confluence_id, space_key, title, body_html, body_text, visibility)
           VALUES ('confluence', $1, 'IDLOCAL', 'Parent text decoy', '<p>decoy</p>', 'decoy', 'shared')`,
          [String(parentId)],
        );
        const instance = await app();
        try {
          const connected = await instance.inject({
            method: 'PUT', url: '/api/notion/connection', payload: { token: TOKEN },
          });
          expect(connected.statusCode, connected.body).toBe(200);
          server.requests.length = 0;
          const before = await persistedBoundaryState();
          const response = await instance.inject({
            method: 'POST', url: '/api/notion/import',
            payload: { pageIds: ['notes'], parentId, spaceKey: 'IDLOCAL' },
          });
          expect.soft(response.statusCode, response.body).toBe(400);
          // Old code accepts202 and starts a failing job. Drain that real job
          // even while the expected400 assertion is red, before DB teardown.
          if (response.statusCode === 202) {
            await vi.waitFor(async () => {
              const status = await instance.inject({ method: 'GET', url: '/api/notion/import/status' });
              expect(status.json<{ status: string }>().status).not.toBe('importing');
            }, { timeout: 10_000, interval: 20 });
          }
          expect.soft(response.body).not.toContain(TOKEN);
          expect.soft(response.body).not.toMatch(/22003|22P02|out of range for type integer/);
          expect(await persistedBoundaryState()).toEqual(before);
          expect(server.requests).toEqual([]);
          expect(await redis.exists(`notion:import:lock:${userId}`)).toBe(0);
          expect.soft(await redis.exists(`notion:import:status:${userId}`)).toBe(0);
          const status = await instance.inject({ method: 'GET', url: '/api/notion/import/status' });
          expect.soft(status.json()).toEqual({ status: 'idle' });
        } finally {
          await instance.close();
        }
      });
    }

    for (const parentId of ['2147483647', 2_147_483_647, '0002147483647']) {
      it(`#1739 CONTROL completed import under max parent ${String(parentId)} (${typeof parentId})`, async () => {
        await insertLocalSpace('IDLOCAL', userId);
        await query(
          `INSERT INTO pages
             (id, source, space_key, title, body_html, body_text, visibility, created_by_user_id, path, depth)
           VALUES (2147483647, 'standalone', 'IDLOCAL', 'Max local parent',
                   '<p>Parent remains</p>', 'Parent remains', 'private', $1, '/2147483647', 0)`,
          [userId],
        );
        const parentBefore = (await query('SELECT to_jsonb(p) AS page FROM pages p WHERE id = 2147483647')).rows;
        const instance = await app();
        try {
          const connected = await instance.inject({
            method: 'PUT', url: '/api/notion/connection', payload: { token: TOKEN },
          });
          expect(connected.statusCode).toBe(200);
          const result = await importUntilComplete(instance, {
            pageIds: ['notes'], parentId, spaceKey: 'IDLOCAL',
          });
          const item = result.items.find((entry) => entry.notionPageId === 'notes');
          expect(item).toMatchObject({ status: 'success', notionPageId: 'notes' });
          expect(item?.localPageId).toBeGreaterThan(0);
          expect(item?.localPageId).toBeLessThan(2_147_483_647);
          const row = await query<{
            parent_id: string; path: string; depth: number; source: string; space_key: string; body_html: string;
          }>('SELECT parent_id, path, depth, source, space_key, body_html FROM pages WHERE id = $1', [item!.localPageId]);
          expect(row.rows[0]).toMatchObject({
            parent_id: '2147483647', path: `/2147483647/${item!.localPageId}`,
            depth: 1, source: 'standalone', space_key: 'IDLOCAL',
          });
          expect(row.rows[0]!.body_html).toContain('Imported via route');
          expect((await query('SELECT to_jsonb(p) AS page FROM pages p WHERE id = 2147483647')).rows).toEqual(parentBefore);
        } finally {
          await instance.close();
        }
      });
    }

    it('#1739 CONTROL local parent PK retains the resolved Confluence canonical key', async () => {
      await insertLocalSpace('IDLOCAL', userId);
      const parent = await query<{ id: number }>(
        `INSERT INTO pages (source, confluence_id, space_key, title, body_html, body_text, visibility)
         VALUES ('confluence', '3000000000', 'IDLOCAL', 'Synced destination', '<p>parent</p>', 'parent', 'shared')
         RETURNING id`,
      );
      const parentId = parent.rows[0]!.id;
      await query('UPDATE pages SET path = $2, depth = 0 WHERE id = $1', [parentId, `/${parentId}`]);
      const readerRole = await query<{ id: number }>(
        `INSERT INTO roles (name, display_name, is_system, permissions)
         VALUES ('id_boundary_parent_reader', 'ID Boundary Parent Reader', FALSE, ARRAY['read'])
         RETURNING id`,
      );
      await query(
        `INSERT INTO space_role_assignments (space_key, principal_type, principal_id, role_id)
         VALUES ('IDLOCAL', 'user', $1, $2)`,
        [userId, readerRole.rows[0]!.id],
      );
      expect(await userCanAccessPage(userId, parentId)).toBe(true);
      const parentBefore = (await query('SELECT to_jsonb(p) AS page FROM pages p WHERE id = $1', [parentId])).rows;
      const instance = await app();
      try {
        await instance.inject({ method: 'PUT', url: '/api/notion/connection', payload: { token: TOKEN } });
        const result = await importUntilComplete(instance, {
          pageIds: ['notes'], parentId: String(parentId), spaceKey: 'IDLOCAL',
        });
        const item = result.items.find((entry) => entry.notionPageId === 'notes');
        expect(item).toMatchObject({ status: 'success' });
        const child = await query<{ parent_id: string; path: string; source: string }>(
          'SELECT parent_id, path, source FROM pages WHERE id = $1', [item!.localPageId],
        );
        expect(child.rows[0]).toEqual({
          parent_id: '3000000000', path: `/${parentId}/${item!.localPageId}`, source: 'standalone',
        });
        expect((await query('SELECT to_jsonb(p) AS page FROM pages p WHERE id = $1', [parentId])).rows).toEqual(parentBefore);
      } finally {
        await instance.close();
      }
    });

    for (const resourceId of ['notes', '9007199254740993']) {
      it(`#1739 CONTROL external Notion page ID ${resourceId} is not an int4 destination`, async () => {
        server.state.pages![resourceId] = {
          ...server.state.pages!.notes, id: resourceId,
        };
        server.state.blockChildren![resourceId] = server.state.blockChildren!.notes!;
        const instance = await app();
        try {
          await instance.inject({ method: 'PUT', url: '/api/notion/connection', payload: { token: TOKEN } });
          const result = await importUntilComplete(instance, { pageIds: [resourceId] });
          expect(result.items).toEqual(expect.arrayContaining([
            expect.objectContaining({ notionPageId: resourceId, status: 'success' }),
          ]));
          expect(server.requests.some((request) => request.url === `/v1/pages/${resourceId}`)).toBe(true);
        } finally {
          await instance.close();
        }
      });
    }
  });
});
