import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { createClient, type RedisClientType } from 'redis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { query } from '../../core/db/postgres.js';
import { RedisCache, setRedisClient } from '../../core/services/redis-cache.js';
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

type PageSeed = {
  author?: string;
  labels?: string[];
  modifiedAt?: string;
  bodyText?: string;
};

async function insertPrivatePage(
  ownerId: string,
  title: string,
  seed: PageSeed = {},
): Promise<number> {
  const result = await query<{ id: number }>(
    `INSERT INTO pages (
       source, space_key, title, body_html, body_text, labels, author,
       last_modified_at, last_synced, visibility, created_by_user_id,
       embedding_dirty, embedding_status
     ) VALUES (
       'standalone', 'CACHE', $1, '<p>cache fixture</p>', $2, $3, $4,
       $5::timestamptz, NOW(), 'private', $6, FALSE, 'embedded'
     ) RETURNING id`,
    [
      title,
      seed.bodyText ?? title,
      seed.labels ?? [],
      seed.author ?? null,
      seed.modifiedAt ?? '2026-01-01T00:00:00Z',
      ownerId,
    ],
  );
  return result.rows[0]!.id;
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
  'GET /api/pages cache behavior — real PostgreSQL and Redis',
  () => {
    let app: FastifyInstance;
    let redis: RedisClientType;
    let currentUserId: string;
    let firstUserId: string;
    let secondUserId: string;
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
      firstUserId = await insertUser(`pages-cache-first-${randomUUID()}`);
      secondUserId = await insertUser(`pages-cache-second-${randomUUID()}`);
      ownedUserIds.push(firstUserId, secondUserId);
      currentUserId = firstUserId;
      await insertLocalSpace('CACHE', firstUserId);
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

    it('replays a cached list until its real namespace is invalidated', async () => {
      const pageId = await insertPrivatePage(firstUserId, 'Before database change', {
        author: 'Cache author',
      });
      const url = '/api/pages?author=Cache%20author';

      const initial = await app.inject({ method: 'GET', url });
      expect(initial.statusCode).toBe(200);
      expect(initial.json().items[0].title).toBe('Before database change');

      await query('UPDATE pages SET title = $1 WHERE id = $2', ['After database change', pageId]);

      const replay = await app.inject({ method: 'GET', url });
      expect(replay.statusCode).toBe(200);
      expect(replay.json().items[0].title).toBe('Before database change');

      await new RedisCache(redis).invalidate(firstUserId, 'pages');
      const refreshed = await app.inject({ method: 'GET', url });
      expect(refreshed.statusCode).toBe(200);
      expect(refreshed.json().items[0].title).toBe('After database change');
    });

    it('keeps author and label filter results isolated when both are replayed', async () => {
      await insertPrivatePage(firstUserId, 'Alice article', {
        author: 'Alice',
        labels: ['red'],
      });
      await insertPrivatePage(firstUserId, 'Blue article', {
        author: 'Bob',
        labels: ['blue'],
      });

      const alice = await app.inject({ method: 'GET', url: '/api/pages?author=Alice' });
      const blue = await app.inject({ method: 'GET', url: '/api/pages?labels=blue' });
      const aliceReplay = await app.inject({ method: 'GET', url: '/api/pages?author=Alice' });
      const blueReplay = await app.inject({ method: 'GET', url: '/api/pages?labels=blue' });

      expect(alice.statusCode).toBe(200);
      expect(alice.json().items.map((item: { title: string }) => item.title)).toEqual(['Alice article']);
      expect(blue.statusCode).toBe(200);
      expect(blue.json().items.map((item: { title: string }) => item.title)).toEqual(['Blue article']);
      expect(aliceReplay.json()).toEqual(alice.json());
      expect(blueReplay.json()).toEqual(blue.json());
    });

    it('keeps pagination and sort variants isolated when they are replayed', async () => {
      await insertPrivatePage(firstUserId, 'Alpha', { modifiedAt: '2025-01-01T00:00:00Z' });
      await insertPrivatePage(firstUserId, 'Bravo', { modifiedAt: '2026-03-01T00:00:00Z' });
      await insertPrivatePage(firstUserId, 'Charlie', { modifiedAt: '2024-01-01T00:00:00Z' });

      const firstPageUrl = '/api/pages?page=1&limit=1&sort=title';
      const secondPageUrl = '/api/pages?page=2&limit=1&sort=title';
      const modifiedUrl = '/api/pages?page=1&limit=1&sort=modified';
      const firstPage = await app.inject({ method: 'GET', url: firstPageUrl });
      const secondPage = await app.inject({ method: 'GET', url: secondPageUrl });
      const modified = await app.inject({ method: 'GET', url: modifiedUrl });

      expect(firstPage.statusCode).toBe(200);
      expect(firstPage.json()).toMatchObject({ total: 3, page: 1, limit: 1, totalPages: 3 });
      expect(firstPage.json().items[0].title).toBe('Alpha');
      expect(secondPage.json().items[0].title).toBe('Bravo');
      expect(modified.json().items[0].title).toBe('Bravo');

      expect((await app.inject({ method: 'GET', url: firstPageUrl })).json()).toEqual(firstPage.json());
      expect((await app.inject({ method: 'GET', url: secondPageUrl })).json()).toEqual(secondPage.json());
      expect((await app.inject({ method: 'GET', url: modifiedUrl })).json()).toEqual(modified.json());
    });

    it('never replays one authenticated user private list to another user', async () => {
      await insertPrivatePage(firstUserId, 'First user private');
      await insertPrivatePage(secondUserId, 'Second user private');

      currentUserId = firstUserId;
      const first = await app.inject({ method: 'GET', url: '/api/pages' });
      currentUserId = secondUserId;
      const second = await app.inject({ method: 'GET', url: '/api/pages' });

      expect(first.statusCode).toBe(200);
      expect(first.json().items.map((item: { title: string }) => item.title)).toEqual([
        'First user private',
      ]);
      expect(second.statusCode).toBe(200);
      expect(second.json().items.map((item: { title: string }) => item.title)).toEqual([
        'Second user private',
      ]);
      expect((await app.inject({ method: 'GET', url: '/api/pages' })).json()).toEqual(second.json());
    });

    it('treats percent and underscore as literals in fallback search', async () => {
      await insertPrivatePage(firstUserId, 'xxneedle%markyy');
      await insertPrivatePage(firstUserId, 'xxneedleZZmarkyy');
      await insertPrivatePage(firstUserId, 'xxneedle_varmarkyy');
      await insertPrivatePage(firstUserId, 'xxneedleXvarmarkyy');

      const percent = await app.inject({
        method: 'GET',
        url: `/api/pages?search=${encodeURIComponent('needle%mark')}`,
      });
      const underscore = await app.inject({
        method: 'GET',
        url: `/api/pages?search=${encodeURIComponent('needle_var')}`,
      });

      expect(percent.statusCode).toBe(200);
      expect(percent.json()).toMatchObject({ fuzzyMatch: true, total: 1 });
      expect(percent.json().items[0].title).toBe('xxneedle%markyy');
      expect(underscore.statusCode).toBe(200);
      expect(underscore.json()).toMatchObject({ fuzzyMatch: true, total: 1 });
      expect(underscore.json().items[0].title).toBe('xxneedle_varmarkyy');
    });
  },
);
