import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient, type RedisClientType } from 'redis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
import {
  buildKnowledgeTestApp,
  insertConfluencePage,
  insertLocalSpace,
  insertStandalonePage,
  insertUser,
} from './pages.test-helpers.js';

const [dbAvailable, redisAvailable] = await Promise.all([isDbAvailable(), isRedisAvailable()]);

let app: FastifyInstance;
let redis: RedisClientType;
let currentUserId: string;
let otherUserId: string;
let attachmentsDir: string;
let originalAttachmentsDir: string | undefined;

async function grantSpace(userId: string, spaceKey: string): Promise<void> {
  const role = await query<{ id: number }>(
    `INSERT INTO roles (name, display_name, is_system, permissions)
     VALUES ('delete-route-reader', 'Delete route reader', FALSE, ARRAY['read', 'delete'])
     ON CONFLICT (name) DO UPDATE SET permissions = EXCLUDED.permissions
     RETURNING id`,
  );
  await query(
    `INSERT INTO space_role_assignments (space_key, principal_type, principal_id, role_id)
     VALUES ($1, 'user', $2, $3)
     ON CONFLICT (space_key, principal_type, principal_id)
     DO UPDATE SET role_id = EXCLUDED.role_id`,
    [spaceKey, userId, role.rows[0]!.id],
  );
}

async function useStandaloneMode(userId: string): Promise<void> {
  await query(
    `INSERT INTO user_settings (user_id, confluence_enabled)
     VALUES ($1, FALSE)
     ON CONFLICT (user_id) DO UPDATE SET confluence_enabled = FALSE`,
    [userId],
  );
}

async function pageState(pageId: number): Promise<{ deleted_at: Date | null } | null> {
  const result = await query<{ deleted_at: Date | null }>(
    'SELECT deleted_at FROM pages WHERE id = $1',
    [pageId],
  );
  return result.rows[0] ?? null;
}

describe.skipIf(!dbAvailable || !redisAvailable)(
  'DELETE /api/pages/:id authorization and cache scope — real PostgreSQL and Redis',
  () => {
    beforeAll(async () => {
      originalAttachmentsDir = process.env.ATTACHMENTS_DIR;
      attachmentsDir = await mkdtemp(join(tmpdir(), 'pages-delete-rbac-'));
      process.env.ATTACHMENTS_DIR = attachmentsDir;
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
        // attachment-store captures ATTACHMENTS_DIR at module load, so the
        // CRUD route is intentionally loaded only after the sandbox is set.
        const { pagesCrudRoutes } = await import('./pages-crud.js');
        await instance.register(pagesCrudRoutes, { prefix: '/api' });
      });
    });

    afterAll(async () => {
      await app.close();
      setRedisClient(null as unknown as RedisClientType);
      if (redis.isOpen) await redis.quit();
      await teardownTestDb();
      await rm(attachmentsDir, { recursive: true, force: true });
      if (originalAttachmentsDir === undefined) delete process.env.ATTACHMENTS_DIR;
      else process.env.ATTACHMENTS_DIR = originalAttachmentsDir;
    });

    beforeEach(async () => {
      await truncateAllTables();
      await redis.flushDb();
      currentUserId = await insertUser(`delete-rbac-${randomUUID()}`);
      otherUserId = await insertUser(`delete-rbac-other-${randomUUID()}`);
      await insertLocalSpace('LOCAL', currentUserId);
      await query(
        `INSERT INTO spaces (space_key, space_name, source)
         VALUES ('DEV', 'DEV', 'confluence'), ('HR', 'HR', 'confluence')`,
      );
      await useStandaloneMode(currentUserId);
    });

    it('refuses a Confluence page outside the caller’s assigned spaces without changing persistence', async () => {
      await grantSpace(currentUserId, 'DEV');
      const pageId = await insertConfluencePage('hr-100', 'HR policy', 'HR');

      const response = await app.inject({ method: 'DELETE', url: '/api/pages/hr-100' });

      expect(response.statusCode).toBe(403);
      expect(await pageState(pageId)).toEqual({ deleted_at: null });
      const intents = await query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM page_write_intents WHERE page_ids @> $1::integer[]',
        [[pageId]],
      );
      expect(intents.rows[0]!.count).toBe('0');
    });

    it('allows a space member to remove a Confluence page locally while integration is off', async () => {
      await grantSpace(currentUserId, 'DEV');
      const pageId = await insertConfluencePage('dev-100', 'DEV page', 'DEV');

      const response = await app.inject({ method: 'DELETE', url: '/api/pages/dev-100' });

      expect(response.statusCode, response.body).toBe(200);
      expect(await pageState(pageId)).toBeNull();
    });

    it('allows a system administrator without an explicit assignment to remove a page in a known space', async () => {
      currentUserId = await insertUser(`delete-admin-${randomUUID()}`);
      await query("UPDATE users SET role = 'admin' WHERE id = $1", [currentUserId]);
      await useStandaloneMode(currentUserId);
      const pageId = await insertConfluencePage('admin-100', 'Admin page', 'HR');

      const response = await app.inject({ method: 'DELETE', url: `/api/pages/${pageId}` });

      expect(response.statusCode, response.body).toBe(200);
      expect(await pageState(pageId)).toBeNull();
    });

    it('refuses a Confluence row without a space that could establish current authority', async () => {
      const pageId = await insertConfluencePage('orphan-100', 'No space', 'DEV');
      await query('UPDATE pages SET space_key = NULL WHERE id = $1', [pageId]);

      const response = await app.inject({ method: 'DELETE', url: '/api/pages/orphan-100' });

      expect(response.statusCode).toBe(403);
      expect(await pageState(pageId)).toEqual({ deleted_at: null });
      expect((await query(
        'SELECT 1 FROM page_write_intents WHERE page_ids @> $1::integer[]',
        [[pageId]],
      )).rowCount).toBe(0);
    });

    it('lets the standalone owner trash the page and refuses another user', async () => {
      const owned = await insertStandalonePage('Owned', 'private', currentUserId, 'LOCAL');
      const foreign = await insertStandalonePage('Foreign', 'private', otherUserId, 'LOCAL');

      const ownedResponse = await app.inject({ method: 'DELETE', url: `/api/pages/${owned}` });
      const foreignResponse = await app.inject({ method: 'DELETE', url: `/api/pages/${foreign}` });

      expect(ownedResponse.statusCode, ownedResponse.body).toBe(200);
      expect((await pageState(owned))?.deleted_at).toBeInstanceOf(Date);
      expect(foreignResponse.statusCode).toBe(403);
      expect(await pageState(foreign)).toEqual({ deleted_at: null });
    });

    it('invalidates every user’s page cache when a cascade trashes a shared descendant', async () => {
      const parent = await insertStandalonePage('Private parent', 'private', currentUserId, 'LOCAL');
      const child = await insertStandalonePage(
        'Shared child',
        'shared',
        currentUserId,
        'LOCAL',
        { parentId: String(parent) },
      );
      await redis.mSet({
        [`kb:${currentUserId}:pages:list`]: 'owner-pages',
        [`kb:${otherUserId}:pages:list`]: 'other-pages',
        [`kb:${otherUserId}:spaces:list`]: 'other-spaces',
      });

      const response = await app.inject({ method: 'DELETE', url: `/api/pages/${parent}` });

      expect(response.statusCode, response.body).toBe(200);
      expect((await pageState(parent))?.deleted_at).toBeInstanceOf(Date);
      expect((await pageState(child))?.deleted_at).toBeInstanceOf(Date);
      expect(await redis.get(`kb:${currentUserId}:pages:list`)).toBeNull();
      expect(await redis.get(`kb:${otherUserId}:pages:list`)).toBeNull();
      expect(await redis.get(`kb:${otherUserId}:spaces:list`)).toBe('other-spaces');
    });

    it('keeps another user’s cache when a cascade changes private pages only', async () => {
      const pageId = await insertStandalonePage('Private', 'private', currentUserId, 'LOCAL');
      await redis.mSet({
        [`kb:${currentUserId}:pages:list`]: 'owner-pages',
        [`kb:${otherUserId}:pages:list`]: 'other-pages',
      });

      const response = await app.inject({ method: 'DELETE', url: `/api/pages/${pageId}` });

      expect(response.statusCode, response.body).toBe(200);
      expect(await redis.get(`kb:${currentUserId}:pages:list`)).toBeNull();
      expect(await redis.get(`kb:${otherUserId}:pages:list`)).toBe('other-pages');
    });
  },
);
