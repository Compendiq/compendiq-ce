import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { createClient, type RedisClientType } from 'redis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { query } from '../../core/db/postgres.js';
import { resolveBulkSelection } from '../../core/services/bulk-page-selection.js';
import { setRedisClient } from '../../core/services/redis-cache.js';
import { isDbAvailable, setupTestDb, teardownTestDb, truncateAllTables } from '../../test-db-helper.js';
import { isRedisAvailable } from '../../test-redis-helper.js';
import { pagesCrudRoutes } from './pages-crud.js';
import { buildKnowledgeTestApp, insertLocalSpace, insertStandalonePage, insertUser } from './pages.test-helpers.js';

const available = await isDbAvailable() && await isRedisAvailable();

describe.skipIf(!available)('page list visibility and bulk selection', () => {
  let app: FastifyInstance;
  let redis: RedisClientType;
  let userId: string;
  let ownPrivate: number;
  let ownShared: number;
  let otherShared: number;
  let confluencePrivate: number;
  let confluenceShared: number;
  const users = new Set<string>();

  beforeAll(async () => {
    await setupTestDb();
    redis = createClient({ url: process.env.REDIS_URL, socket: { reconnectStrategy: false, connectTimeout: 1_000 } });
    redis.on('error', () => undefined);
    await redis.connect();
    setRedisClient(redis);
    app = await buildKnowledgeTestApp(() => userId, async (instance) => {
      instance.redis = redis;
      await instance.register(pagesCrudRoutes, { prefix: '/api' });
    });
  });

  afterAll(async () => {
    await app.close();
    for (const id of users) {
      let cursor = '0';
      do {
        const result = await redis.scan(cursor, { MATCH: `kb:${id}:*`, COUNT: 100 });
        cursor = String(result.cursor);
        if (result.keys.length) await redis.del(result.keys);
      } while (cursor !== '0');
      await redis.del([`kb-cache-generation:pages:user:${id}`, `rbac:admin:${id}`, `rbac:spaces:${id}`]);
    }
    setRedisClient(null);
    await redis.quit();
    await teardownTestDb();
  });

  beforeEach(async () => {
    await truncateAllTables();
    userId = await insertUser(`list-visibility-${randomUUID()}`);
    const other = await insertUser(`list-visibility-other-${randomUUID()}`);
    users.add(userId);
    users.add(other);
    await insertLocalSpace('LOCAL', userId);
    ownPrivate = await insertStandalonePage('Confluence private own', 'private', userId, 'LOCAL');
    ownShared = await insertStandalonePage('Confluence shared own', 'shared', userId, 'LOCAL');
    otherShared = await insertStandalonePage('Confluence shared other', 'shared', other, 'LOCAL');
    await insertStandalonePage('Confluence private other', 'private', other, 'LOCAL');
    await query("INSERT INTO spaces (space_key, space_name, source, last_synced) VALUES ('DEV', 'Dev', 'confluence', NOW()), ('HIDDEN', 'Hidden', 'confluence', NOW())");
    await query(`WITH reader AS (INSERT INTO roles (name, display_name, permissions)
      VALUES ($1, 'Reader', ARRAY['read']) RETURNING id)
      INSERT INTO space_role_assignments (space_key, principal_type, principal_id, role_id)
      SELECT 'DEV', 'user', $2, id FROM reader`, [`reader-${randomUUID()}`, userId]);
    const synced = await query<{ id: number }>(`INSERT INTO pages
      (confluence_id, source, space_key, title, body_text, body_storage, body_html, visibility, inherit_perms)
      VALUES ('conf-private', 'confluence', 'DEV', 'Confluence synced private', 'confluence', '', '', 'private', TRUE),
             ('conf-shared', 'confluence', 'DEV', 'Confluence synced shared', 'confluence', '', '', 'shared', TRUE),
             ('conf-hidden', 'confluence', 'HIDDEN', 'Confluence hidden', 'confluence', '', '', 'shared', TRUE)
      RETURNING id`);
    confluencePrivate = synced.rows[0]!.id;
    confluenceShared = synced.rows[1]!.id;
  });

  async function list(visibility?: 'private' | 'shared', extra = '') {
    const params = new URLSearchParams(extra);
    if (visibility) params.set('visibility', visibility);
    const response = await app.inject({ method: 'GET', url: `/api/pages?${params}` });
    expect(response.statusCode, response.body).toBe(200);
    return response.json() as { items: Array<{ id: string }>; total: number; fuzzyMatch?: boolean };
  }

  async function compare(visibility: 'private' | 'shared' | undefined, expected: number[]) {
    const result = await list(visibility);
    const bulk = await resolveBulkSelection(userId, {
      filter: visibility ? { visibility } : {}, expectedCount: expected.length, driftToleranceFraction: 0,
    }, ['DEV']);
    const ids = result.items.map((item) => Number(item.id)).sort((a, b) => a - b);
    expect(result.total).toBe(expected.length);
    expect(ids).toEqual([...expected].sort((a, b) => a - b));
    expect(bulk.rows.map((row) => row.id).sort((a, b) => a - b)).toEqual(ids);
  }

  it.each([
    ['private', 'shared', 'all'],
    ['shared', 'all', 'private'],
    ['all', 'private', 'shared'],
  ] as const)('separates cache entries when warmed %s, %s, %s', async (...order) => {
    const expected = {
      private: [ownPrivate, confluencePrivate],
      shared: [ownShared, otherShared, confluenceShared],
      all: [ownPrivate, ownShared, otherShared, confluencePrivate, confluenceShared],
    };
    for (const key of [...order, ...order]) await compare(key === 'all' ? undefined : key, expected[key]);
    const page = await list('shared', 'limit=1&page=2');
    expect(page.total).toBe(3);
    expect(page.items).toHaveLength(1);
  });

  it('keeps visibility in the ILIKE fallback and relevance pagination', async () => {
    for (const visibility of ['private', 'shared'] as const) {
      const result = await list(visibility, 'search=confl&sort=relevance&limit=1&page=2');
      expect(result.fuzzyMatch).toBe(true);
      expect(result.total).toBe(visibility === 'private' ? 2 : 3);
      expect(result.items).toHaveLength(1);
      const id = Number(result.items[0]!.id);
      expect(visibility === 'private' ? [ownPrivate, confluencePrivate] : [ownShared, otherShared, confluenceShared]).toContain(id);
    }
  });
});
