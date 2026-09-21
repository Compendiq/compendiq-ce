/**
 * GET /api/pages/trash contract + standalone auto-purge — REAL PostgreSQL.
 *
 * Regression (UX review, trash contract repair): the Trash UI renders
 * `deletedBy` and `autoPurgeAt` per item and promises "purged after 30 days",
 * but the backend returned neither field and nothing ever purged soft-deleted
 * standalone pages (the only purge was Confluence-sync-scoped). Contract:
 *   - each trash item carries `deletedBy` (owner's username — owner == deleter
 *     for standalone articles) and `autoPurgeAt` (= deleted_at + 30 days, ISO);
 *   - `purgeExpiredStandalonePages()` hard-deletes standalone pages
 *     soft-deleted more than 30 days ago, leaves newer trash and Confluence
 *     pages alone, and returns the purged count.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createClient, type RedisClientType } from 'redis';
import type { FastifyInstance } from 'fastify';
import {
  setupTestDb,
  truncateAllTables,
  teardownTestDb,
  isDbAvailable,
} from '../../test-db-helper.js';
import { isRedisAvailable } from '../../test-redis-helper.js';
import { query } from '../../core/db/postgres.js';
import { setRedisClient } from '../../core/services/redis-cache.js';
import { pagesCrudRoutes } from './pages-crud.js';
import { TrashListResponseSchema } from '@compendiq/contracts';
import {
  insertUser,
  insertLocalSpace,
  insertStandalonePage,
  insertConfluencePage,
  buildKnowledgeTestApp,
} from './pages.test-helpers.js';

const available = await isDbAvailable() && await isRedisAvailable();

async function grantRead(userId: string, spaceKey: string): Promise<void> {
  const role = await query<{ id: number }>(
    `INSERT INTO roles (name, display_name, is_system, permissions)
     VALUES ('trash-reader', 'Trash reader', FALSE, ARRAY['read'])
     ON CONFLICT (name) DO UPDATE SET permissions = EXCLUDED.permissions
     RETURNING id`,
  );
  await query(
    `INSERT INTO space_role_assignments (space_key, principal_type, principal_id, role_id)
     VALUES ($1, 'user', $2, $3)`,
    [spaceKey, userId, role.rows[0]!.id],
  );
}

async function seedPageCache(redis: RedisClientType, userIds: readonly string[]): Promise<void> {
  await Promise.all(userIds.map((userId) => redis.set(`kb:${userId}:pages:sentinel`, userId)));
}

async function cachedPageUsers(redis: RedisClientType, userIds: readonly string[]): Promise<string[]> {
  const values = await Promise.all(
    userIds.map(async (userId) => [userId, await redis.get(`kb:${userId}:pages:sentinel`)] as const),
  );
  return values.filter(([, value]) => value !== null).map(([userId]) => userId);
}

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (days: number): Date => new Date(Date.now() - days * DAY_MS);

// --- Tests ---

describe.skipIf(!available)('GET /api/pages/trash + standalone auto-purge (DB)', () => {
  let app: FastifyInstance;
  let redis: RedisClientType;
  let userA: string;
  let currentUserId: string;

  beforeAll(async () => {
    await setupTestDb();
    redis = createClient({
      url: process.env.REDIS_URL,
      socket: { reconnectStrategy: false, connectTimeout: 1_000 },
    }) as RedisClientType;
    await redis.connect();
    setRedisClient(redis);
    app = await buildKnowledgeTestApp(() => currentUserId, async (instance) => {
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
    userA = await insertUser('trash_owner_a');
    await insertLocalSpace('NOTES', userA);
    await query(
      `INSERT INTO spaces (space_key, space_name, source, last_synced)
       VALUES ('DEV', 'DEV', 'confluence', NOW())`,
    );
    await grantRead(userA, 'DEV');
    currentUserId = userA;
  });

  it('returns deletedBy (owner username) and autoPurgeAt (= deletedAt + 30 days, ISO) per item', async () => {
    const oldDeletedAt = daysAgo(31);
    const newDeletedAt = new Date();
    await insertStandalonePage('Old trashed note', 'private', userA, 'NOTES', { deletedAt: oldDeletedAt });
    await insertStandalonePage('Fresh trashed note', 'private', userA, 'NOTES', { deletedAt: newDeletedAt });

    currentUserId = userA;
    const response = await app.inject({ method: 'GET', url: '/api/pages/trash' });
    expect(response.statusCode).toBe(200);

    // Wire contract: the body must satisfy the shared schema exactly
    // (string id, ISO-string dates, enum source/visibility).
    const body = TrashListResponseSchema.parse(response.json());
    expect(body.total).toBe(2);

    // Ordered by deleted_at DESC → freshest first
    expect(body.items.map((i) => i.title)).toEqual(['Fresh trashed note', 'Old trashed note']);

    for (const [item, deletedAt] of [
      [body.items[0]!, newDeletedAt],
      [body.items[1]!, oldDeletedAt],
    ] as const) {
      expect(item.deletedBy).toBe('trash_owner_a');
      expect(item.deletedAt).toBe(deletedAt.toISOString());
      expect(item.autoPurgeAt).toBe(new Date(deletedAt.getTime() + 30 * DAY_MS).toISOString());
      // Existing fields stay on the wire
      expect(item.source).toBe('standalone');
      expect(item.visibility).toBe('private');
    }
  });

  it('purges standalone pages trashed >30 days ago, keeps fresh trash, returns the count', async () => {
    const expiredId = await insertStandalonePage('Expired trash', 'private', userA, 'NOTES', {
      deletedAt: daysAgo(31),
    });
    const freshId = await insertStandalonePage('Fresh trash', 'private', userA, 'NOTES', {
      deletedAt: new Date(),
    });
    const liveId = await insertStandalonePage('Live note', 'private', userA, 'NOTES');
    // Soft-deleted Confluence page older than the window — must NOT be touched
    // (its purge is Confluence-sync-scoped with upstream re-confirmation).
    const confluenceId = await insertConfluencePage('conf-trashed', 'Conf trashed', 'DEV', {
      deletedAt: daysAgo(45),
    });
    // FK-cascade check: a pin on the expired page must not block the purge.
    await query('INSERT INTO pinned_pages (user_id, page_id) VALUES ($1, $2)', [userA, expiredId]);

    const { purgeExpiredStandalonePages } = await import(
      '../../core/services/data-retention-service.js'
    );
    const purged = await purgeExpiredStandalonePages();
    expect(purged).toBe(1);

    const remaining = await query<{ id: number }>('SELECT id FROM pages ORDER BY id');
    expect(remaining.rows.map((r) => r.id)).toEqual(
      [freshId, liveId, confluenceId].sort((a, b) => a - b),
    );

    const pins = await query('SELECT page_id FROM pinned_pages');
    expect(pins.rows).toEqual([]);

    // Second run finds nothing — count is per-run, not cumulative.
    expect(await purgeExpiredStandalonePages()).toBe(0);
  });

  describe('POST /api/pages/:id/restore — observable cache scope (#893)', () => {
    it('invalidates every user’s pages cache when restoring a shared page', async () => {
      const reader = await insertUser('trash_shared_reader');
      const pageId = await insertStandalonePage('Shared trashed note', 'shared', userA, 'NOTES', {
        deletedAt: new Date(),
      });
      await seedPageCache(redis, [userA, reader]);

      const response = await app.inject({ method: 'POST', url: `/api/pages/${pageId}/restore` });

      expect(response.statusCode).toBe(200);
      expect(response.json().restored).toBe(true);
      expect(await cachedPageUsers(redis, [userA, reader])).toEqual([]);
    });

    it('returns 409 instead of 500 when restoring would collide with a live Notion import', async () => {
      const trashedId = await insertStandalonePage('Old Notion copy', 'private', userA, 'NOTES', {
        deletedAt: new Date(),
      });
      const liveId = await insertStandalonePage('Live Notion copy', 'private', userA, 'NOTES');
      await query(`UPDATE pages SET notion_page_id = 'notion-1' WHERE id = ANY($1::int[])`, [
        [trashedId, liveId],
      ]);

      currentUserId = userA;
      const response = await app.inject({ method: 'POST', url: `/api/pages/${trashedId}/restore` });
      expect(response.statusCode).toBe(409);
      expect(String(response.json().error ?? response.json().message ?? '')).toMatch(/live import/i);
      const stillTrashed = await query<{ deleted_at: Date | null }>(
        'SELECT deleted_at FROM pages WHERE id = $1',
        [trashedId],
      );
      expect(stillTrashed.rows[0]!.deleted_at).not.toBeNull();
    });

    it('keeps other users’ cache entries when restoring a private page', async () => {
      const reader = await insertUser('trash_private_reader');
      const pageId = await insertStandalonePage('Private trashed note', 'private', userA, 'NOTES', {
        deletedAt: new Date(),
      });
      await seedPageCache(redis, [userA, reader]);

      const response = await app.inject({ method: 'POST', url: `/api/pages/${pageId}/restore` });

      expect(response.statusCode).toBe(200);
      expect(response.json().restored).toBe(true);
      expect(await cachedPageUsers(redis, [userA, reader])).toEqual([reader]);
    });
  });

  // Nested here to reuse the real-DB app bootstrap + seeders (this file is
  // the pagesCrudRoutes-against-real-Postgres harness).
  describe('GET /api/pages/:id — createdByUserId exposure', () => {
    it('exposes createdByUserId for a standalone page so the UI can detect own pages', async () => {
      const pageId = await insertStandalonePage('My own note', 'private', userA, 'NOTES');

      currentUserId = userA;
      const response = await app.inject({ method: 'GET', url: `/api/pages/${pageId}` });
      expect(response.statusCode).toBe(200);

      const body = response.json() as { source: string; createdByUserId: string | null };
      expect(body.source).toBe('standalone');
      expect(body.createdByUserId).toBe(userA);
    });

    it('returns null createdByUserId for a synced Confluence page', async () => {
      const pageId = await insertConfluencePage('conf-own-1', 'Conf page', 'DEV');
      currentUserId = userA;
      const response = await app.inject({ method: 'GET', url: `/api/pages/${pageId}` });
      expect(response.statusCode).toBe(200);

      const body = response.json() as { source: string; createdByUserId: string | null };
      expect(body.source).toBe('confluence');
      expect(body.createdByUserId).toBeNull();
    });
  });
});
