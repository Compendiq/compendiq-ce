import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient, type RedisClientType } from 'redis';
import type { FastifyInstance } from 'fastify';
import {
  isDbAvailable,
  setupTestDb,
  teardownTestDb,
  truncateAllTables,
} from '../../test-db-helper.js';
import { isRedisAvailable } from '../../test-redis-helper.js';
import { query } from '../../core/db/postgres.js';
import { setRedisClient } from '../../core/services/redis-cache.js';
import { pagesCrudRoutes } from './pages-crud.js';
import {
  buildKnowledgeTestApp,
  insertConfluencePage,
  insertLocalSpace,
  insertStandalonePage,
  insertUser,
} from './pages.test-helpers.js';

const available = await isDbAvailable() && await isRedisAvailable();

async function grantRead(userId: string, spaceKey: string): Promise<void> {
  const role = await query<{ id: number }>(
    `INSERT INTO roles (name, display_name, is_system, permissions)
     VALUES ('tree-reader', 'Tree reader', FALSE, ARRAY['read'])
     ON CONFLICT (name) DO UPDATE SET permissions = EXCLUDED.permissions
     RETURNING id`,
  );
  await query(
    `INSERT INTO space_role_assignments (space_key, principal_type, principal_id, role_id)
     VALUES ($1, 'user', $2, $3)`,
    [spaceKey, userId, role.rows[0]!.id],
  );
}

describe.skipIf(!available)('GET /api/pages/tree — real persistence and authority', () => {
  let app: FastifyInstance;
  let redis: RedisClientType;
  let userId: string;

  beforeAll(async () => {
    await setupTestDb();
    redis = createClient({
      url: process.env.REDIS_URL,
      socket: { reconnectStrategy: false, connectTimeout: 1_000 },
    }) as RedisClientType;
    await redis.connect();
    setRedisClient(redis);
    app = await buildKnowledgeTestApp(() => userId, async (instance) => {
      instance.redis = redis;
      await instance.register(pagesCrudRoutes, { prefix: '/api' });
    });
  });

  afterAll(async () => {
    await app.close();
    if (redis.isOpen) await redis.quit();
    await teardownTestDb();
  });

  beforeEach(async () => {
    await truncateAllTables();
    await redis.flushDb();
    userId = await insertUser('tree_reader');
    await query(
      `INSERT INTO spaces (space_key, space_name, source, last_synced)
       VALUES ('DEV', 'DEV', 'confluence', NOW())`,
    );
    await insertLocalSpace('OPS', userId);
    await grantRead(userId, 'DEV');
    await grantRead(userId, 'OPS');
  });

  it('returns minimal rows with string IDs and source-aware parent relationships', async () => {
    const confluenceRoot = await insertConfluencePage('conf-root', 'Confluence root', 'DEV');
    const confluenceChild = await insertConfluencePage('conf-child', 'Confluence child', 'DEV', {
      parentId: 'conf-root',
    });
    const localRoot = await insertStandalonePage('Local root', 'private', userId, 'OPS');
    const localChild = await insertStandalonePage('Local child', 'private', userId, 'OPS', {
      parentId: String(localRoot),
    });
    await query(
      `UPDATE pages
          SET labels = CASE WHEN id = $1 THEN ARRAY['architecture']::text[] ELSE labels END,
              embedding_dirty = FALSE,
              embedding_status = 'embedded',
              embedded_at = '2026-03-01T00:00:00Z'
        WHERE id = ANY($2::int[])`,
      [confluenceRoot, [confluenceRoot, confluenceChild]],
    );

    const response = await app.inject({ method: 'GET', url: '/api/pages/tree' });
    expect(response.statusCode).toBe(200);
    const items = response.json().items as Array<Record<string, unknown>>;
    expect(response.json().total).toBe(4);

    const byId = new Map(items.map((item) => [item.id, item]));
    expect(byId.get(String(confluenceRoot))).toMatchObject({
      title: 'Confluence root',
      parentId: null,
      labels: ['architecture'],
      embeddingDirty: false,
      embeddingStatus: 'embedded',
      embeddedAt: '2026-03-01T00:00:00.000Z',
    });
    expect(byId.get(String(confluenceChild))?.parentId).toBe(String(confluenceRoot));
    expect(byId.get(String(localChild))?.parentId).toBe(String(localRoot));
    for (const item of items) {
      expect(typeof item.id).toBe('string');
      expect(item).not.toHaveProperty('bodyHtml');
      expect(item).not.toHaveProperty('bodyText');
      expect(item).not.toHaveProperty('bodyStorage');
    }
  });

  it('orders siblings by persisted sort order rather than title', async () => {
    const pageA = await insertStandalonePage('Page A', 'private', userId, 'DEV');
    const pageB = await insertStandalonePage('Page B', 'private', userId, 'DEV');
    await query('UPDATE pages SET sort_order = 2 WHERE id = $1', [pageA]);
    await query('UPDATE pages SET sort_order = 1 WHERE id = $1', [pageB]);

    const response = await app.inject({ method: 'GET', url: '/api/pages/tree?spaceKey=DEV' });
    expect(response.statusCode).toBe(200);
    expect(response.json().items.map((item: { id: string; sortOrder: number }) => [item.id, item.sortOrder])).toEqual([
      [String(pageB), 1],
      [String(pageA), 2],
    ]);
  });

  it('filters by space without leaking rows from another accessible space', async () => {
    const dev = await insertStandalonePage('Dev', 'private', userId, 'DEV');
    await insertStandalonePage('Ops', 'private', userId, 'OPS');

    const response = await app.inject({ method: 'GET', url: '/api/pages/tree?spaceKey=DEV' });
    expect(response.statusCode).toBe(200);
    expect(response.json().items.map((item: { id: string }) => item.id)).toEqual([String(dev)]);
  });

  it('returns an empty contract when no pages exist', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/pages/tree' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ items: [], total: 0 });
  });

  it('merges owned local spaces with role-authorized Confluence spaces', async () => {
    const local = await insertStandalonePage('Local note', 'private', userId, 'OPS');
    const synced = await insertConfluencePage('conf-dev', 'Dev page', 'DEV');

    const response = await app.inject({ method: 'GET', url: '/api/pages/tree' });
    expect(response.statusCode).toBe(200);
    const ids = response.json().items.map((item: { id: string }) => item.id);
    expect(ids).toEqual(expect.arrayContaining([String(local), String(synced)]));
  });
});
