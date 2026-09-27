/**
 * Integration coverage for the ILIKE fallback under `sort=relevance` (#862).
 *
 * The stored tsvector contains the lexeme `confluence`, so
 * `plainto_tsquery('confl')` misses while `%confl%` still matches. The original
 * regression left the relevance ORDER BY bind slot behind when switching to
 * the fallback query and PostgreSQL rejected the request.
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
import { buildKnowledgeTestApp, insertUser } from './pages.test-helpers.js';

const available = await isDbAvailable() && await isRedisAvailable();

async function deleteKeys(redis: RedisClientType, pattern: string): Promise<void> {
  let cursor = '0';
  do {
    const scanned = await redis.scan(cursor, { MATCH: pattern, COUNT: 100 });
    cursor = String(scanned.cursor);
    if (scanned.keys.length > 0) await redis.del(scanned.keys);
  } while (cursor !== '0');
}

describe.skipIf(!available)('GET /api/pages relevance ILIKE fallback (#862)', () => {
  let app: FastifyInstance;
  let redis: RedisClientType;
  let userId: string;
  const ownedUserIds = new Set<string>();

  beforeAll(async () => {
    await setupTestDb();
    redis = createClient({
      url: process.env.REDIS_URL,
      socket: { reconnectStrategy: false, connectTimeout: 1_000 },
    });
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
    for (const ownedUserId of ownedUserIds) {
      await deleteKeys(redis, `kb:${ownedUserId}:*`);
      await redis.del([
        `kb-cache-generation:pages:user:${ownedUserId}`,
        `kb-cache-generation:search:user:${ownedUserId}`,
        `rbac:admin:${ownedUserId}`,
        `rbac:spaces:${ownedUserId}`,
      ]);
    }
    setRedisClient(null);
    if (redis.isOpen) await redis.quit();
    await teardownTestDb();
  });

  beforeEach(async () => {
    await truncateAllTables();
    userId = await insertUser(`relevance-fallback-${randomUUID()}`);
    ownedUserIds.add(userId);

    await query(
      `INSERT INTO spaces (space_key, space_name, source, last_synced)
       VALUES ('DEV', 'Development', 'confluence', NOW())`,
    );
    await query(
      `WITH reader_role AS (
         INSERT INTO roles (name, display_name, permissions)
         VALUES ($1, 'Fallback reader', ARRAY['read'])
         RETURNING id
       )
       INSERT INTO space_role_assignments (space_key, principal_type, principal_id, role_id)
       SELECT 'DEV', 'user', $2, id FROM reader_role`,
      [`fallback-reader-${randomUUID()}`, userId],
    );

    await query(
      `INSERT INTO pages (confluence_id, source, space_key, title, body_text,
                          body_storage, body_html, inherit_perms)
       VALUES ('rel-1', 'confluence', 'DEV', 'Confluence Guide', 'confluence guide',
               '', '', TRUE)`,
    );
  });

  it('returns the fuzzy match instead of 500 when FTS misses under relevance sorting', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/pages?search=confl&sort=relevance',
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      fuzzyMatch: true,
      items: [{ title: 'Confluence Guide' }],
    });
  });

  it('keeps the same fuzzy fallback behavior under non-relevance sorting', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/pages?search=confl&sort=title',
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      fuzzyMatch: true,
      items: [{ title: 'Confluence Guide' }],
    });
  });
});
