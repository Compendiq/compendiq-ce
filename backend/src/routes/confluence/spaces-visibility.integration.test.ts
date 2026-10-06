import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { createClient, type RedisClientType } from 'redis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { query } from '../../core/db/postgres.js';
import { invalidateRbacCache } from '../../core/services/rbac-service.js';
import { RedisCache, setRedisClient } from '../../core/services/redis-cache.js';
import {
  isDbAvailable,
  setupTestDb,
  teardownTestDb,
  truncateAllTables,
} from '../../test-db-helper.js';
import { isRedisAvailable } from '../../test-redis-helper.js';
import {
  buildKnowledgeTestApp,
  insertLocalSpace,
  insertStandalonePage,
  insertUser,
} from '../knowledge/pages.test-helpers.js';
import { spacesRoutes } from './spaces.js';

const [dbAvailable, redisAvailable] = await Promise.all([
  isDbAvailable(),
  isRedisAvailable(),
]);

async function grantSpaceRead(userId: string, spaceKey: string): Promise<void> {
  const role = await query<{ id: number }>(
    `INSERT INTO roles (name, display_name, permissions)
     VALUES ($1, 'Space visibility reader', ARRAY['read'])
     RETURNING id`,
    [`space-visibility-${randomUUID()}`],
  );
  await query(
    `INSERT INTO space_role_assignments (space_key, principal_type, principal_id, role_id)
     VALUES ($1, 'user', $2, $3)`,
    [spaceKey, userId, role.rows[0]!.id],
  );
}

describe.skipIf(!dbAvailable || !redisAvailable)(
  'GET /api/spaces — caller-bound page metadata',
  () => {
    let app: FastifyInstance;
    let redis: RedisClientType;
    let currentUserId: string;
    let ownerId: string;
    let readerId: string;

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
        await instance.register(spacesRoutes, { prefix: '/api' });
      });
    });

    beforeEach(async () => {
      await truncateAllTables();
      ownerId = await insertUser(`spaces-owner-${randomUUID()}`);
      readerId = await insertUser(`spaces-reader-${randomUUID()}`);
      currentUserId = readerId;
      await insertLocalSpace('TEAM', ownerId);
      await grantSpaceRead(ownerId, 'TEAM');
      await grantSpaceRead(readerId, 'TEAM');
      await redis.del([
        `kb:${ownerId}:spaces:list`,
        `kb:${readerId}:spaces:list`,
        `rbac:spaces:${ownerId}`,
        `rbac:spaces:${readerId}`,
        `rbac:admin:${ownerId}`,
        `rbac:admin:${readerId}`,
      ]);
    });

    afterAll(async () => {
      if (app) await app.close();
      setRedisClient(null);
      if (redis?.isOpen) await redis.quit();
      await truncateAllTables();
      await teardownTestDb();
    });

    it('removes another user’s private page from counts and home ids without replaying a stale list', async () => {
      const pageId = await insertStandalonePage('Team home', 'shared', ownerId, 'TEAM');
      await query(
        'UPDATE spaces SET homepage_id = $2, custom_home_page_id = $3 WHERE space_key = $1',
        ['TEAM', String(pageId), pageId],
      );

      const shared = await app.inject({ method: 'GET', url: '/api/spaces' });
      expect(shared.statusCode, shared.body).toBe(200);
      expect(shared.json()).toEqual([
        expect.objectContaining({
          key: 'TEAM',
          pageCount: 1,
          homepageId: String(pageId),
          customHomePageId: pageId,
        }),
      ]);

      await query("UPDATE pages SET visibility = 'private' WHERE id = $1", [pageId]);
      await new RedisCache(redis).invalidateAcrossUsers('pages');

      const privateToReader = await app.inject({ method: 'GET', url: '/api/spaces' });
      expect(privateToReader.statusCode, privateToReader.body).toBe(200);
      expect(privateToReader.json()).toEqual([
        expect.objectContaining({
          key: 'TEAM',
          pageCount: 0,
          homepageId: null,
          customHomePageId: null,
        }),
      ]);

      currentUserId = ownerId;
      const owner = await app.inject({ method: 'GET', url: '/api/spaces' });
      expect(owner.statusCode, owner.body).toBe(200);
      expect(owner.json()).toEqual([
        expect.objectContaining({
          key: 'TEAM',
          pageCount: 1,
          homepageId: String(pageId),
          customHomePageId: pageId,
        }),
      ]);

      await query("UPDATE users SET role = 'admin' WHERE id = $1", [readerId]);
      await invalidateRbacCache(readerId);
      await redis.del(`kb:${readerId}:spaces:list`);
      currentUserId = readerId;
      const admin = await app.inject({ method: 'GET', url: '/api/spaces' });
      expect(admin.statusCode, admin.body).toBe(200);
      expect(admin.json()).toEqual([
        expect.objectContaining({
          key: 'TEAM',
          pageCount: 0,
          homepageId: null,
          customHomePageId: null,
        }),
      ]);
    });
  },
);
