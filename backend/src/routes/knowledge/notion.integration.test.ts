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

  it('GET handler source never decrypts or names the secret', () => {
    const src = readFileSync(new URL('./notion.ts', import.meta.url), 'utf8');
    expect(src).not.toContain('getDecryptedNotionToken');
    expect(src).not.toContain('decryptPat');
    expect(src).toContain('getNotionConnectionStatus');
  });
});
