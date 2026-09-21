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
import { pinnedPagesRoutes } from './pinned-pages.js';
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
     VALUES ('pinned-pages-reader', 'Pinned pages reader', FALSE, ARRAY['read'])
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

async function pinCount(userId: string, pageId?: number): Promise<number> {
  const result = pageId === undefined
    ? await query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM pinned_pages WHERE user_id = $1',
      [userId],
    )
    : await query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM pinned_pages WHERE user_id = $1 AND page_id = $2',
      [userId, pageId],
    );
  return Number(result.rows[0]!.count);
}

async function useStandaloneMode(userId: string): Promise<void> {
  await query(
    `INSERT INTO user_settings (user_id, confluence_enabled)
     VALUES ($1, FALSE)
     ON CONFLICT (user_id) DO UPDATE SET confluence_enabled = FALSE`,
    [userId],
  );
}

describe.skipIf(!dbAvailable || !redisAvailable)(
  'Pinned Pages API — real PostgreSQL and Redis',
  () => {
    beforeAll(async () => {
      originalAttachmentsDir = process.env.ATTACHMENTS_DIR;
      attachmentsDir = await mkdtemp(join(tmpdir(), 'pinned-pages-'));
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
        await instance.register(pinnedPagesRoutes, { prefix: '/api' });
        // Hard-delete coverage below reaches attachment cleanup, whose root is
        // captured on import; load CRUD only after installing the sandbox.
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
      currentUserId = await insertUser(`pinner-${randomUUID()}`);
      otherUserId = await insertUser(`other-pinner-${randomUUID()}`);
      await insertLocalSpace('LOCAL', currentUserId);
      await query(
        `INSERT INTO spaces (space_key, space_name, source)
         VALUES ('DEV', 'DEV', 'confluence'), ('HR', 'HR', 'confluence')`,
      );
    });

    it('returns only the caller’s live pins with integer page ids and a 200-character excerpt', async () => {
      const mine = await insertStandalonePage('Getting Started', 'shared', currentUserId, 'LOCAL');
      const theirs = await insertStandalonePage('Other article', 'shared', otherUserId, 'LOCAL');
      const hidden = await insertStandalonePage('Trashed article', 'shared', currentUserId, 'LOCAL');
      await query(
        `UPDATE pages
            SET author = 'Alice', body_text = $2, last_modified_at = NOW()
          WHERE id = $1`,
        [mine, 'A'.repeat(500)],
      );
      await query('UPDATE pages SET deleted_at = NOW() WHERE id = $1', [hidden]);
      await query(
        `INSERT INTO pinned_pages (user_id, page_id, pin_order)
         VALUES ($1, $2, 1), ($1, $3, 2), ($4, $5, 1)`,
        [currentUserId, mine, hidden, otherUserId, theirs],
      );

      const response = await app.inject({ method: 'GET', url: '/api/pages/pinned' });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        total: 1,
        items: [{
          id: String(mine),
          title: 'Getting Started',
          spaceKey: 'LOCAL',
          author: 'Alice',
          excerpt: 'A'.repeat(200),
        }],
      });
    });

    it('pins accessible standalone pages idempotently and persists one row', async () => {
      const shared = await insertStandalonePage('Shared', 'shared', otherUserId, 'LOCAL');
      const ownedPrivate = await insertStandalonePage('Mine', 'private', currentUserId, 'LOCAL');

      for (const pageId of [shared, ownedPrivate]) {
        const first = await app.inject({ method: 'POST', url: `/api/pages/${pageId}/pin` });
        const second = await app.inject({ method: 'POST', url: `/api/pages/${pageId}/pin` });
        expect(first.statusCode, first.body).toBe(200);
        expect(second.statusCode, second.body).toBe(200);
        expect(await pinCount(currentUserId, pageId)).toBe(1);
      }
    });

    it('returns 404 without creating a pin for a missing, soft-deleted, or foreign private page', async () => {
      const foreignPrivate = await insertStandalonePage('Private', 'private', otherUserId, 'LOCAL');
      const deleted = await insertStandalonePage(
        'Deleted',
        'shared',
        currentUserId,
        'LOCAL',
        { deletedAt: new Date() },
      );

      for (const pageId of [999_999, deleted, foreignPrivate]) {
        const response = await app.inject({ method: 'POST', url: `/api/pages/${pageId}/pin` });
        expect(response.statusCode).toBe(404);
      }
      expect(await pinCount(currentUserId)).toBe(0);
    });

    it('enforces real space membership for Confluence pins and preserves the admin bypass', async () => {
      const devPage = await insertConfluencePage('pin-dev', 'DEV page', 'DEV');
      const hrPage = await insertConfluencePage('pin-hr', 'HR page', 'HR');
      await grantSpace(currentUserId, 'DEV');

      const allowed = await app.inject({ method: 'POST', url: `/api/pages/${devPage}/pin` });
      const denied = await app.inject({ method: 'POST', url: `/api/pages/${hrPage}/pin` });

      expect(allowed.statusCode, allowed.body).toBe(200);
      expect(denied.statusCode).toBe(404);
      expect(await pinCount(currentUserId, devPage)).toBe(1);
      expect(await pinCount(currentUserId, hrPage)).toBe(0);

      currentUserId = await insertUser(`pin-admin-${randomUUID()}`);
      await query("UPDATE users SET role = 'admin' WHERE id = $1", [currentUserId]);
      const adminResponse = await app.inject({ method: 'POST', url: `/api/pages/${hrPage}/pin` });
      expect(adminResponse.statusCode, adminResponse.body).toBe(200);
      expect(await pinCount(currentUserId, hrPage)).toBe(1);
    });

    it('rejects non-numeric ids without touching persistence', async () => {
      const pin = await app.inject({ method: 'POST', url: '/api/pages/not-a-number/pin' });
      const unpin = await app.inject({ method: 'DELETE', url: '/api/pages/not-a-number/pin' });

      expect(pin.statusCode).toBe(400);
      expect(unpin.statusCode).toBe(400);
      expect(await pinCount(currentUserId)).toBe(0);
    });

    it('unpins only the caller’s row and reports a missing pin', async () => {
      const pageId = await insertStandalonePage('Shared', 'shared', currentUserId, 'LOCAL');
      await query(
        `INSERT INTO pinned_pages (user_id, page_id)
         VALUES ($1, $3), ($2, $3)`,
        [currentUserId, otherUserId, pageId],
      );

      const response = await app.inject({ method: 'DELETE', url: `/api/pages/${pageId}/pin` });
      const repeated = await app.inject({ method: 'DELETE', url: `/api/pages/${pageId}/pin` });

      expect(response.statusCode, response.body).toBe(200);
      expect(repeated.statusCode).toBe(404);
      expect(await pinCount(currentUserId, pageId)).toBe(0);
      expect(await pinCount(otherUserId, pageId)).toBe(1);
    });

    it('removes every user’s pins when a standalone page is permanently deleted', async () => {
      const pageId = await insertStandalonePage('Permanent', 'shared', currentUserId, 'LOCAL');
      await query(
        `INSERT INTO pinned_pages (user_id, page_id)
         VALUES ($1, $3), ($2, $3)`,
        [currentUserId, otherUserId, pageId],
      );

      const response = await app.inject({
        method: 'DELETE',
        url: `/api/pages/${pageId}?permanent=true`,
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(await pinCount(currentUserId, pageId)).toBe(0);
      expect(await pinCount(otherUserId, pageId)).toBe(0);
      const page = await query('SELECT 1 FROM pages WHERE id = $1', [pageId]);
      expect(page.rowCount).toBe(0);
    });

    it('removes persisted pins with a locally committed Confluence delete', async () => {
      await grantSpace(currentUserId, 'DEV');
      await useStandaloneMode(currentUserId);
      const pageId = await insertConfluencePage('pinned-delete', 'Pinned synced page', 'DEV');
      await query('INSERT INTO pinned_pages (user_id, page_id) VALUES ($1, $2)', [currentUserId, pageId]);

      const response = await app.inject({ method: 'DELETE', url: '/api/pages/pinned-delete' });

      expect(response.statusCode, response.body).toBe(200);
      expect(await pinCount(currentUserId, pageId)).toBe(0);
      const page = await query('SELECT 1 FROM pages WHERE id = $1', [pageId]);
      expect(page.rowCount).toBe(0);
    });
  },
);
