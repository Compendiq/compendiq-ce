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
import { setPageBaselineReadinessProvider } from '../../core/services/page-baseline-governance.js';
import {
  freezePage,
  previewPageBaseline,
  setPageBaselineCreationEnabled,
} from '../../core/services/page-baseline-service.js';
import {
  buildKnowledgeTestApp,
  insertLocalSpace,
  insertStandalonePage,
  insertUser,
} from './pages.test-helpers.js';

const [dbAvailable, redisAvailable] = await Promise.all([isDbAvailable(), isRedisAvailable()]);

let app: FastifyInstance;
let redis: RedisClientType;
let currentUserId: string;
let attachmentsDir: string;
let originalAttachmentsDir: string | undefined;

async function seedFolder(ownerId = currentUserId, visibility: 'private' | 'shared' = 'private'): Promise<number> {
  const pageId = await insertStandalonePage('Folder', visibility, ownerId, 'LOCAL');
  await query(
    `UPDATE pages SET page_type = 'folder', body_html = '', body_text = '', body_storage = NULL,
                      embedding_dirty = FALSE, image_analysis_dirty = FALSE
      WHERE id = $1`,
    [pageId],
  );
  return pageId;
}

async function freeze(pageId: number, actorId: string): Promise<void> {
  setPageBaselineReadinessProvider(async () => ({ ready: true, blockers: [] }));
  const admin = await insertUser(`folder-admin-${randomUUID()}`);
  await query("UPDATE users SET role = 'admin' WHERE id = $1", [admin]);
  await setPageBaselineCreationEnabled(admin, true);
  const prepared = await previewPageBaseline(pageId, actorId);
  await freezePage({
    pageId,
    actorId,
    reason: 'Approved folder fixture',
    expectedContentRevision: prepared.contentRevision,
    expectedManifestDigest: prepared.manifestDigest,
    reportedSignatories: [],
  });
}

type StoredFolder = {
  title: string;
  page_type: string;
  body_html: string;
  body_text: string;
  body_storage: string | null;
  version: number;
  embedding_dirty: boolean;
  image_analysis_dirty: boolean;
  content_revision: string;
};

async function folderRow(pageId: number): Promise<StoredFolder> {
  const result = await query<StoredFolder>(
    `SELECT title, page_type, body_html, body_text, body_storage, version,
            embedding_dirty, image_analysis_dirty, content_revision::text AS content_revision
       FROM pages WHERE id = $1`,
    [pageId],
  );
  return result.rows[0]!;
}

describe.skipIf(!dbAvailable || !redisAvailable)('Folder pages (#414) — real PostgreSQL and Redis', () => {
  beforeAll(async () => {
    await setupTestDb();
    originalAttachmentsDir = process.env.ATTACHMENTS_DIR;
    attachmentsDir = await mkdtemp(join(tmpdir(), 'folder-pages-real-'));
    process.env.ATTACHMENTS_DIR = attachmentsDir;
    redis = createClient({
      url: process.env.REDIS_URL,
      socket: { reconnectStrategy: false, connectTimeout: 1_000 },
    });
    await redis.connect();
    setRedisClient(redis);
    app = await buildKnowledgeTestApp(() => currentUserId, async (instance) => {
      instance.redis = redis;
      // pages-crud's attachment dependencies read ATTACHMENTS_DIR at module
      // load, so the route is intentionally loaded after the sandbox exists.
      const { pagesCrudRoutes } = await import('./pages-crud.js');
      await instance.register(pagesCrudRoutes, { prefix: '/api' });
    });
  });

  afterAll(async () => {
    await app.close();
    setPageBaselineReadinessProvider(null);
    if (redis.isOpen) await redis.quit();
    await teardownTestDb();
    await rm(attachmentsDir, { recursive: true, force: true });
    if (originalAttachmentsDir === undefined) delete process.env.ATTACHMENTS_DIR;
    else process.env.ATTACHMENTS_DIR = originalAttachmentsDir;
  });

  beforeEach(async () => {
    await truncateAllTables();
    await redis.flushDb();
    currentUserId = await insertUser(`folder-owner-${randomUUID()}`);
    await insertLocalSpace('LOCAL', currentUserId);
  });

  describe('POST /api/pages', () => {
    it('creates a folder as an empty, non-indexable container', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/pages',
        payload: {
          spaceKey: 'LOCAL',
          title: 'My Folder',
          bodyHtml: '<p>must not be retained</p>',
          pageType: 'folder',
          source: 'standalone',
          visibility: 'private',
        },
      });

      expect(response.statusCode, response.body).toBe(200);
      const body = response.json<{ id: number; pageType: string; source: string }>();
      expect(body).toMatchObject({ pageType: 'folder', source: 'standalone' });
      expect(await folderRow(body.id)).toMatchObject({
        title: 'My Folder',
        page_type: 'folder',
        body_html: '',
        body_text: '',
        body_storage: null,
        version: 1,
        embedding_dirty: false,
        image_analysis_dirty: false,
      });
    });

    it('defaults an omitted pageType to an ordinary page with its content retained', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/pages',
        payload: {
          spaceKey: 'LOCAL',
          title: 'Regular Page',
          bodyHtml: '<p>Content here</p>',
          source: 'standalone',
          visibility: 'private',
        },
      });

      expect(response.statusCode, response.body).toBe(200);
      const body = response.json<{ id: number; pageType: string }>();
      expect(body.pageType).toBe('page');
      expect(await folderRow(body.id)).toMatchObject({
        page_type: 'page', body_html: '<p>Content here</p>', body_text: 'Content here',
        embedding_dirty: true, image_analysis_dirty: true,
      });
    });

    it('rejects an empty title before creating a row', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/pages',
        payload: { title: '', bodyHtml: '', pageType: 'folder', source: 'standalone' },
      });
      expect(response.statusCode).toBe(400);
      const count = await query<{ count: string }>('SELECT COUNT(*)::text AS count FROM pages');
      expect(count.rows[0]!.count).toBe('0');
    });
  });

  describe('PUT /api/pages/:id', () => {
    it('rejects body content on a folder without changing its title or version', async () => {
      const pageId = await seedFolder();
      const before = await folderRow(pageId);
      const response = await app.inject({
        method: 'PUT',
        url: `/api/pages/${pageId}`,
        payload: { title: 'Renamed', bodyHtml: '<p>folders cannot contain content</p>', version: 1 },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json<{ error: string }>().error).toContain('Folder pages cannot have body content');
      expect(await folderRow(pageId)).toMatchObject(before);
    });

    it('allows a title-only folder update through real lifecycle admission', async () => {
      const pageId = await seedFolder();
      const response = await app.inject({
        method: 'PUT',
        url: `/api/pages/${pageId}`,
        payload: { title: 'Renamed Folder', bodyHtml: '', version: 1 },
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ id: pageId, title: 'Renamed Folder', version: 2 });
      expect(await folderRow(pageId)).toMatchObject({
        title: 'Renamed Folder', page_type: 'folder', body_html: '', body_text: '', version: 2,
      });
    });

    it('rechecks real page authority and denies a private folder update by a non-owner', async () => {
      const ownerId = currentUserId;
      const pageId = await seedFolder(ownerId);
      currentUserId = await insertUser(`folder-intruder-${randomUUID()}`);
      const response = await app.inject({
        method: 'PUT',
        url: `/api/pages/${pageId}`,
        payload: { title: 'Taken Folder', bodyHtml: '', version: 1 },
      });

      expect(response.statusCode).toBe(403);
      expect(await folderRow(pageId)).toMatchObject({ title: 'Folder', version: 1 });
    });

    it('rejects a stale folder version without changing the container', async () => {
      const pageId = await seedFolder();
      await query('UPDATE pages SET version = 4 WHERE id = $1', [pageId]);
      const response = await app.inject({
        method: 'PUT',
        url: `/api/pages/${pageId}`,
        payload: { title: 'Stale Folder', bodyHtml: '', version: 3 },
      });

      expect(response.statusCode).toBe(409);
      expect(await folderRow(pageId)).toMatchObject({ title: 'Folder', version: 4 });
    });

    it('uses a real frozen baseline to deny a title change and preserve revision state', async () => {
      const pageId = await seedFolder();
      await freeze(pageId, currentUserId);
      const before = await folderRow(pageId);
      const response = await app.inject({
        method: 'PUT',
        url: `/api/pages/${pageId}`,
        payload: { title: 'Frozen Rename', bodyHtml: '', version: 1 },
      });

      expect(response.statusCode).toBe(423);
      expect(await folderRow(pageId)).toMatchObject({
        title: before.title,
        version: before.version,
        body_html: before.body_html,
        content_revision: before.content_revision,
      });
    });
  });

  it('returns folder type and empty content from page detail', async () => {
    const pageId = await seedFolder(currentUserId, 'shared');
    const response = await app.inject({ method: 'GET', url: `/api/pages/${pageId}` });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      id: String(pageId), title: 'Folder', pageType: 'folder', bodyHtml: '', bodyText: '', source: 'standalone',
    });
  });

  it('includes folder and page types with their persisted hierarchy in the tree', async () => {
    const folderId = await seedFolder(currentUserId, 'shared');
    const childId = await insertStandalonePage('Child Page', 'shared', currentUserId, 'LOCAL', {
      parentId: String(folderId),
    });

    const response = await app.inject({ method: 'GET', url: '/api/pages/tree' });
    expect(response.statusCode, response.body).toBe(200);
    const items = response.json<{ items: Array<{ id: string; pageType: string; parentId: string | null }> }>().items;
    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: String(folderId), pageType: 'folder', parentId: null }),
      expect.objectContaining({ id: String(childId), pageType: 'page', parentId: String(folderId) }),
    ]));
  });
});
