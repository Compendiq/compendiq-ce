import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient, type RedisClientType } from 'redis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { Doc, encodeStateAsUpdate } from 'yjs';
import {
  isDbAvailable,
  setupTestDb,
  teardownTestDb,
  truncateAllTables,
} from '../../test-db-helper.js';
import { isRedisAvailable } from '../../test-redis-helper.js';
import { getPool, query } from '../../core/db/postgres.js';
import { setRedisClient } from '../../core/services/redis-cache.js';
import { setPageBaselineReadinessProvider } from '../../core/services/page-baseline-governance.js';
import {
  freezePage,
  previewPageBaseline,
  setPageBaselineCreationEnabled,
} from '../../core/services/page-baseline-service.js';
import { lockPageLifecycle } from '../../core/services/page-write-admission.js';
import { encryptPat } from '../../core/utils/crypto.js';
import {
  buildKnowledgeTestApp,
  insertLocalSpace,
  insertStandalonePage,
  insertUser,
} from './pages.test-helpers.js';

const [dbAvailable, redisAvailable] = await Promise.all([isDbAvailable(), isRedisAvailable()]);

type ConfluencePayload = {
  title: string;
  version: { number: number };
  body: { storage: { value: string } };
};

type ConfluenceRequest = { url: string; body: ConfluencePayload };

let app: FastifyInstance;
let redis: RedisClientType;
let confluence: Server;
let confluenceBaseUrl: string;
let currentUserId: string;
let ownerId: string;
let otherUserId: string;
let attachmentsDir: string;
let originalAttachmentsDir: string | undefined;
let confluenceRequests: ConfluenceRequest[] = [];
let remoteVersion = 4;
let compactPutReply = false;
let readbackCount = 0;
let publishedPage: (ConfluencePayload & { id: string }) | null = null;

async function readRequestBody(request: IncomingMessage): Promise<ConfluencePayload> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as ConfluencePayload;
}
async function waitForBlockedLifecycleLock(minimumWaiters = 1): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const waiting = await query<{ waiting: number }>(
      `SELECT COUNT(*)::int AS waiting
         FROM pg_stat_activity
        WHERE datname = current_database()
          AND wait_event_type = 'Lock'
          AND wait_event = 'advisory'
          AND query LIKE '%pg_advisory_xact_lock%'`,
    );
    if ((waiting.rows[0]?.waiting ?? 0) >= minimumWaiters) return;
  }
  throw new Error('stale draft writer did not reach the lifecycle lock barrier');
}



async function seedStandalone(opts: {
  owner?: string;
  visibility?: 'private' | 'shared';
  title?: string;
  bodyHtml?: string;
  version?: number;
  draftHtml?: string | null;
} = {}): Promise<number> {
  const owner = opts.owner ?? ownerId;
  const pageId = await insertStandalonePage(
    opts.title ?? 'Article',
    opts.visibility ?? 'private',
    owner,
    'LOCAL',
  );
  const bodyHtml = opts.bodyHtml ?? '<p>live content</p>';
  await query(
    `UPDATE pages SET body_html = $2, body_text = 'live content', version = $3,
                      draft_body_html = $4,
                      draft_body_text = CASE WHEN $4::text IS NULL THEN NULL ELSE 'draft content' END,
                      draft_updated_at = CASE WHEN $4::text IS NULL THEN NULL ELSE NOW() END,
                      draft_updated_by = CASE WHEN $4::text IS NULL THEN NULL ELSE $5::uuid END
      WHERE id = $1`,
    [pageId, bodyHtml, opts.version ?? 3, opts.draftHtml ?? null, owner],
  );
  return pageId;
}

async function seedConfluencePage(spaceKey = 'OPS', grant = true): Promise<number> {
  await query(
    `INSERT INTO spaces (space_key, space_name, source, last_synced)
     VALUES ($1, $1, 'confluence', NOW())`,
    [spaceKey],
  );
  if (grant) {
    await query(
      `WITH editor_role AS (
         INSERT INTO roles (name, display_name, permissions)
         VALUES ('draft-editor', 'Draft editor', ARRAY['read', 'write'])
         ON CONFLICT (name) DO UPDATE SET permissions = EXCLUDED.permissions
         RETURNING id
       )
       INSERT INTO space_role_assignments (space_key, principal_type, principal_id, role_id)
       SELECT $2, 'user', $1, id FROM editor_role`,
      [currentUserId, spaceKey],
    );
  }
  const page = await query<{ id: number }>(
    `INSERT INTO pages
       (confluence_id, source, space_key, title, body_html, body_storage, body_text,
        version, visibility, draft_body_html, draft_body_text, draft_updated_at, draft_updated_by)
     VALUES ('conf-123', 'confluence', $1, 'Confluence Article', '<p>live</p>',
             '<p>live storage</p>', 'live', 3, 'shared', '<p>draft</p>', 'draft', NOW(), $2)
     RETURNING id`,
    [spaceKey, currentUserId],
  );
  await query(
    `INSERT INTO user_settings (user_id, confluence_url, confluence_pat, confluence_enabled)
     VALUES ($1, $2, $3, TRUE)`,
    [currentUserId, confluenceBaseUrl, encryptPat('draft-http-test-pat')],
  );
  return page.rows[0]!.id;
}

async function freeze(pageId: number, actorId: string): Promise<void> {
  setPageBaselineReadinessProvider(async () => ({ ready: true, blockers: [] }));
  const admin = await insertUser(`draft-admin-${randomUUID()}`);
  await query("UPDATE users SET role = 'admin' WHERE id = $1", [admin]);
  await setPageBaselineCreationEnabled(admin, true);
  const prepared = await previewPageBaseline(pageId, actorId);
  await freezePage({
    pageId,
    actorId,
    reason: 'Approved draft fixture',
    expectedContentRevision: prepared.contentRevision,
    expectedManifestDigest: prepared.manifestDigest,
    reportedSignatories: [],
  });
}

type StoredPage = {
  title: string;
  body_html: string;
  body_text: string;
  body_storage: string | null;
  version: number;
  draft_body_html: string | null;
  draft_body_text: string | null;
  draft_body_storage: string | null;
  draft_updated_at: Date | null;
  draft_updated_by: string | null;
  embedding_dirty: boolean;
  image_analysis_dirty: boolean;
  local_modified_by: string | null;
  content_revision: string;
};

async function storedPage(pageId: number): Promise<StoredPage> {
  const result = await query<StoredPage>(
    `SELECT title, body_html, body_text, body_storage, version,
            draft_body_html, draft_body_text, draft_body_storage,
            draft_updated_at, draft_updated_by, embedding_dirty,
            image_analysis_dirty, local_modified_by,
            content_revision::text AS content_revision
       FROM pages WHERE id = $1`,
    [pageId],
  );
  return result.rows[0]!;
}

describe.skipIf(!dbAvailable || !redisAvailable)('Draft-while-published routes — real PostgreSQL and Redis', () => {
  beforeAll(async () => {
    await setupTestDb();
    originalAttachmentsDir = process.env.ATTACHMENTS_DIR;
    attachmentsDir = await mkdtemp(join(tmpdir(), 'pages-draft-real-'));
    process.env.ATTACHMENTS_DIR = attachmentsDir;

    confluence = createServer(async (request, response) => {
      if (request.method === 'GET' && request.url?.startsWith('/rest/api/content/conf-123?')) {
        readbackCount += 1;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(publishedPage));
        return;
      }
      if (request.method !== 'PUT' || request.url !== '/rest/api/content/conf-123') {
        response.writeHead(404).end();
        return;
      }
      const body = await readRequestBody(request);
      confluenceRequests.push({ url: request.url, body });
      publishedPage = {
        id: 'conf-123',
        title: body.title,
        version: { number: remoteVersion },
        body: { storage: { value: body.body.storage.value } },
      };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(compactPutReply
        ? { id: publishedPage.id, version: publishedPage.version }
        : publishedPage));
    });
    await new Promise<void>((resolve) => confluence.listen(0, '127.0.0.1', resolve));
    confluenceBaseUrl = `http://127.0.0.1:${(confluence.address() as AddressInfo).port}`;

    redis = createClient({
      url: process.env.REDIS_URL,
      socket: { reconnectStrategy: false, connectTimeout: 1_000 },
    });
    await redis.connect();
    setRedisClient(redis);
    app = await buildKnowledgeTestApp(() => currentUserId, async (instance) => {
      instance.redis = redis;
      // The route graph reads attachment configuration at module load; install
      // the suite sandbox before loading it.
      const { pagesCrudRoutes } = await import('./pages-crud.js');
      await instance.register(pagesCrudRoutes, { prefix: '/api' });
    });
  });

  afterAll(async () => {
    await app.close();
    setPageBaselineReadinessProvider(null);
    if (redis.isOpen) await redis.quit();
    await new Promise<void>((resolve, reject) => confluence.close((error) => error ? reject(error) : resolve()));
    await teardownTestDb();
    await rm(attachmentsDir, { recursive: true, force: true });
    if (originalAttachmentsDir === undefined) delete process.env.ATTACHMENTS_DIR;
    else process.env.ATTACHMENTS_DIR = originalAttachmentsDir;
  });

  beforeEach(async () => {
    await truncateAllTables();
    await redis.flushDb();
    confluenceRequests = [];
    remoteVersion = 4;
    compactPutReply = false;
    readbackCount = 0;
    publishedPage = null;
    ownerId = await insertUser(`draft-owner-${randomUUID()}`);
    otherUserId = await insertUser(`draft-other-${randomUUID()}`);
    currentUserId = ownerId;
    await insertLocalSpace('LOCAL', ownerId);
  });

  describe('save and read', () => {
    it('stores a draft without changing the published content or version', async () => {
      const pageId = await seedStandalone();
      const response = await app.inject({
        method: 'PUT',
        url: `/api/pages/${pageId}/draft`,
        payload: { title: 'Article', bodyHtml: '<p>new <strong>draft</strong></p>' },
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ id: pageId, hasDraft: true });
      expect(await storedPage(pageId)).toMatchObject({
        body_html: '<p>live content</p>',
        body_text: 'live content',
        version: 3,
        draft_body_html: '<p>new <strong>draft</strong></p>',
        draft_body_text: 'new draft',
        draft_updated_by: ownerId,
      });
    });

    it('allows a non-owner to save and read a draft on a shared standalone page', async () => {
      const pageId = await seedStandalone({ visibility: 'shared' });
      currentUserId = otherUserId;
      const saved = await app.inject({
        method: 'PUT',
        url: `/api/pages/${pageId}/draft`,
        payload: { title: 'Article', bodyHtml: '<p>shared draft</p>' },
      });
      expect(saved.statusCode, saved.body).toBe(200);

      const read = await app.inject({ method: 'GET', url: `/api/pages/${pageId}/draft` });
      expect(read.statusCode, read.body).toBe(200);
      expect(read.json()).toMatchObject({
        id: pageId,
        bodyHtml: '<p>shared draft</p>',
        bodyText: 'shared draft',
        updatedBy: otherUserId,
      });
    });

    it('does not expose or overwrite another user’s private draft', async () => {
      const pageId = await seedStandalone({ draftHtml: '<p>secret draft</p>' });
      currentUserId = otherUserId;

      const read = await app.inject({ method: 'GET', url: `/api/pages/${pageId}/draft` });
      expect(read.statusCode).toBe(404);
      const save = await app.inject({
        method: 'PUT',
        url: `/api/pages/${pageId}/draft`,
        payload: { title: 'Article', bodyHtml: '<p>intruder</p>' },
      });
      expect(save.statusCode).toBe(403);
      expect(await storedPage(pageId)).toMatchObject({ draft_body_html: '<p>secret draft</p>' });
    });

    it('returns 404 for missing pages and pages without drafts', async () => {
      const pageId = await seedStandalone();
      expect((await app.inject({ method: 'GET', url: `/api/pages/${pageId}/draft` })).statusCode).toBe(404);
      expect((await app.inject({ method: 'GET', url: '/api/pages/2147483647/draft' })).statusCode).toBe(404);
    });

    it('validates the save payload before persistence', async () => {
      const pageId = await seedStandalone();
      const response = await app.inject({
        method: 'PUT',
        url: `/api/pages/${pageId}/draft`,
        payload: { bodyHtml: '<p>missing title</p>' },
      });
      expect(response.statusCode).toBe(400);
      expect((await storedPage(pageId)).draft_body_html).toBeNull();
    });
  });

  describe('publish', () => {
    it('snapshots the live version, promotes the draft atomically, clears it, and re-queues indexing', async () => {
      const pageId = await seedStandalone({ draftHtml: '<p>draft content</p>' });
      await query('UPDATE pages SET embedding_dirty = FALSE, image_analysis_dirty = FALSE WHERE id = $1', [pageId]);

      const response = await app.inject({ method: 'POST', url: `/api/pages/${pageId}/draft/publish` });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ id: pageId, version: 4, published: true });
      expect(await storedPage(pageId)).toMatchObject({
        body_html: '<p>draft content</p>',
        body_text: 'draft content',
        version: 4,
        draft_body_html: null,
        draft_body_text: null,
        draft_body_storage: null,
        draft_updated_at: null,
        draft_updated_by: null,
        embedding_dirty: true,
        image_analysis_dirty: true,
        local_modified_by: ownerId,
      });
      const history = await query<{ version_number: number; body_html: string }>(
        'SELECT version_number, body_html FROM page_versions WHERE page_id = $1',
        [pageId],
      );
      expect(history.rows).toEqual([{ version_number: 3, body_html: '<p>live content</p>' }]);
    });
    it('refreshes another reader’s cached list after publishing a shared draft', async () => {
      const pageId = await seedStandalone({ visibility: 'shared', draftHtml: '<p>shared draft</p>' });
      await query('UPDATE pages SET embedding_dirty = FALSE WHERE id = $1', [pageId]);
      currentUserId = otherUserId;
      const before = await app.inject({ method: 'GET', url: '/api/pages' });
      const beforeItem = before.json<{
        items: Array<{ id: string; embeddingDirty: boolean }>;
      }>().items.find((item) => item.id === String(pageId));
      expect(beforeItem?.embeddingDirty).toBe(false);

      currentUserId = ownerId;
      const published = await app.inject({ method: 'POST', url: `/api/pages/${pageId}/draft/publish` });
      expect(published.statusCode, published.body).toBe(200);

      currentUserId = otherUserId;
      const after = await app.inject({ method: 'GET', url: '/api/pages' });
      const afterItem = after.json<{
        items: Array<{ id: string; embeddingDirty: boolean }>;
      }>().items.find((item) => item.id === String(pageId));
      expect(afterItem?.embeddingDirty).toBe(true);
    });


    it('returns 400 when no draft exists and 403 for a private non-owner without changing live content', async () => {
      const noDraft = await seedStandalone();
      expect((await app.inject({ method: 'POST', url: `/api/pages/${noDraft}/draft/publish` })).statusCode).toBe(400);

      const privatePage = await seedStandalone({ draftHtml: '<p>private draft</p>' });
      currentUserId = otherUserId;
      const denied = await app.inject({ method: 'POST', url: `/api/pages/${privatePage}/draft/publish` });
      expect(denied.statusCode).toBe(403);
      expect(await storedPage(privatePage)).toMatchObject({
        body_html: '<p>live content</p>', version: 3, draft_body_html: '<p>private draft</p>',
      });
    });

    it('publishes a Confluence draft over real HTTP using the previous live version and persists the returned version', async () => {
      const pageId = await seedConfluencePage();

      const response = await app.inject({ method: 'POST', url: `/api/pages/${pageId}/draft/publish` });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ id: pageId, version: 4, published: true });
      expect(confluenceRequests).toHaveLength(1);
      expect(confluenceRequests[0]!.body).toMatchObject({
        title: 'Confluence Article',
        version: { number: 4 },
      });
      expect(confluenceRequests[0]!.body.body.storage.value).toContain('draft');
      expect(await storedPage(pageId)).toMatchObject({
        body_html: '<p>draft</p>',
        body_storage: expect.stringContaining('draft'),
        version: 4,
        draft_body_html: null,
        local_modified_by: null,
      });
    });

    it('rolls back draft publication when its collaborative snapshot cannot be invalidated', async () => {
      const pageId = await seedConfluencePage();
      const before = await storedPage(pageId);
      const document = new Doc();
      document.getText('draft').insert(0, 'Retained collaboration snapshot');
      const snapshot = Buffer.from(encodeStateAsUpdate(document));
      document.destroy();
      await query(
        'INSERT INTO page_collaborative_docs (page_id, doc_state) VALUES ($1, $2)',
        [pageId, snapshot],
      );
      try {
        await query(`
          CREATE FUNCTION refuse_draft_snapshot_removal() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            RAISE EXCEPTION 'Injected collaboration storage failure';
          END $$;
          CREATE TRIGGER refuse_draft_snapshot_removal
            BEFORE DELETE ON page_collaborative_docs
            FOR EACH ROW EXECUTE FUNCTION refuse_draft_snapshot_removal();
        `);
        const response = await app.inject({ method: 'POST', url: `/api/pages/${pageId}/draft/publish` });
        expect(response.statusCode).toBe(500);
        expect(await storedPage(pageId)).toEqual(before);
        expect((await query('SELECT doc_state FROM page_collaborative_docs WHERE page_id = $1', [pageId])).rows)
          .toEqual([{ doc_state: snapshot }]);
        expect((await query('SELECT id FROM page_write_intents WHERE $1 = ANY(page_ids)', [pageId])).rows)
          .toEqual([]);
        expect((await query('SELECT version_number FROM page_versions WHERE page_id = $1', [pageId])).rows)
          .toEqual([]);
        expect(confluenceRequests).toHaveLength(0);
      } finally {
        await query('DROP TRIGGER IF EXISTS refuse_draft_snapshot_removal ON page_collaborative_docs');
        await query('DROP FUNCTION IF EXISTS refuse_draft_snapshot_removal()');
      }

      const retried = await app.inject({ method: 'POST', url: `/api/pages/${pageId}/draft/publish` });
      expect(retried.statusCode, retried.body).toBe(200);
      expect(confluenceRequests).toHaveLength(1);
      expect((await query('SELECT page_id FROM page_collaborative_docs WHERE page_id = $1', [pageId])).rows)
        .toEqual([]);
    });

    it('confirms a compact provider acknowledgment without sending the draft twice', async () => {
      const pageId = await seedConfluencePage();
      compactPutReply = true;
      const response = await app.inject({ method: 'POST', url: `/api/pages/${pageId}/draft/publish` });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ version: 4, published: true });
      expect(confluenceRequests).toHaveLength(1);
      expect(readbackCount).toBe(1);
      expect(await storedPage(pageId)).toMatchObject({
        body_html: '<p>draft</p>', body_storage: expect.stringContaining('draft'),
        version: 4, draft_body_html: null, local_modified_by: null,
      });
    });

    it('publishes a synced draft locally when Confluence was already disabled', async () => {
      const pageId = await seedConfluencePage();
      await query(
        'UPDATE user_settings SET confluence_enabled = FALSE WHERE user_id = $1',
        [ownerId],
      );

      const response = await app.inject({
        method: 'POST',
        url: `/api/pages/${pageId}/draft/publish`,
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ id: pageId, version: 4, published: true });
      expect(await storedPage(pageId)).toMatchObject({
        body_html: '<p>draft</p>',
        body_storage: '<p>live storage</p>',
        version: 4,
        draft_body_html: null,
        local_modified_by: ownerId,
      });
      expect(confluenceRequests).toHaveLength(0);
      const intents = await query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM page_write_intents`,
      );
      expect(intents.rows[0]!.count).toBe('0');
    });

    it.each([
      {
        change: 'integration mode is disabled',
        mutate: async (client: PoolClient) => {
          await client.query(
            'UPDATE user_settings SET confluence_enabled = FALSE WHERE user_id = $1',
            [ownerId],
          );
        },
        error: 'Confluence integration is disabled',
      },
      {
        change: 'credentials are revoked',
        mutate: async (client: PoolClient) => {
          await client.query(
            `UPDATE user_settings
                SET confluence_url = NULL, confluence_pat = NULL
              WHERE user_id = $1`,
            [ownerId],
          );
        },
        error: 'Confluence credentials changed before the remote write',
      },
    ])(
      'keeps the authorized local publication and settles its undispatched intent when $change',
      async ({ mutate, error }) => {
        const pageId = await seedConfluencePage();
        const blocker = await getPool().connect();
        await blocker.query('BEGIN');
        await lockPageLifecycle(blocker, [pageId]);
        try {
          const pending = app.inject({
            method: 'POST',
            url: `/api/pages/${pageId}/draft/publish`,
          });
          await waitForBlockedLifecycleLock();
          await mutate(blocker);
          await blocker.query('COMMIT');

          const response = await pending;
          expect(response.statusCode, response.body).toBe(409);
          expect(response.json().error).toContain(error);
          expect(await storedPage(pageId)).toMatchObject({
            body_html: '<p>draft</p>',
            body_storage: '<p>live storage</p>',
            version: 4,
            draft_body_html: null,
            local_modified_by: ownerId,
          });
          expect(confluenceRequests).toHaveLength(0);
          const intents = await query<{
            status: string;
            remote_effect_started_at: Date | null;
          }>(
            `SELECT status, remote_effect_started_at
               FROM page_write_intents
              WHERE kind = 'pages.draft.publish.confluence'
                AND $1 = ANY(page_ids)`,
            [pageId],
          );
          expect(intents.rows).toEqual([{
            status: 'cancelled',
            remote_effect_started_at: null,
          }]);
        } catch (caught) {
          await blocker.query('ROLLBACK').catch(() => undefined);
          throw caught;
        } finally {
          blocker.release();
        }
      },
    );

    it('keeps the local publication and settles its undispatched intent when space authority is revoked between phases', async () => {
      const pageId = await seedConfluencePage();
      const blocker = await getPool().connect();
      const interphaseBlocker = await getPool().connect();
      let interphaseLock: Promise<void> | undefined;
      await blocker.query('BEGIN');
      await lockPageLifecycle(blocker, [pageId]);
      try {
        const pending = app.inject({
          method: 'POST',
          url: `/api/pages/${pageId}/draft/publish`,
        });
        await waitForBlockedLifecycleLock();

        await interphaseBlocker.query('BEGIN');
        interphaseLock = lockPageLifecycle(interphaseBlocker, [pageId]);
        await waitForBlockedLifecycleLock(2);
        await blocker.query('COMMIT');
        await interphaseLock;

        expect(await storedPage(pageId)).toMatchObject({
          body_html: '<p>draft</p>',
          body_storage: '<p>live storage</p>',
          version: 4,
          draft_body_html: null,
          local_modified_by: ownerId,
        });
        const pendingIntent = await query<{
          status: string;
          remote_effect_started_at: Date | null;
        }>(
          `SELECT status, remote_effect_started_at
             FROM page_write_intents
            WHERE kind = 'pages.draft.publish.confluence'
              AND $1 = ANY(page_ids)`,
          [pageId],
        );
        expect(pendingIntent.rows).toEqual([{
          status: 'pending',
          remote_effect_started_at: null,
        }]);

        await interphaseBlocker.query(
          `DELETE FROM space_role_assignments
            WHERE principal_type = 'user' AND principal_id = $1 AND space_key = 'OPS'`,
          [ownerId],
        );
        await interphaseBlocker.query('COMMIT');

        const response = await pending;
        expect(response.statusCode, response.body).toBe(403);
        expect(await storedPage(pageId)).toMatchObject({
          body_html: '<p>draft</p>',
          body_storage: '<p>live storage</p>',
          version: 4,
          draft_body_html: null,
          local_modified_by: ownerId,
        });
        expect(confluenceRequests).toHaveLength(0);
        const settledIntent = await query<{
          status: string;
          remote_effect_started_at: Date | null;
        }>(
          `SELECT status, remote_effect_started_at
             FROM page_write_intents
            WHERE kind = 'pages.draft.publish.confluence'
              AND $1 = ANY(page_ids)`,
          [pageId],
        );
        expect(settledIntent.rows).toEqual([{
          status: 'cancelled',
          remote_effect_started_at: null,
        }]);
      } catch (caught) {
        await blocker.query('ROLLBACK').catch(() => undefined);
        await interphaseLock?.catch(() => undefined);
        await interphaseBlocker.query('ROLLBACK').catch(() => undefined);
        throw caught;
      } finally {
        blocker.release();
        interphaseBlocker.release();
      }
    });
  });

  describe('discard and detail', () => {
    it('clears every draft field without changing live content', async () => {
      const pageId = await seedStandalone({ draftHtml: '<p>discard me</p>' });
      const response = await app.inject({ method: 'DELETE', url: `/api/pages/${pageId}/draft` });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ id: pageId, hasDraft: false });
      expect(await storedPage(pageId)).toMatchObject({
        body_html: '<p>live content</p>', version: 3,
        draft_body_html: null, draft_body_text: null, draft_body_storage: null,
        draft_updated_at: null, draft_updated_by: null,
      });
    });

    it('reports draft presence on page detail from persisted state', async () => {
      const withDraft = await seedStandalone({ visibility: 'shared', draftHtml: '<p>draft</p>' });
      const withoutDraft = await seedStandalone({ visibility: 'shared' });
      const present = await app.inject({ method: 'GET', url: `/api/pages/${withDraft}` });
      const absent = await app.inject({ method: 'GET', url: `/api/pages/${withoutDraft}` });
      expect(present.statusCode, present.body).toBe(200);
      expect(present.json()).toMatchObject({ hasDraft: true });
      expect(present.json().draftUpdatedAt).toEqual(expect.any(String));
      expect(absent.statusCode, absent.body).toBe(200);
      expect(absent.json()).toMatchObject({ hasDraft: false, draftUpdatedAt: null });
    });

    it('returns 404 for a missing discard and 403 for a private non-owner', async () => {
      expect((await app.inject({ method: 'DELETE', url: '/api/pages/2147483647/draft' })).statusCode).toBe(404);
      const pageId = await seedStandalone({ draftHtml: '<p>keep</p>' });
      currentUserId = otherUserId;
      expect((await app.inject({ method: 'DELETE', url: `/api/pages/${pageId}/draft` })).statusCode).toBe(403);
      expect((await storedPage(pageId)).draft_body_html).toBe('<p>keep</p>');
    });
  });

  describe('Confluence page space authority', () => {
    it('denies save, read, publish, and discard outside the user’s RBAC spaces without mutating the row or calling Confluence', async () => {
      const pageId = await seedConfluencePage('HR', false);
      const before = await storedPage(pageId);
      const attempts = [
        await app.inject({
          method: 'PUT', url: `/api/pages/${pageId}/draft`,
          payload: { title: 'Denied', bodyHtml: '<p>denied</p>' },
        }),
        await app.inject({ method: 'GET', url: `/api/pages/${pageId}/draft` }),
        await app.inject({ method: 'POST', url: `/api/pages/${pageId}/draft/publish` }),
        await app.inject({ method: 'DELETE', url: `/api/pages/${pageId}/draft` }),
      ];

      expect(attempts.map((response) => response.statusCode)).toEqual([403, 404, 403, 403]);
      expect(await storedPage(pageId)).toMatchObject(before);
      expect(confluenceRequests).toHaveLength(0);
    });

    it('treats a Confluence page with no space key as inaccessible', async () => {
      const pageId = await seedConfluencePage();
      await query('UPDATE pages SET space_key = NULL WHERE id = $1', [pageId]);
      const response = await app.inject({
        method: 'PUT', url: `/api/pages/${pageId}/draft`,
        payload: { title: 'Denied', bodyHtml: '<p>denied</p>' },
      });
      expect(response.statusCode).toBe(403);
    });
  });

  describe('authority recheck after lifecycle admission', () => {
    it.each([
      { operation: 'save' },
      { operation: 'publish' },
      { operation: 'discard' },
    ] as const)(
      'rejects a stale shared-page $operation after the owner makes the page private',
      async ({ operation }) => {
        const pageId = await seedStandalone({
          visibility: 'shared',
          draftHtml: '<p>retained draft</p>',
        });
        currentUserId = otherUserId;
        const before = await storedPage(pageId);

        const blocker = await getPool().connect();
        await blocker.query('BEGIN');
        await lockPageLifecycle(blocker, [pageId]);
        try {
          const pending = operation === 'save'
            ? app.inject({
                method: 'PUT',
                url: `/api/pages/${pageId}/draft`,
                payload: { title: 'Article', bodyHtml: '<p>stale replacement</p>' },
              })
            : operation === 'publish'
              ? app.inject({ method: 'POST', url: `/api/pages/${pageId}/draft/publish` })
              : app.inject({ method: 'DELETE', url: `/api/pages/${pageId}/draft` });

          await waitForBlockedLifecycleLock();
          await blocker.query("UPDATE pages SET visibility = 'private' WHERE id = $1", [pageId]);
          await blocker.query('COMMIT');

          const response = await pending;
          expect(response.statusCode).toBe(403);
          expect(await storedPage(pageId)).toMatchObject({
            body_html: before.body_html,
            version: before.version,
            draft_body_html: before.draft_body_html,
            draft_updated_by: before.draft_updated_by,
            content_revision: before.content_revision,
          });
          expect(confluenceRequests).toHaveLength(0);
        } catch (error) {
          await blocker.query('ROLLBACK').catch(() => undefined);
          throw error;
        } finally {
          blocker.release();
        }
      },
    );
  });

  it('uses real frozen lifecycle state to deny save, publish, and discard while retaining the draft and live version', async () => {
    const pageId = await seedStandalone({ draftHtml: '<p>retained draft</p>' });
    await freeze(pageId, ownerId);
    const before = await storedPage(pageId);

    const save = await app.inject({
      method: 'PUT', url: `/api/pages/${pageId}/draft`,
      payload: { title: 'Article', bodyHtml: '<p>new draft</p>' },
    });
    const publish = await app.inject({ method: 'POST', url: `/api/pages/${pageId}/draft/publish` });
    const discard = await app.inject({ method: 'DELETE', url: `/api/pages/${pageId}/draft` });

    expect([save.statusCode, publish.statusCode, discard.statusCode]).toEqual([423, 423, 423]);
    expect(await storedPage(pageId)).toMatchObject({
      body_html: before.body_html,
      version: before.version,
      draft_body_html: before.draft_body_html,
      content_revision: before.content_revision,
    });
  });
});
