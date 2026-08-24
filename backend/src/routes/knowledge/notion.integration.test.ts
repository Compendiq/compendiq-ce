import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
import { NOTION_UNSUPPORTED_LABEL } from '@compendiq/contracts';
import { buildKnowledgeTestApp, insertUser } from './pages.test-helpers.js';
import { notionRoutes } from './notion.js';

const dbAvailable = await isDbAvailable();
const TOKEN = 'secret_route_ntn_must_never_appear_on_get';

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

  it('returns pages and databases with skip labels; GET body never includes the token', async () => {
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
          children: Array<{ id: string; type: string; selectable: boolean; skipReason?: string }>;
        }>;
      };
      expect(Object.keys(body).sort()).toEqual(['nodes']);
      const handbook = body.nodes.find((n) => n.id === 'handbook');
      expect(handbook).toMatchObject({ type: 'page', selectable: true });
      const crm = handbook?.children.find((c) => c.id === 'crm');
      const nested = handbook?.children.find((c) => c.id === 'nested');
      expect(crm).toMatchObject({
        type: 'database',
        selectable: false,
        skipReason: NOTION_UNSUPPORTED_LABEL,
      });
      expect(nested).toMatchObject({ type: 'page', selectable: true });
      expect(JSON.stringify(body)).not.toContain('row-only-via-query');
    } finally {
      await instance.close();
    }
  });
});
