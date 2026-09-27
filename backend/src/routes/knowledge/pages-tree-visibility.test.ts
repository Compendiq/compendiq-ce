/**
 * GET /api/pages/tree — visibility predicate against real PostgreSQL, Redis,
 * and RBAC state.
 *
 * Regression: the tree route filtered only by space + `deleted_at IS NULL`,
 * so another user's private standalone article appeared in the sidebar tree
 * while the detail route refused to serve it. The tree must apply the same
 * visibility predicate as the list route.
 */
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
  insertConfluencePage,
  insertLocalSpace,
  insertStandalonePage,
  insertUser,
} from './pages.test-helpers.js';

const available = await isDbAvailable() && await isRedisAvailable();

async function assignReadableSpace(userId: string, spaceKey: string): Promise<void> {
  await query(
    `WITH reader_role AS (
       INSERT INTO roles (name, display_name, permissions)
       VALUES ($1, 'Tree visibility reader', ARRAY['read'])
       RETURNING id
     )
     INSERT INTO space_role_assignments (space_key, principal_type, principal_id, role_id)
     SELECT $2, 'user', $3, id FROM reader_role`,
    [`tree-reader-${randomUUID()}`, spaceKey, userId],
  );
}

async function deleteKeys(redis: RedisClientType, pattern: string): Promise<void> {
  let cursor = '0';
  do {
    const scanned = await redis.scan(cursor, { MATCH: pattern, COUNT: 100 });
    cursor = String(scanned.cursor);
    if (scanned.keys.length > 0) await redis.del(scanned.keys);
  } while (cursor !== '0');
}

describe.skipIf(!available)('GET /api/pages/tree — real visibility boundaries', () => {
  let app: FastifyInstance;
  let redis: RedisClientType;
  let userA: string;
  let userB: string;
  let currentUserId: string;
  const ownedUserIds = new Set<string>();

  async function treeTitles(asUser: string, url = '/api/pages/tree'): Promise<string[]> {
    currentUserId = asUser;
    const response = await app.inject({ method: 'GET', url });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json<{ items: Array<{ title: string }> }>();
    return body.items.map((item) => item.title).sort();
  }

  beforeAll(async () => {
    await setupTestDb();
    redis = createClient({
      url: process.env.REDIS_URL,
      socket: { reconnectStrategy: false, connectTimeout: 1_000 },
    });
    redis.on('error', () => undefined);
    await redis.connect();
    setRedisClient(redis);

    app = await buildKnowledgeTestApp(() => currentUserId, async (instance) => {
      instance.redis = redis;
      await instance.register(pagesCrudRoutes, { prefix: '/api' });
    });
  });

  afterAll(async () => {
    await app.close();
    for (const userId of ownedUserIds) {
      await deleteKeys(redis, `kb:${userId}:*`);
      await redis.del([
        `kb-cache-generation:pages:user:${userId}`,
        `kb-cache-generation:search:user:${userId}`,
        `rbac:admin:${userId}`,
        `rbac:spaces:${userId}`,
      ]);
    }
    setRedisClient(null);
    if (redis.isOpen) await redis.quit();
    await teardownTestDb();
  });

  beforeEach(async () => {
    await truncateAllTables();
    userA = await insertUser(`tree-vis-a-${randomUUID()}`);
    userB = await insertUser(`tree-vis-b-${randomUUID()}`);
    ownedUserIds.add(userA);
    ownedUserIds.add(userB);
    currentUserId = userA;

    await insertLocalSpace('NOTES', userA);
    await query(
      `INSERT INTO spaces (space_key, space_name, source, last_synced)
       VALUES ('DEV', 'Development', 'confluence', NOW()),
              ('SECRET', 'Secret', 'confluence', NOW())`,
    );
  });

  it("hides another user's private standalone article while retaining shared content", async () => {
    await insertStandalonePage('Private note', 'private', userA, 'NOTES');
    await insertStandalonePage('Shared note', 'shared', userA, 'NOTES');

    expect(await treeTitles(userB)).toEqual(['Shared note']);
  });

  it('shows the owner both their private and shared standalone articles', async () => {
    await insertStandalonePage('Private note', 'private', userA, 'NOTES');
    await insertStandalonePage('Shared note', 'shared', userA, 'NOTES');

    expect(await treeTitles(userA)).toEqual(['Private note', 'Shared note']);
  });

  it('limits Confluence pages to spaces assigned through real RBAC state', async () => {
    await insertConfluencePage('conf-dev', 'Dev page', 'DEV');
    await insertConfluencePage('conf-secret', 'Secret page', 'SECRET');
    await assignReadableSpace(userB, 'DEV');

    expect(await treeTitles(userB)).toEqual(['Dev page']);
  });

  it('keeps the space filter on top of the visibility and RBAC predicates', async () => {
    await insertConfluencePage('conf-dev', 'Dev page', 'DEV');
    await insertConfluencePage('conf-secret', 'Secret page', 'SECRET');
    await insertStandalonePage('Private note', 'private', userA, 'NOTES');
    await insertStandalonePage('Shared note', 'shared', userA, 'NOTES');
    await assignReadableSpace(userB, 'DEV');

    expect(await treeTitles(userB, '/api/pages/tree?spaceKey=DEV')).toEqual(['Dev page']);
    expect(await treeTitles(userB, '/api/pages/tree?spaceKey=SECRET')).toEqual([]);
    expect(await treeTitles(userB, '/api/pages/tree?spaceKey=NOTES')).toEqual(['Shared note']);
  });
});
