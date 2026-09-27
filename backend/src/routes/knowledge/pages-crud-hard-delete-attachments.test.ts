import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
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
import { PAGE_ICON_STORE_DIRNAME } from '../../core/services/page-icon-store.js';
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

function localDir(pageId: number): string {
  return join(attachmentsDir, 'local', String(pageId));
}

function cacheDir(key: string | number): string {
  return join(attachmentsDir, String(key));
}

function iconDir(pageId: number): string {
  return join(attachmentsDir, PAGE_ICON_STORE_DIRNAME, String(pageId));
}

async function seedFile(directory: string, filename: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, filename), Buffer.from(`bytes:${filename}`));
}

async function ageDirectory(directory: string): Promise<void> {
  const old = new Date(Date.now() - 60 * 60 * 1000);
  await utimes(directory, old, old);
}

async function exists(pathname: string): Promise<boolean> {
  try {
    await access(pathname);
    return true;
  } catch {
    return false;
  }
}

async function useStandaloneMode(userId: string): Promise<void> {
  await query(
    `INSERT INTO user_settings (user_id, confluence_enabled)
     VALUES ($1, FALSE)
     ON CONFLICT (user_id) DO UPDATE SET confluence_enabled = FALSE`,
    [userId],
  );
}

async function grantSpace(userId: string, spaceKey: string): Promise<void> {
  const role = await query<{ id: number }>(
    `INSERT INTO roles (name, display_name, is_system, permissions)
     VALUES ('attachment-delete-reader', 'Attachment delete reader', FALSE, ARRAY['read', 'delete'])
     ON CONFLICT (name) DO UPDATE SET permissions = EXCLUDED.permissions
     RETURNING id`,
  );
  await query(
    `INSERT INTO space_role_assignments (space_key, principal_type, principal_id, role_id)
     VALUES ($1, 'user', $2, $3)`,
    [spaceKey, userId, role.rows[0]!.id],
  );
}

async function pageExists(pageId: number): Promise<boolean> {
  const result = await query('SELECT 1 FROM pages WHERE id = $1', [pageId]);
  return result.rowCount === 1;
}

describe.skipIf(!dbAvailable || !redisAvailable)(
  'hard-delete attachment cleanup — real PostgreSQL, Redis, and files',
  () => {
    beforeAll(async () => {
      await setupTestDb();
      redis = createClient({
        url: process.env.REDIS_URL,
        socket: { reconnectStrategy: false, connectTimeout: 1_000 },
      });
      redis.on('error', () => undefined);
      await redis.connect();
      setRedisClient(redis);
      originalAttachmentsDir = process.env.ATTACHMENTS_DIR;
      attachmentsDir = await mkdtemp(join(tmpdir(), 'pages-hard-delete-'));
      process.env.ATTACHMENTS_DIR = attachmentsDir;
      app = await buildKnowledgeTestApp(() => currentUserId, async (instance) => {
        instance.redis = redis;
        // The Confluence attachment writer historically captured ATTACHMENTS_DIR
        // at module load, so the route must load only after the sandbox is set.
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
      await rm(attachmentsDir, { recursive: true, force: true });
      await mkdir(attachmentsDir, { recursive: true });
      currentUserId = await insertUser(`attachment-delete-${randomUUID()}`);
      otherUserId = await insertUser(`attachment-survivor-${randomUUID()}`);
      await insertLocalSpace('LOCAL', currentUserId);
    });

    it('removes every attachment and icon namespace owned by rows a permanent cascade actually destroyed', async () => {
      const root = await insertStandalonePage('Root', 'private', currentUserId, 'LOCAL');
      const foreignIntermediate = await insertStandalonePage(
        'Foreign survivor',
        'private',
        otherUserId,
        'LOCAL',
        { parentId: String(root) },
      );
      const ownedGrandchild = await insertStandalonePage(
        'Owned grandchild',
        'private',
        currentUserId,
        'LOCAL',
        { parentId: String(foreignIntermediate) },
      );

      for (const pageId of [root, foreignIntermediate, ownedGrandchild]) {
        await seedFile(localDir(pageId), 'local.png');
        await seedFile(cacheDir(pageId), 'cached.png');
        await ageDirectory(cacheDir(pageId));
        await seedFile(iconDir(pageId), 'mark.png');
      }

      const response = await app.inject({
        method: 'DELETE',
        url: `/api/pages/${root}?permanent=true`,
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(await pageExists(root)).toBe(false);
      expect(await pageExists(ownedGrandchild)).toBe(false);
      expect(await pageExists(foreignIntermediate)).toBe(true);
      for (const pageId of [root, ownedGrandchild]) {
        expect(await exists(localDir(pageId))).toBe(false);
        expect(await exists(cacheDir(pageId))).toBe(false);
        expect(await exists(iconDir(pageId))).toBe(false);
      }
      expect(await exists(join(localDir(foreignIntermediate), 'local.png'))).toBe(true);
      expect(await exists(join(cacheDir(foreignIntermediate), 'cached.png'))).toBe(true);
      expect(await exists(join(iconDir(foreignIntermediate), 'mark.png'))).toBe(true);
    });

    it('leaves all files in place for a soft delete because the page remains restorable', async () => {
      const pageId = await insertStandalonePage('Restorable', 'private', currentUserId, 'LOCAL');
      await seedFile(localDir(pageId), 'local.png');
      await seedFile(cacheDir(pageId), 'cached.png');
      await ageDirectory(cacheDir(pageId));
      await seedFile(iconDir(pageId), 'mark.png');

      const response = await app.inject({ method: 'DELETE', url: `/api/pages/${pageId}` });

      expect(response.statusCode, response.body).toBe(200);
      const row = await query<{ deleted_at: Date | null }>(
        'SELECT deleted_at FROM pages WHERE id = $1',
        [pageId],
      );
      expect(row.rows[0]!.deleted_at).toBeInstanceOf(Date);
      expect(await exists(join(localDir(pageId), 'local.png'))).toBe(true);
      expect(await exists(join(cacheDir(pageId), 'cached.png'))).toBe(true);
      expect(await exists(join(iconDir(pageId), 'mark.png'))).toBe(true);
    });

    it('removes a locally deleted Confluence page’s cache and page-icon namespace after the row commits', async () => {
      await query(
        `INSERT INTO spaces (space_key, space_name, source)
         VALUES ('DEV', 'DEV', 'confluence')`,
      );
      await grantSpace(currentUserId, 'DEV');
      await useStandaloneMode(currentUserId);
      const pageId = await insertConfluencePage('conf-files-1', 'Confluence files', 'DEV');
      await seedFile(cacheDir('conf-files-1'), 'remote.png');
      await seedFile(iconDir(pageId), 'mark.png');

      const response = await app.inject({ method: 'DELETE', url: '/api/pages/conf-files-1' });

      expect(response.statusCode, response.body).toBe(200);
      expect(await pageExists(pageId)).toBe(false);
      expect(await exists(cacheDir('conf-files-1'))).toBe(false);
      expect(await exists(iconDir(pageId))).toBe(false);
    });
  },
);
