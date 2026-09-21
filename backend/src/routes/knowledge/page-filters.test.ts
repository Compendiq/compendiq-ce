import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { createClient, type RedisClientType } from 'redis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { query } from '../../core/db/postgres.js';
import { setRedisClient } from '../../core/services/redis-cache.js';
import {
  isDbAvailable,
  setupTestDb,
  teardownTestDb,
  truncateAllTables,
} from '../../test-db-helper.js';
import { isRedisAvailable } from '../../test-redis-helper.js';
import { pagesCrudRoutes } from './pages-crud.js';
import {
  buildKnowledgeTestApp,
  insertLocalSpace,
  insertUser,
} from './pages.test-helpers.js';

const [dbAvailable, redisAvailable] = await Promise.all([
  isDbAvailable(),
  isRedisAvailable(),
]);

async function grantSpaceRead(userId: string, spaceKey: string): Promise<void> {
  const role = await query<{ id: number }>(
    `INSERT INTO roles (name, display_name, is_system, permissions)
     VALUES ('page-filters-reader', 'Page filters reader', FALSE, ARRAY['read'])
     RETURNING id`,
  );
  await query(
    `INSERT INTO space_role_assignments (space_key, principal_type, principal_id, role_id)
     VALUES ($1, 'user', $2, $3)`,
    [spaceKey, userId, role.rows[0]!.id],
  );
}

async function removeUserRedisState(redis: RedisClientType, userId: string): Promise<void> {
  for (const pattern of [`kb:${userId}:*`, `rbac:*:${userId}*`]) {
    let cursor = '0';
    do {
      const result = await redis.scan(cursor, { MATCH: pattern, COUNT: 100 });
      cursor = String(result.cursor);
      if (result.keys.length > 0) await redis.del(result.keys);
    } while (cursor !== '0');
  }
  await redis.del([
    `kb-cache-generation:pages:user:${userId}`,
    `kb-cache-generation:search:user:${userId}`,
  ]);
}

describe.skipIf(!dbAvailable || !redisAvailable)(
  'GET /api/pages filters — real PostgreSQL, Redis, and RBAC',
  () => {
    let app: FastifyInstance;
    let redis: RedisClientType;
    let currentUserId: string;
    const ownedUserIds: string[] = [];

    beforeAll(async () => {
      await setupTestDb();
      redis = createClient({
        url: process.env.REDIS_URL,
        socket: { reconnectStrategy: false, connectTimeout: 1_000 },
      }) as RedisClientType;
      redis.on('error', () => undefined);
      await redis.connect();
      setRedisClient(redis);

      app = await buildKnowledgeTestApp(() => currentUserId, async (instance) => {
        instance.redis = redis;
        await instance.register(pagesCrudRoutes, { prefix: '/api' });
      });
    });

    beforeEach(async () => {
      await truncateAllTables();
      currentUserId = await insertUser(`page-filters-${randomUUID()}`);
      const otherUserId = await insertUser(`page-filters-hidden-${randomUUID()}`);
      ownedUserIds.push(currentUserId, otherUserId);
      await insertLocalSpace('FILTERS', currentUserId);
      await insertLocalSpace('HIDDEN', otherUserId);
      await grantSpaceRead(currentUserId, 'FILTERS');

      await query(
        `INSERT INTO pages (
           source, space_key, title, body_html, body_text, version, labels, author,
           last_modified_at, last_synced, embedding_dirty, embedding_status,
           visibility, created_by_user_id
         ) VALUES
           ('standalone', 'FILTERS', 'Fresh article', '<p>fresh</p>', 'fresh', 1,
            ARRAY['howto', 'architecture'], 'Alice', NOW() - INTERVAL '2 days', NOW(),
            FALSE, 'embedded', 'private', $1),
           ('standalone', 'FILTERS', 'Recent article', '<p>recent</p>', 'recent', 1,
            ARRAY['howto'], 'Bob', NOW() - INTERVAL '15 days', NOW(),
            TRUE, 'not_embedded', 'private', $1),
           ('standalone', 'FILTERS', 'Aging article', '<p>aging</p>', 'aging', 1,
            ARRAY['operations'], 'Alice', NOW() - INTERVAL '60 days', NOW(),
            FALSE, 'embedded', 'private', $1),
           ('standalone', 'FILTERS', 'Dated stale article', '<p>stale</p>', 'stale', 1,
            ARRAY['legacy'], 'Carol', '2025-06-15T12:00:00Z', NOW(),
            TRUE, 'not_embedded', 'private', $1),
           ('standalone', 'HIDDEN', 'Hidden article', '<p>hidden</p>', 'hidden', 1,
            ARRAY['secret'], 'Hidden author', NOW(), NOW(),
            FALSE, 'embedded', 'private', $2)`,
        [currentUserId, otherUserId],
      );
    });

    afterAll(async () => {
      if (app) await app.close();
      setRedisClient(null);
      if (redis?.isOpen) {
        for (const userId of ownedUserIds) await removeUserRedisState(redis, userId);
        await redis.quit();
      }
      await truncateAllTables();
      await teardownTestDb();
    });

    it('returns only pages by the requested author', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/pages?author=Alice' });

      expect(response.statusCode).toBe(200);
      expect(response.json().items.map((item: { title: string }) => item.title)).toEqual([
        'Aging article',
        'Fresh article',
      ]);
    });

    it('requires every requested label', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/pages?labels=howto,architecture',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ total: 1 });
      expect(response.json().items[0].title).toBe('Fresh article');
    });

    it('returns the page inside an inclusive date range', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/pages?dateFrom=2025-06-01&dateTo=2025-06-30',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().items.map((item: { title: string }) => item.title)).toEqual([
        'Dated stale article',
      ]);
    });

    it('places pages in the fresh, recent, aging, and stale buckets', async () => {
      const expected = {
        fresh: 'Fresh article',
        recent: 'Recent article',
        aging: 'Aging article',
        stale: 'Dated stale article',
      } as const;

      for (const [freshness, title] of Object.entries(expected)) {
        const response = await app.inject({
          method: 'GET',
          url: `/api/pages?freshness=${freshness}`,
        });
        expect(response.statusCode).toBe(200);
        expect(response.json().items.map((item: { title: string }) => item.title)).toEqual([title]);
      }
    });

    it('separates pending and completed embedding work', async () => {
      const pending = await app.inject({
        method: 'GET',
        url: '/api/pages?embeddingStatus=pending',
      });
      const done = await app.inject({
        method: 'GET',
        url: '/api/pages?embeddingStatus=done',
      });

      expect(pending.statusCode).toBe(200);
      expect(pending.json().items.map((item: { title: string }) => item.title)).toEqual([
        'Dated stale article',
        'Recent article',
      ]);
      expect(done.statusCode).toBe(200);
      expect(done.json().items.map((item: { title: string }) => item.title)).toEqual([
        'Aging article',
        'Fresh article',
      ]);
    });

    it('applies author, label, and embedding filters together', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/pages?author=Alice&labels=howto,architecture&embeddingStatus=done',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().items.map((item: { title: string }) => item.title)).toEqual([
        'Fresh article',
      ]);
    });

    it('returns sorted author and label choices from RBAC-accessible spaces', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/pages/filters' });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        authors: ['Alice', 'Bob', 'Carol'],
        labels: ['architecture', 'howto', 'legacy', 'operations'],
      });
    });

    it('rejects unsupported freshness and embedding statuses', async () => {
      const freshness = await app.inject({
        method: 'GET',
        url: '/api/pages?freshness=invalid',
      });
      const embedding = await app.inject({
        method: 'GET',
        url: '/api/pages?embeddingStatus=invalid',
      });

      expect(freshness.statusCode).toBe(400);
      expect(embedding.statusCode).toBe(400);
    });
  },
);
