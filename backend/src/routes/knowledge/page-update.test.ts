import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient, type RedisClientType } from 'redis';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  isDbAvailable,
  setupTestDb,
  teardownTestDb,
  truncateAllTables,
  waitForDatabaseCondition,
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
import { lockPageLifecycle, reconcilePageWriteIntent, withPageWriteTransaction } from '../../core/services/page-write-admission.js';
import { registerOrdinaryPageWriteReconcilers } from '../../domains/confluence/services/ordinary-page-write-reconciler.js';
import { recordConfluenceVersionObservation } from '../../domains/confluence/services/sync-service.js';
import { encryptPat } from '../../core/utils/crypto.js';
import { confluenceToHtml } from '../../core/services/content-converter.js';
import { encodeConfluenceLinkValue } from '../../core/services/confluence-link.js';
import { oracleElements, oracleUrlLinks } from '../../core/services/__fixtures__/storage-oracle.js';
import { LEGACY_CARRIER_FIXTURES as LEGACY } from '../../core/services/__fixtures__/confluence-carrier-legacy.js';
import { logger } from '../../core/utils/logger.js';
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

type ConfluenceRequest = {
  method: string;
  url: string;
  body: ConfluencePayload;
  authorization: string | undefined;
};

let app: FastifyInstance;
let redis: RedisClientType;
let confluence: Server;
let confluenceBaseUrl: string;
let currentUserId: string;
let recoveryAdminId: string;
let attachmentsDir: string;
let originalAttachmentsDir: string | undefined;
let remoteVersion = 8;
let attachmentUploadUrls: string[] = [];
/** When set, an attachment upload is acknowledged with this filename (#1955 tests); otherwise it is a 404. */
let acknowledgedAttachment: string | null = null;
/** Every request the provider saw, in order: `POST attachment` / `PUT page`. */
let providerCalls: string[] = [];
let strictProviderVersion: number | null = null;
let confluenceRequests: ConfluenceRequest[] = [];
let compactPutReply = false;
let readbackStatus = 200;
let readbackCalls = 0;
let providerPage: (ConfluencePayload & { id: string; status: string }) | null = null;

async function readRequestBody(request: IncomingMessage): Promise<ConfluencePayload> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as ConfluencePayload;
}
async function waitForBlockedLifecycleLock(): Promise<void> {
  const reachedBarrier = await waitForDatabaseCondition(async () => {
    const waiting = await query<{ waiting: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM pg_stat_activity
          WHERE datname = current_database()
            AND wait_event_type = 'Lock'
            AND wait_event = 'advisory'
            AND query LIKE '%pg_advisory_xact_lock%'
       ) AS waiting`,
    );
    return waiting.rows[0]?.waiting ?? false;
  });
  if (!reachedBarrier) {
    throw new Error('stale writer did not reach the lifecycle lock barrier');
  }
}


async function insertConfluenceSpace(spaceKey: string): Promise<void> {
  await query(
    `INSERT INTO spaces (space_key, space_name, source, last_synced)
     VALUES ($1, $1, 'confluence', NOW())`,
    [spaceKey],
  );
}


async function seedConfluencePage(userId: string, opts: { enabled?: boolean; credentials?: boolean } = {}): Promise<number> {
  const enabled = opts.enabled ?? true;
  const credentials = opts.credentials ?? true;
  await insertConfluenceSpace('OPS');
  await query(
    `WITH editor_role AS (
       INSERT INTO roles (name, display_name, permissions)
       VALUES ('update-editor', 'Update editor', ARRAY['read', 'write'])
       ON CONFLICT (name) DO UPDATE SET permissions = EXCLUDED.permissions
       RETURNING id
     )
     INSERT INTO space_role_assignments (space_key, principal_type, principal_id, role_id)
     SELECT 'OPS', 'user', $1, id FROM editor_role`,
    [userId],
  );
  const page = await query<{ id: number }>(
    `INSERT INTO pages
       (confluence_id, source, space_key, title, body_html, body_storage, body_text,
        version, visibility, summary_status, summary_retry_count, quality_status,
        quality_retry_count, embedding_dirty, image_analysis_dirty)
     VALUES ('page-1', 'confluence', 'OPS', 'Original', '<p>original</p>',
             '<p>original</p>', 'original', 7, 'shared', 'summarized', 3,
             'failed', 4, FALSE, FALSE)
     RETURNING id`,
  );
  await query(
    `INSERT INTO user_settings (user_id, confluence_url, confluence_pat, confluence_enabled)
     VALUES ($1, $2, $3, $4)`,
    [
      userId,
      credentials ? confluenceBaseUrl : null,
      credentials ? encryptPat('real-http-test-pat') : null,
      enabled,
    ],
  );
  return page.rows[0]!.id;
}

async function freeze(pageId: number, actorId: string): Promise<void> {
  setPageBaselineReadinessProvider(async () => ({ ready: true, blockers: [] }));
  const admin = await insertUser(`page-update-admin-${randomUUID()}`);
  await query("UPDATE users SET role = 'admin' WHERE id = $1", [admin]);
  await query(
    `INSERT INTO user_settings (user_id, confluence_enabled)
     VALUES ($1, FALSE), ($2, FALSE)
     ON CONFLICT (user_id) DO UPDATE SET confluence_enabled = FALSE`,
    [admin, actorId],
  );
  await setPageBaselineCreationEnabled(admin, true);
  const prepared = await previewPageBaseline(pageId, actorId);
  await freezePage({
    pageId,
    actorId,
    reason: 'Approved update fixture',
    expectedContentRevision: prepared.contentRevision,
    expectedManifestDigest: prepared.manifestDigest,
    reportedSignatories: [],
  });
}

type StoredPage = {
  title: string;
  body_html: string;
  body_storage: string | null;
  body_text: string;
  version: number;
  visibility: string;
  summary_status: string;
  summary_retry_count: number;
  quality_status: string;
  quality_retry_count: number;
  embedding_dirty: boolean;
  image_analysis_dirty: boolean;
  local_modified_at: Date | null;
  local_modified_by: string | null;
  content_revision: string;
};

async function pageRow(pageId: number): Promise<StoredPage> {
  const result = await query<StoredPage>(
    `SELECT title, body_html, body_storage, body_text, version, visibility,
            summary_status, summary_retry_count, quality_status, quality_retry_count,
            embedding_dirty, image_analysis_dirty, local_modified_at, local_modified_by,
            content_revision::text AS content_revision
       FROM pages WHERE id = $1`,
    [pageId],
  );
  return result.rows[0]!;
}

describe.skipIf(!dbAvailable || !redisAvailable)('PUT /api/pages/:id — real PostgreSQL and Redis', () => {
  beforeAll(async () => {
    await setupTestDb();
    originalAttachmentsDir = process.env.ATTACHMENTS_DIR;
    attachmentsDir = await mkdtemp(join(tmpdir(), 'page-update-real-'));
    process.env.ATTACHMENTS_DIR = attachmentsDir;

    confluence = createServer(async (request, response) => {
      if (request.method === 'GET' && request.url?.startsWith('/rest/api/content/page-1?')) {
        readbackCalls += 1;
        response.writeHead(readbackStatus, { 'content-type': 'application/json' });
        response.end(JSON.stringify(readbackStatus === 200 ? providerPage : { message: 'Readback denied' }));
        return;
      }
      if (request.method === 'POST' && request.url?.endsWith('/child/attachment')) {
        attachmentUploadUrls.push(request.url);
        providerCalls.push('POST attachment');
        if (acknowledgedAttachment !== null) {
          for await (const chunk of request) void chunk;
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ results: [{ id: 'att-1', title: acknowledgedAttachment, version: { number: 1 } }] }));
          return;
        }
      }
      if (request.method !== 'PUT' || !request.url?.startsWith('/rest/api/content/')) {
        response.writeHead(404).end();
        return;
      }
      const body = await readRequestBody(request);
      providerCalls.push('PUT page');
      confluenceRequests.push({
        method: request.method, url: request.url, body, authorization: request.headers.authorization,
      });
      if (strictProviderVersion !== null && body.version.number !== strictProviderVersion + 1) {
        response.writeHead(409).end(JSON.stringify({ message: 'Confluence requires its next version' }));
        return;
      }
      providerPage = {
        id: decodeURIComponent(request.url.split('/').at(-1)!),
        status: 'current',
        title: body.title,
        version: { number: remoteVersion },
        body: { storage: { value: body.body.storage.value } },
      };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(compactPutReply
        ? { id: providerPage.id, version: providerPage.version }
        : providerPage));
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
      const [{ pagesCrudRoutes }, { localSpacesRoutes }] = await Promise.all([
        import('./pages-crud.js'),
        import('./local-spaces.js'),
      ]);
      await instance.register(pagesCrudRoutes, { prefix: '/api' });
      await instance.register(localSpacesRoutes, { prefix: '/api' });
    });
    registerOrdinaryPageWriteReconcilers();
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
    attachmentUploadUrls = [];
    acknowledgedAttachment = null;
    providerCalls = [];
    remoteVersion = 8;
    strictProviderVersion = null;
    compactPutReply = false;
    readbackStatus = 200;
    readbackCalls = 0;
    providerPage = null;
    currentUserId = await insertUser(`page-update-${randomUUID()}`);
    recoveryAdminId = await insertUser(`page-update-recovery-admin-${randomUUID()}`);
    await query("UPDATE users SET role = 'admin' WHERE id = $1", [recoveryAdminId]);
  });

  it('persists a standalone edit, advances the version, and re-queues derived work', async () => {
    await insertLocalSpace('LOCAL', currentUserId);
    const pageId = await insertStandalonePage('Original', 'private', currentUserId, 'LOCAL');
    await query(
      `UPDATE pages SET summary_status = 'summarized', summary_retry_count = 3,
                        quality_status = 'failed', quality_retry_count = 4,
                        embedding_dirty = FALSE, image_analysis_dirty = FALSE
        WHERE id = $1`,
      [pageId],
    );

    const response = await app.inject({
      method: 'PUT',
      url: `/api/pages/${pageId}`,
      payload: { title: 'Changed', bodyHtml: '<p>Changed <strong>text</strong></p>', version: 1 },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ id: pageId, title: 'Changed', version: 2, source: 'standalone' });
    expect(await pageRow(pageId)).toMatchObject({
      title: 'Changed',
      body_html: '<p>Changed <strong>text</strong></p>',
      body_text: 'Changed text',
      version: 2,
      summary_status: 'pending',
      summary_retry_count: 0,
      quality_status: 'pending',
      quality_retry_count: 0,
      embedding_dirty: true,
      image_analysis_dirty: true,
      local_modified_by: currentUserId,
    });
  });

  it('rejects a stale standalone version without changing persisted content', async () => {
    await insertLocalSpace('LOCAL', currentUserId);
    const pageId = await insertStandalonePage('Current', 'private', currentUserId, 'LOCAL');
    await query('UPDATE pages SET version = 4 WHERE id = $1', [pageId]);

    const response = await app.inject({
      method: 'PUT',
      url: `/api/pages/${pageId}`,
      payload: { title: 'Stale', bodyHtml: '<p>stale</p>', version: 3 },
    });

    expect(response.statusCode).toBe(409);
    expect(await pageRow(pageId)).toMatchObject({ title: 'Current', body_html: '<p>x</p>', version: 4 });
  });

  it('evicts both cached tree variants when a visibility-only update grants or revokes access', async () => {
    const owner = currentUserId;
    await insertLocalSpace('LOCAL', owner);
    const pageId = await insertStandalonePage('Private page', 'private', owner, 'LOCAL');
    const otherUser = await insertUser(`page-update-other-${randomUUID()}`);

    async function treeContainsPage(url: string): Promise<boolean> {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode, response.body).toBe(200);
      return response
        .json<{ items: Array<{ id: string | number }> }>()
        .items.some((item) => String(item.id) === String(pageId));
    }

    currentUserId = otherUser;
    expect(await treeContainsPage('/api/pages/tree')).toBe(false);
    expect(await treeContainsPage('/api/spaces/LOCAL/tree')).toBe(false);

    currentUserId = owner;
    const original = await pageRow(pageId);
    const shared = await app.inject({
      method: 'PUT',
      url: `/api/pages/${pageId}`,
      payload: {
        title: 'Private page',
        bodyHtml: '<p>x</p>',
        version: 1,
        visibility: 'shared',
      },
    });
    expect(shared.statusCode, shared.body).toBe(200);

    const changed = await pageRow(pageId);
    expect(changed).toMatchObject({
      visibility: 'shared',
      version: original.version,
      content_revision: original.content_revision,
    });
    currentUserId = otherUser;
    expect(await treeContainsPage('/api/pages/tree')).toBe(true);
    expect(await treeContainsPage('/api/spaces/LOCAL/tree')).toBe(true);

    currentUserId = owner;
    const revoked = await app.inject({
      method: 'PUT',
      url: `/api/pages/${pageId}`,
      payload: {
        title: 'Private page',
        bodyHtml: '<p>x</p>',
        version: 1,
        visibility: 'private',
      },
    });
    expect(revoked.statusCode, revoked.body).toBe(200);

    currentUserId = otherUser;
    expect(await treeContainsPage('/api/pages/tree')).toBe(false);
    expect(await treeContainsPage('/api/spaces/LOCAL/tree')).toBe(false);
  });
  it('rechecks current authority after the lifecycle lock before accepting a stale shared-page writer', async () => {
    const owner = currentUserId;
    await insertLocalSpace('LOCAL', owner);
    const pageId = await insertStandalonePage('Shared page', 'shared', owner, 'LOCAL');
    currentUserId = await insertUser(`page-update-stale-${randomUUID()}`);

    const blocker = await getPool().connect();
    await blocker.query('BEGIN');
    await lockPageLifecycle(blocker, [pageId]);
    try {
      const staleWrite = app.inject({
        method: 'PUT',
        url: `/api/pages/${pageId}`,
        payload: { title: 'Shared page', bodyHtml: '<p>x</p>', version: 1 },
      });
      await waitForBlockedLifecycleLock();
      await blocker.query("UPDATE pages SET visibility = 'private' WHERE id = $1", [pageId]);
      await blocker.query('COMMIT');

      const response = await staleWrite;
      expect(response.statusCode).toBe(403);
      expect(await pageRow(pageId)).toMatchObject({
        title: 'Shared page', body_html: '<p>x</p>', visibility: 'private', version: 1,
      });
    } catch (error) {
      await blocker.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      blocker.release();
    }
  });


  it('refuses an owner deactivated while an authored update waits for admission', async () => {
    await insertLocalSpace('LOCAL', currentUserId);
    const pageId = await insertStandalonePage('Original', 'private', currentUserId, 'LOCAL');
    const blocker = await getPool().connect();
    await blocker.query('BEGIN');
    await lockPageLifecycle(blocker, [pageId]);
    try {
      const pending = app.inject({
        method: 'PUT',
        url: `/api/pages/${pageId}`,
        payload: { title: 'Unauthorized change', bodyHtml: '<p>changed</p>', version: 1 },
      });
      await waitForBlockedLifecycleLock();
      await blocker.query('UPDATE users SET deactivated_at = NOW() WHERE id = $1', [currentUserId]);
      await blocker.query('COMMIT');

      const response = await pending;
      expect(response.statusCode).toBe(403);
      expect(await pageRow(pageId)).toMatchObject({
        title: 'Original', body_html: '<p>x</p>', version: 1,
      });
      expect(confluenceRequests).toHaveLength(0);
    } catch (error) {
      await blocker.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      blocker.release();
    }
  });

  it('denies a private standalone edit by a non-owner', async () => {
    const owner = currentUserId;
    await insertLocalSpace('LOCAL', owner);
    const pageId = await insertStandalonePage('Private', 'private', owner, 'LOCAL');
    currentUserId = await insertUser(`page-update-intruder-${randomUUID()}`);

    const response = await app.inject({
      method: 'PUT',
      url: `/api/pages/${pageId}`,
      payload: { title: 'Taken', bodyHtml: '<p>taken</p>', version: 1 },
    });

    expect(response.statusCode).toBe(403);
    expect(await pageRow(pageId)).toMatchObject({ title: 'Private', body_html: '<p>x</p>', version: 1 });
  });

  it('denies an inaccessible Confluence space before making an HTTP request', async () => {
    const pageId = await seedConfluencePage(currentUserId);
    await query('DELETE FROM space_role_assignments WHERE principal_id = $1', [currentUserId]);
    await redis.flushDb();

    const response = await app.inject({
      method: 'PUT',
      url: `/api/pages/${pageId}`,
      payload: { title: 'Denied', bodyHtml: '<p>denied</p>', version: 7 },
    });

    expect(response.statusCode).toBe(403);
    expect(confluenceRequests).toHaveLength(0);
    expect(await pageRow(pageId)).toMatchObject({ title: 'Original', version: 7 });
  });

  it.each([false, true])('publishes through Confluence with divergent counters: %s', async (diverged) => {
    const pageId = await seedConfluencePage(currentUserId);

    const localVersion = diverged ? 6 : 7;
    const providerVersion = diverged ? 5 : 7;
    remoteVersion = providerVersion + 1;
    strictProviderVersion = providerVersion;
    if (diverged) {
      await query('UPDATE pages SET version = $2, remote_version = $3 WHERE id = $1', [pageId, localVersion, providerVersion]);
    }
    const response = await app.inject({
      method: 'PUT',
      url: `/api/pages/${pageId}`,
      payload: { title: 'Remote title', bodyHtml: '<p>Remote body</p>', version: localVersion },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ id: pageId, title: 'Remote title', version: localVersion + 1, source: 'confluence' });
    expect(confluenceRequests).toHaveLength(1);
    expect(confluenceRequests[0]).toMatchObject({ method: 'PUT', url: '/rest/api/content/page-1' });
    expect(confluenceRequests[0]!.body).toMatchObject({ title: 'Remote title', version: { number: providerVersion + 1 } });
    const row = await pageRow(pageId);
    expect(row).toMatchObject({
      title: 'Remote title',
      version: localVersion + 1,
      body_storage: expect.stringContaining('Remote body'),
      body_html: expect.stringContaining('Remote body'),
      body_text: 'Remote body',
      summary_status: 'pending',
      quality_status: 'pending',
      embedding_dirty: true,
      image_analysis_dirty: true,
      local_modified_at: null,
      local_modified_by: null,
    });
    expect((await query('SELECT remote_version FROM pages WHERE id = $1', [pageId])).rows)
      .toEqual([{ remote_version: providerVersion + 1 }]);
    expect((await query('SELECT status FROM page_write_intents WHERE page_ids = ARRAY[$1]::int[]', [pageId])).rows)
      .toEqual([{ status: 'completed' }]);
  });

  it('blocks a queued manual-review conflict before provider calls and allows local editing', async () => {
    const pageId = await seedConfluencePage(currentUserId);
    await query('UPDATE pages SET conflict_pending = TRUE, remote_version = 6 WHERE id = $1', [pageId]);
    const put = () => app.inject({
      method: 'PUT', url: `/api/pages/${pageId}`,
      payload: { title: 'Local edit', bodyHtml: '<p>Local edit</p>', version: 7 },
    });

    const refused = await put();
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json()).toMatchObject({ reason: 'sync_conflict_pending' });
    expect((await query(
      'SELECT id FROM page_write_intents WHERE page_ids = ARRAY[$1]::int[] AND status = $2', [pageId, 'pending'],
    )).rows).toEqual([]);
    await query('UPDATE user_settings SET confluence_enabled = FALSE WHERE user_id = $1', [currentUserId]);
    expect((await put()).statusCode).toBe(200);
    expect(confluenceRequests).toEqual([]);
  });

  it.each([false, true])('refuses a stale editor revision (counter-only bump: %s)', async (bump) => {
    const pageId = await seedConfluencePage(currentUserId);
    await query('UPDATE pages SET remote_version = 6 WHERE id = $1', [pageId]);
    const before = await pageRow(pageId);
    // The same SQL that the sync conflict path runs under its row lock.
    if (bump) {
      await withPageWriteTransaction([pageId], async (client) => {
        await client.query('SELECT 1 FROM pages WHERE id = $1 FOR UPDATE', [pageId]);
        await recordConfluenceVersionObservation(client, pageId, 8);
      });
    }

    const response = await app.inject({
      method: 'PUT',
      url: `/api/pages/${pageId}`,
      payload: { title: 'Stale editor', bodyHtml: '<p>Must not land</p>', version: bump ? 7 : 6 },
    });
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json().error).toContain('modified since you loaded it');
    expect(await pageRow(pageId)).toMatchObject({ version: bump ? 8 : 7, title: before.title, body_html: before.body_html });
    expect(confluenceRequests).toEqual([]);
  });

  it('keeps the Confluence ids of tasks synced before ids were carried when the page is saved (#1751)', async () => {
    const pageId = await seedConfluencePage(currentUserId);
    await query('UPDATE pages SET body_storage = $2 WHERE id = $1', [
      pageId,
      '<p>original</p><ac:task-list>'
      + '<ac:task><ac:task-id>794464</ac:task-id><ac:task-status>complete</ac:task-status>'
      + '<ac:task-body>Ship it</ac:task-body></ac:task>'
      + '<ac:task><ac:task-id>12</ac:task-id><ac:task-status>incomplete</ac:task-status>'
      + '<ac:task-body>Write docs</ac:task-body></ac:task></ac:task-list>',
    ]);
    // What the editor saves after an unrelated edit when the stored body
    // predates the carrier: TaskItem's markup, no data-task-id.
    const bodyHtml = '<p>original (edited)</p><ul data-type="taskList">'
      + '<li data-checked="true" data-type="taskItem"><label><input type="checkbox" checked="checked">'
      + '<span></span></label><div><p>Ship it</p></div></li>'
      + '<li data-checked="false" data-type="taskItem"><label><input type="checkbox"><span></span></label>'
      + '<div><p>Write docs</p></div></li></ul>';

    const response = await app.inject({
      method: 'PUT',
      url: `/api/pages/${pageId}`,
      payload: { title: 'Original', bodyHtml, version: 7 },
    });

    expect(response.statusCode, response.body).toBe(200);
    const sent = confluenceRequests[0]!.body.body.storage.value;
    expect([...sent.matchAll(/<ac:task-id>([^<]*)<\/ac:task-id>/g)].map((match) => match[1])).toEqual(['794464', '12']);
    // TaskItem's checkbox markup stays in the editor: the task bodies are the content.
    expect(sent).not.toMatch(/<input|<label/);
    // The stored body is re-derived from the storage Confluence returned, so it carries them now.
    const row = await pageRow(pageId);
    expect([...row.body_html.matchAll(/data-task-id="([^"]*)"/g)].map((match) => match[1])).toEqual(['794464', '12']);
  });

  describe('the order pairing of a page synced before ids were carried (#1751)', () => {
    const STORAGE = '<p>original</p><ac:task-list>'
      + '<ac:task><ac:task-id>794464</ac:task-id><ac:task-status>complete</ac:task-status>'
      + '<ac:task-body>Ship it</ac:task-body></ac:task>'
      + '<ac:task><ac:task-id>12</ac:task-id><ac:task-status>incomplete</ac:task-status>'
      + '<ac:task-body>Write docs</ac:task-body></ac:task></ac:task-list>';

    /** TaskItem's markup for `texts`, without data-task-id. */
    function editorTasks(...texts: string[]): string {
      return `<p>original</p><ul data-type="taskList">${texts.map((text) => '<li data-checked="false" data-type="taskItem">'
        + `<label><input type="checkbox"><span></span></label><div><p>${text}</p></div></li>`).join('')}</ul>`;
    }

    async function sentTaskIds(storedBodyHtml: string, bodyHtml: string): Promise<string[]> {
      const pageId = await seedConfluencePage(currentUserId);
      await query('UPDATE pages SET body_storage = $2, body_html = $3 WHERE id = $1', [pageId, STORAGE, storedBodyHtml]);
      const response = await app.inject({
        method: 'PUT',
        url: `/api/pages/${pageId}`,
        payload: { title: 'Original', bodyHtml, version: 7 },
      });
      expect(response.statusCode, response.body).toBe(200);
      const sent = confluenceRequests[0]!.body.body.storage.value;
      return [...sent.matchAll(/<ac:task-id>([^<]*)<\/ac:task-id>/g)].map((match) => match[1]!);
    }

    it('gives edited tasks their stored ids in order when the stored body carries no id and no task was added or removed (#1751)', async () => {
      const legacyBody = '<p>original</p><ul data-type="taskList">'
        + '<li data-type="taskItem" data-checked="true">Ship it</li>'
        + '<li data-type="taskItem" data-checked="false">Write docs</li></ul>';
      expect(await sentTaskIds(legacyBody, editorTasks('Ship it today', 'Write docs'))).toEqual(['794464', '12']);
    });

    it('gives the tasks that replace every task of a page whose stored body carries ids new ids (#1751)', async () => {
      const carriedBody = '<p>original</p><ul data-type="taskList">'
        + '<li data-type="taskItem" data-checked="true" data-task-id="794464">Ship it</li>'
        + '<li data-type="taskItem" data-checked="false" data-task-id="12">Write docs</li></ul>';
      expect(await sentTaskIds(carriedBody, editorTasks('Alpha', 'Beta'))).toEqual(['794465', '794466']);
    });
  });

  it('does not upload the cached draw.io preview of a diagram on a Confluence page (#1935)', async () => {
    const pageId = await seedConfluencePage(currentUserId);
    await mkdir(join(attachmentsDir, 'page-1'), { recursive: true });
    await writeFile(join(attachmentsDir, 'page-1', 'Arch.png'), Buffer.from('cached drawio preview'));

    const response = await app.inject({
      method: 'PUT',
      url: `/api/pages/${pageId}`,
      payload: {
        title: 'With diagram',
        bodyHtml: '<p>text</p><div class="confluence-drawio" data-diagram-name="Arch">'
          + '<img src="/api/attachments/page-1/Arch.png" alt="Arch"></div>',
        version: 7,
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(attachmentUploadUrls).toEqual([]);
    expect(confluenceRequests).toHaveLength(1);
  });

  describe('ri:url links of the saved body (#1955)', () => {
    const STORED_LINK = '<ac:link><ri:url ri:value="/docs/guide" />'
      + '<ac:plain-text-link-body><![CDATA[the guide]]></ac:plain-text-link-body></ac:link>';
    const STORAGE = `<p>See ${STORED_LINK} first.</p><p>${'Unrelated prose that keeps the two paragraphs apart. '.repeat(3)}</p>`;
    const carrier = (value: string, text: string): string =>
      `<a href="#confluence-url:${encodeConfluenceLinkValue(value)}?body=plain">${text}</a>`;

    async function seedLinkedPage(): Promise<number> {
      const pageId = await seedConfluencePage(currentUserId);
      await query('UPDATE pages SET body_storage = $2, body_html = $3 WHERE id = $1', [pageId, STORAGE, confluenceToHtml(STORAGE, 'page-1')]);
      return pageId;
    }

    async function intentRows(pageId: number): Promise<number> {
      const rows = await query('SELECT 1 FROM page_write_intents WHERE page_ids = ARRAY[$1]::int[]', [pageId]);
      return rows.rowCount ?? 0;
    }

    it('sends the stored link, and writes a copy, an invented one and raw link markup as their text', async () => {
      const pageId = await seedLinkedPage();
      const filler = `<p>${'Unrelated prose that keeps the two paragraphs apart. '.repeat(3)}</p>`;
      const response = await app.inject({
        method: 'PUT',
        url: `/api/pages/${pageId}`,
        payload: {
          title: 'Original',
          version: 7,
          bodyHtml: `<p>See ${carrier('/docs/guide', 'the guide')} first.</p>${filler}`
            + `<p>Copy: ${carrier('/docs/guide', 'the guide')}.</p>`
            + `<p>New: ${carrier('javascript:alert(1)', 'click me')}.</p>`
            + '<p>Raw: <ac:link><ri:url ri:value="data:text/html,x"></ri:url>'
            + '<ac:plain-text-link-body>raw text</ac:plain-text-link-body></ac:link>.</p>'
            + '<p>Web: <a href="https://example.com/" class="#confluence-url:https%3A%2F%2Fexample.com%2F">example</a>.</p>',
        },
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(confluenceRequests).toHaveLength(1);
      const sent = confluenceRequests[0]!.body.body.storage.value;
      // The dispatched string, read by the independent oracle: the one stored unsafe link, in its place, and the web link.
      expect(oracleUrlLinks(sent)).toEqual([
        { value: '/docs/guide', link: {}, resource: {}, body: 'plain:the guide', text: 'the guide' },
        { value: 'https://example.com/', link: {}, resource: {}, body: 'plain:example', text: 'example' },
      ]);
      expect(sent).toContain('<p>See <ac:link><ri:url ri:value="/docs/guide"></ri:url>');
      expect(sent).toContain('<p>Copy: the guide.</p><p>New: click me.</p><p>Raw: raw text.</p>');
      // The page mirrors what Confluence returned: the declined links are text there too.
      const row = await pageRow(pageId);
      expect(row.body_storage).toBe(sent);
      expect(row.body_html).toContain('<p>Copy: the guide.</p><p>New: click me.</p>');
      expect(row.body_html).not.toContain('javascript');
    });

    it('refuses a body that would carry a link past the check, before the intent, the upload and the PUT (W3)', async () => {
      const pageId = await seedLinkedPage();
      // A pasted image whose name holds a literal percent, as older editors wrote it: planned, never uploaded.
      await mkdir(join(attachmentsDir, 'page-1'), { recursive: true });
      await writeFile(join(attachmentsDir, 'page-1', '100%.png'), Buffer.from('pasted image bytes'));
      acknowledgedAttachment = '100%.png';
      const before = await pageRow(pageId);

      for (const [body, reason] of [
        ['<style><ac:link><ri:url ri:value="javascript:alert(1)"></ri:url></ac:link></style>', 'unapproved-link'],
        ['<p title="a<b">x</p><style><ac:link><ri:url ri:value="/x"></ri:url></ac:link></style>', 'not-well-formed'],
      ] as const) {
        const response = await app.inject({
          method: 'PUT',
          url: `/api/pages/${pageId}`,
          payload: { title: 'Changed', version: 7, bodyHtml: `<p>text <img src="/api/attachments/page-1/100%.png"></p>${body}` },
        });
        expect(response.statusCode, response.body).toBe(422);
        // (The suite's own error handler answers; app.test.ts pins the production body.)
        expect(response.json()).toEqual({ error: 'ConfluenceStorageRefusedError', reason });
      }

      expect(providerCalls).toEqual([]);
      expect(attachmentUploadUrls).toEqual([]);
      expect(await intentRows(pageId)).toBe(0);
      expect(await pageRow(pageId)).toEqual(before);
    });

    // Owner decision D19 (review r5, R24): an unchanged Save that would publish a #1955 link with another target
    // than the stored one is refused before any effect, on this Save and the next; the escaped spelling is written.
    it('refuses a Save that would change a stored blog link\'s section, before the intent and the PUT, twice (D19)', async () => {
      const pageId = await seedConfluencePage(currentUserId);
      const blog = (anchor: string): string =>
        `<p>see <ac:link ac:anchor="${anchor}"><ri:blog-post ri:content-title="Authors" ri:space-key="OPS" /></ac:link> now</p>`;
      const changed = blog('See /> here');
      await query('UPDATE pages SET body_storage = $2, body_html = $3 WHERE id = $1', [pageId, changed, confluenceToHtml(changed, 'page-1')]);
      const before = await pageRow(pageId);
      for (let save = 0; save < 2; save += 1) {
        const response = await app.inject({
          method: 'PUT', url: `/api/pages/${pageId}`, payload: { title: 'Original', version: 7, bodyHtml: before.body_html },
        });
        expect(response.statusCode, response.body).toBe(422);
        expect(response.json()).toEqual({ error: 'ConfluenceStorageRefusedError', reason: 'changed-link-target' });
      }
      expect(providerCalls).toEqual([]);
      expect(await intentRows(pageId)).toBe(0);
      expect(await pageRow(pageId)).toEqual(before);

      const kept = blog('See /&gt; here');
      await query('UPDATE pages SET body_storage = $2, body_html = $3 WHERE id = $1', [pageId, kept, confluenceToHtml(kept, 'page-1')]);
      const response = await app.inject({
        method: 'PUT', url: `/api/pages/${pageId}`, payload: { title: 'Original', version: 7, bodyHtml: confluenceToHtml(kept, 'page-1') },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(confluenceRequests.at(-1)!.body.body.storage.value).toContain('ac:anchor="See /&gt; here"');
    });

    // Review r1, R4: membership of the space is not access to a page that does not inherit its permissions.
    it.each([
      ['a body the write-back refuses', '<p>x</p><style><ac:link><ri:url ri:value="javascript:alert(1)"></ri:url></ac:link></style>'],
      ['a pasted image that is gone', '<p><img src="/api/attachments/page-1/missing.png"></p>'],
    ])('answers a space member the page ACE denies as not authorized for %s: nothing is planned or derived for them (R4)', async (_name, bodyHtml) => {
      const pageId = await seedLinkedPage();
      await query('UPDATE pages SET inherit_perms = FALSE WHERE id = $1', [pageId]);
      const before = await pageRow(pageId);

      const response = await app.inject({ method: 'PUT', url: `/api/pages/${pageId}`, payload: { title: 'Changed', version: 7, bodyHtml } });

      // The denial, not a reason that describes the body or the files it names.
      expect(response.statusCode, response.body).toBe(403);
      expect(response.json()).toMatchObject({ reason: 'not_authorized' });
      expect(response.body).not.toMatch(/ConfluenceStorageRefusedError|unapproved-link|pasted_image/);
      expect(providerCalls).toEqual([]);
      expect(attachmentUploadUrls).toEqual([]);
      expect(await intentRows(pageId)).toBe(0);
      expect(await pageRow(pageId)).toEqual(before);

      // With an entry for them the same request is answered for what it holds.
      await query(
        `INSERT INTO access_control_entries (resource_type, resource_id, principal_type, principal_id, permission)
         VALUES ('page', $1, 'user', $2, 'edit')`,
        [pageId, currentUserId],
      );
      const allowed = await app.inject({ method: 'PUT', url: `/api/pages/${pageId}`, payload: { title: 'Changed', version: 7, bodyHtml } });
      expect([409, 422]).toContain(allowed.statusCode);
    });

    it('uploads the planned image once and then sends exactly the storage it derived from the plan (W3)', async () => {
      const pageId = await seedLinkedPage();
      await mkdir(join(attachmentsDir, 'page-1'), { recursive: true });
      await writeFile(join(attachmentsDir, 'page-1', '100%.png'), Buffer.from('pasted image bytes'));
      acknowledgedAttachment = '100%.png';

      const response = await app.inject({
        method: 'PUT',
        url: `/api/pages/${pageId}`,
        payload: {
          title: 'Original',
          version: 7,
          bodyHtml: `<p>See ${carrier('/docs/guide', 'the guide')} first.</p><p><img src="/api/attachments/page-1/100%.png"></p>`,
        },
      });

      expect(response.statusCode, response.body).toBe(200);
      // One upload, before the one page PUT.
      expect(providerCalls).toEqual(['POST attachment', 'PUT page']);
      const sent = confluenceRequests[0]!.body.body.storage.value;
      expect(sent).toBe(
        '<p>See <ac:link><ri:url ri:value="/docs/guide"></ri:url><ac:plain-text-link-body><![CDATA[the guide]]></ac:plain-text-link-body></ac:link> first.</p>'
        + '<p><ac:image><ri:attachment ri:filename="100%.png"></ri:attachment></ac:image></p>',
      );
    });

    it('refuses a pasted image that is gone before reserving anything (W3)', async () => {
      const pageId = await seedLinkedPage();
      const response = await app.inject({
        method: 'PUT',
        url: `/api/pages/${pageId}`,
        payload: { title: 'Original', version: 7, bodyHtml: '<p><img src="/api/attachments/page-1/missing.png"></p>' },
      });
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json()).toMatchObject({ reason: 'pasted_image_unavailable' });
      expect(providerCalls).toEqual([]);
      expect(await intentRows(pageId)).toBe(0);
    });

    it('does not judge a save that stays local: Confluence disabled, the body is stored as written', async () => {
      const pageId = await seedConfluencePage(currentUserId, { enabled: false });
      const bodyHtml = '<style><ac:link><ri:url ri:value="/x"></ri:url></ac:link></style><p>local</p>';
      const response = await app.inject({
        method: 'PUT',
        url: `/api/pages/${pageId}`,
        payload: { title: 'Original', version: 7, bodyHtml },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(providerCalls).toEqual([]);
      expect((await pageRow(pageId)).body_html).toBe(bodyHtml);
    });
  });

  it('recovers a compact acknowledged PUT after readback fails without replaying the mutation', async () => {
    const pageId = await seedConfluencePage(currentUserId);
    compactPutReply = true;
    readbackStatus = 403;
    const before = await pageRow(pageId);

    const response = await app.inject({
      method: 'PUT',
      url: `/api/pages/${pageId}`,
      payload: { title: 'Acknowledged title', bodyHtml: '<p>acknowledged body</p>', version: 7 },
    });

    expect(response.statusCode).toBe(403);
    expect(readbackCalls).toBe(1);
    expect(confluenceRequests).toHaveLength(1);
    expect(await pageRow(pageId)).toMatchObject({
      title: before.title, body_html: before.body_html, version: before.version,
    });
    const pending = await query<{ id: string; status: string; remote_effects_completed_at: Date | null }>(
      `SELECT id, status, remote_effects_completed_at
         FROM page_write_intents WHERE kind = 'pages.update.confluence' AND page_ids = ARRAY[$1]::integer[]`,
      [pageId],
    );
    expect(pending.rows[0]).toMatchObject({
      status: 'pending', remote_effects_completed_at: expect.any(Date),
    });

    const retiredRuntime = `retired-compact-put-${randomUUID()}`;
    await query(
      `INSERT INTO page_writer_runtimes
         (runtime_id, deployment_identity, fenced_at, fence_reason, fence_proof)
       VALUES ($1, '{"fixture":"terminated PUT owner"}', NOW(),
               'Fixture simulates termination after acknowledged PUT',
               '{"kind":"verified_local_termination"}')`,
      [retiredRuntime],
    );
    await query('UPDATE page_write_intents SET runtime_id = $2 WHERE id = $1', [
      pending.rows[0]!.id, retiredRuntime,
    ]);
    readbackStatus = 200;
    await expect(reconcilePageWriteIntent(pending.rows[0]!.id, {
      actorId: recoveryAdminId, reason: 'Recover known provider success without another page mutation',
    })).resolves.toEqual({ intentId: pending.rows[0]!.id, status: 'reconciled_applied' });
    expect(await pageRow(pageId)).toMatchObject({
      title: 'Acknowledged title', body_text: 'acknowledged body', version: 8,
      summary_status: 'pending', quality_status: 'pending',
    });
    expect(readbackCalls).toBe(2);
    expect(confluenceRequests).toHaveLength(1);
  });

  it('retains a conflicting acknowledgment instead of publishing an unrelated provider version', async () => {
    const pageId = await seedConfluencePage(currentUserId);
    remoteVersion = 11;
    const response = await app.inject({
      method: 'PUT', url: `/api/pages/${pageId}`,
      payload: { title: 'Unconfirmed', bodyHtml: '<p>unconfirmed</p>', version: 7 },
    });
    expect(response.statusCode).toBe(409);
    expect(await pageRow(pageId)).toMatchObject({ title: 'Original', version: 7 });
    expect((await query(
      `SELECT 1 FROM page_write_intents
        WHERE page_ids = ARRAY[$1]::integer[] AND status = 'pending'
          AND remote_effects_completed_at IS NOT NULL`,
      [pageId],
    )).rowCount).toBe(1);
    expect(readbackCalls).toBe(0);
  });

  it('refuses stale Confluence mode after the request waits for admission', async () => {
    const pageId = await seedConfluencePage(currentUserId);
    const blocker = await getPool().connect();
    try {
      await blocker.query('BEGIN');
      await lockPageLifecycle(blocker, [pageId]);
      const pending = app.inject({
        method: 'PUT', url: `/api/pages/${pageId}`,
        payload: { title: 'Stale mode', bodyHtml: '<p>must not leave</p>', version: 7 },
      });
      await waitForBlockedLifecycleLock();
      await blocker.query('UPDATE user_settings SET confluence_enabled = FALSE WHERE user_id = $1', [
        currentUserId,
      ]);
      await blocker.query('COMMIT');
      const response = await pending;
      expect(response.statusCode).toBe(409);
      expect(confluenceRequests).toEqual([]);
      expect(await pageRow(pageId)).toMatchObject({ title: 'Original', version: 7 });
      expect((await query(
        `SELECT 1 FROM page_write_intents WHERE page_ids = ARRAY[$1]::integer[] AND status = 'pending'`,
        [pageId],
      )).rowCount).toBe(0);
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
    }
  });

  it('uses the current PAT rather than credentials captured before admission', async () => {
    const pageId = await seedConfluencePage(currentUserId);
    const blocker = await getPool().connect();
    try {
      await blocker.query('BEGIN');
      await lockPageLifecycle(blocker, [pageId]);
      const pending = app.inject({
        method: 'PUT', url: `/api/pages/${pageId}`,
        payload: { title: 'Fresh credentials', bodyHtml: '<p>current PAT</p>', version: 7 },
      });
      await waitForBlockedLifecycleLock();
      await blocker.query('UPDATE user_settings SET confluence_pat = $2 WHERE user_id = $1', [
        currentUserId, encryptPat('replacement-fixture-pat'),
      ]);
      await blocker.query('COMMIT');
      const response = await pending;
      expect(response.statusCode, response.body).toBe(200);
      expect(confluenceRequests).toHaveLength(1);
      expect(confluenceRequests[0]!.authorization).toBe('Bearer replacement-fixture-pat');
      expect(await pageRow(pageId)).toMatchObject({ title: 'Fresh credentials', version: 8 });
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
    }
  });

  it('keeps a synced-page edit local while Confluence is disabled and retains credentials', async () => {
    const pageId = await seedConfluencePage(currentUserId, { enabled: false });

    const response = await app.inject({
      method: 'PUT',
      url: `/api/pages/${pageId}`,
      payload: { title: 'Local divergence', bodyHtml: '<p>local only</p>', version: 7 },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(confluenceRequests).toHaveLength(0);
    expect(await pageRow(pageId)).toMatchObject({
      title: 'Local divergence', body_html: '<p>local only</p>', version: 8,
      local_modified_by: currentUserId,
    });
    const settings = await query<{ confluence_url: string | null; confluence_pat: string | null }>(
      'SELECT confluence_url, confluence_pat FROM user_settings WHERE user_id = $1',
      [currentUserId],
    );
    expect(settings.rows[0]!.confluence_url).toBe(confluenceBaseUrl);
    expect(settings.rows[0]!.confluence_pat).not.toBeNull();
  });

  it('keeps the credential error for an enabled user with no Confluence credentials', async () => {
    const pageId = await seedConfluencePage(currentUserId, { credentials: false });
    const response = await app.inject({
      method: 'PUT',
      url: `/api/pages/${pageId}`,
      payload: { title: 'No credentials', bodyHtml: '<p>x</p>', version: 7 },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toContain('Confluence not configured');
    expect(confluenceRequests).toHaveLength(0);
  });

  it('uses real frozen lifecycle state to deny authored changes while allowing visibility-only changes', async () => {
    await insertLocalSpace('LOCAL', currentUserId);
    const pageId = await insertStandalonePage('Frozen', 'private', currentUserId, 'LOCAL');
    await freeze(pageId, currentUserId);
    const before = await pageRow(pageId);

    const denied = await app.inject({
      method: 'PUT',
      url: `/api/pages/${pageId}`,
      payload: { title: 'Frozen', bodyHtml: '<p>changed</p>', version: 1, visibility: 'shared' },
    });
    expect(denied.statusCode).toBe(423);
    expect(await pageRow(pageId)).toMatchObject({
      body_html: before.body_html,
      visibility: before.visibility,
      version: before.version,
      content_revision: before.content_revision,
    });

    const visibilityOnly = await app.inject({
      method: 'PUT',
      url: `/api/pages/${pageId}`,
      payload: { title: 'Frozen', bodyHtml: '<p>x</p>', version: 1, visibility: 'shared' },
    });
    expect(visibilityOnly.statusCode, visibilityOnly.body).toBe(200);
    expect(await pageRow(pageId)).toMatchObject({
      body_html: before.body_html,
      visibility: 'shared',
      version: before.version,
      content_revision: before.content_revision,
    });
  });

  describe('carriers of a page synced before v0.10.0 (#1953)', () => {
    const LOG = 'Confluence carriers reconciled (#1953)';
    const sent = (): string => confluenceRequests.at(-1)!.body.body.storage.value;
    const codeParameters = (storage: string): Record<string, string> => Object.fromEntries(
      [...(oracleElements(storage, 'ac', 'structured-macro').find((macro) => macro.getAttribute('ac:name') === 'code')?.children ?? [])]
        .filter((child) => child.localName === 'parameter')
        .map((child) => [child.getAttribute('ac:name') ?? '', child.textContent ?? '']),
    );
    const emoticons = (storage: string): string[] => oracleElements(storage, 'ac', 'emoticon').map((el) => el.getAttribute('ac:name') ?? '');
    const carrierLines = (spy: ReturnType<typeof vi.spyOn>): unknown[] =>
      spy.mock.calls.filter((call: unknown[]) => call[1] === LOG).map((call: unknown[]) => call[0]);

    async function seedLegacy(fixture: { storage: string; legacyHtml: string } = LEGACY.ac1): Promise<number> {
      const pageId = await seedConfluencePage(currentUserId);
      await query('UPDATE pages SET body_storage = $2, body_html = $3 WHERE id = $1', [pageId, fixture.storage, fixture.legacyHtml]);
      return pageId;
    }

    async function save(pageId: number, bodyHtml: string, version = 7) {
      return app.inject({ method: 'PUT', url: `/api/pages/${pageId}`, payload: { title: 'Original', bodyHtml, version } });
    }

    it('keeps macro parameters, emoticons and link targets of a legacy page on its first save, and logs counts by kind, names only', async () => {
      const pageId = await seedLegacy();
      const info = vi.spyOn(logger, 'info');
      try {
        const response = await save(pageId, LEGACY.ac1.legacyHtml);
        expect(response.statusCode, response.body).toBe(200);
        expect(codeParameters(sent())).toEqual({ language: 'java', title: 'Main', linenumbers: 'true' });
        expect(emoticons(sent())).toEqual(['tick', 'cross']);
        expect(sent()).toContain('<ri:page ri:content-title="My Page" ri:space-key="ENG"></ri:page>');
        expect(sent()).toContain('<ri:attachment ri:filename="a.pdf"><ri:page ri:content-title="Other"></ri:page></ri:attachment>');
        expect(sent()).toContain('<ac:link ac:anchor="top">');
        expect(carrierLines(info)).toEqual([{
          pageId,
          writer: 'put',
          outcome: 'recovered',
          recovered: { emoticon: 2, 'macro.code': 1, 'macro.toc': 1, 'macro.status': 1, link: 3 },
          skipped: {},
        }]);
        expect(JSON.stringify(carrierLines(info))).not.toMatch(/Main|ENG|a\.pdf|tick|My Page|data-cq-/);
      } finally {
        info.mockRestore();
      }
      expect(sent()).not.toContain('data-cq-');
      // The page mirrors what Confluence returned; the next save writes the same storage and recovers nothing.
      const first = sent();
      const row = await pageRow(pageId);
      expect(row.body_storage).toBe(first);
      remoteVersion = 9;
      const second = await save(pageId, row.body_html, row.version);
      expect(second.statusCode, second.body).toBe(200);
      expect(sent()).toBe(first);
    });

    it('does not resurrect an emoticon in a block the user edited', async () => {
      const pageId = await seedLegacy();
      const response = await save(pageId, LEGACY.ac1.legacyHtml.replace('Done  now', 'Done  later'));
      expect(response.statusCode, response.body).toBe(200);
      expect(sent()).toContain('<p>Done  later</p>');
      expect(emoticons(sent())).toEqual(['cross']);
    });

    it('recovers nothing and logs the excluded reason on a locally modified row, a collaborative document row and a draw.io wrapper', async () => {
      const drawio = '<div class="confluence-drawio" data-diagram-name="d"></div>';
      const cases: Array<[string, (pageId: number) => Promise<void>, string]> = [
        ['local_modified', (pageId) => query('UPDATE pages SET local_modified_at = NOW() WHERE id = $1', [pageId]).then(() => undefined), ''],
        ['collab_document', (pageId) => query(
          `INSERT INTO page_collaborative_docs (page_id, doc_state, state_vector, version, updated_at)
           VALUES ($1, '\\x00'::bytea, '\\x00'::bytea, 1, NOW())`,
          [pageId],
        ).then(() => undefined), ''],
        ['drawio', (pageId) => query('UPDATE pages SET body_html = body_html || $2 WHERE id = $1', [pageId, drawio]).then(() => undefined), drawio],
      ];
      for (const [reason, prepare, suffix] of cases) {
        await truncateAllTables();
        currentUserId = await insertUser(`page-update-carriers-${randomUUID()}`);
        confluenceRequests = [];
        const pageId = await seedLegacy();
        await prepare(pageId);
        const info = vi.spyOn(logger, 'info');
        try {
          const response = await save(pageId, LEGACY.ac1.legacyHtml + suffix);
          expect(response.statusCode, `${reason}: ${response.body}`).toBe(200);
          expect(codeParameters(sent())).toEqual({ language: 'java' });
          expect(emoticons(sent())).toEqual([]);
          expect(carrierLines(info)).toEqual([{
            pageId, writer: 'put', excluded: reason, kinds: ['macro.code', 'macro.status', 'macro.toc', 'link', 'emoticon'],
          }]);
        } finally {
          info.mockRestore();
        }
      }
    });

    it('Z6: an eligible save whose every legacy record is skipped logs evaluated with the skip reason and sends today\'s storage', async () => {
      const pageId = await seedLegacy(LEGACY.twoLookalikeLinks);
      const info = vi.spyOn(logger, 'info');
      try {
        const response = await save(pageId, LEGACY.twoLookalikeLinks.legacyHtml);
        expect(response.statusCode, response.body).toBe(200);
        expect(carrierLines(info)).toEqual([{
          pageId, writer: 'put', outcome: 'evaluated', recovered: {}, skipped: { link: { ambiguous: 2 } },
        }]);
      } finally {
        info.mockRestore();
      }
      expect(oracleElements(sent(), 'ri', 'page').map((page) => page.getAttribute('ri:space-key'))).toEqual([null, null]);
    });

    for (const [interleaving, change] of [
      ['a collaborative document seeded', `INSERT INTO page_collaborative_docs (page_id, doc_state, state_vector, version, updated_at)
         VALUES ($1, '\\x00'::bytea, '\\x00'::bytea, 1, NOW())`],
      ['local_modified_at set', 'UPDATE pages SET local_modified_at = NOW() WHERE id = $1'],
    ] as const) {
      it(`Y7: prepare → ${interleaving} → reserve answers 409, publishes no recovery and logs stale`, async () => {
        const pageId = await seedLegacy();
        const info = vi.spyOn(logger, 'info');
        const blocker = await getPool().connect();
        try {
          await blocker.query('BEGIN');
          await lockPageLifecycle(blocker, [pageId]);
          const pending = save(pageId, LEGACY.ac1.legacyHtml);
          await waitForBlockedLifecycleLock();
          await blocker.query(change, [pageId]);
          await blocker.query('COMMIT');
          const response = await pending;
          expect(response.statusCode, response.body).toBe(409);
          expect(response.json()).toMatchObject({ reason: 'stale_content_revision' });
          expect(confluenceRequests).toEqual([]);
          expect(providerCalls).toEqual([]);
          expect((await query('SELECT 1 FROM page_write_intents WHERE page_ids = ARRAY[$1]::integer[]', [pageId])).rowCount).toBe(0);
          expect(await pageRow(pageId)).toMatchObject({ body_html: LEGACY.ac1.legacyHtml, version: 7 });
          expect(carrierLines(info)).toEqual([{ pageId, writer: 'put', outcome: 'stale' }]);
        } finally {
          info.mockRestore();
          await blocker.query('ROLLBACK').catch(() => undefined);
          blocker.release();
        }
        // The retry reads a row that is no longer lockstep and writes without recovery.
        const retry = await save(pageId, LEGACY.ac1.legacyHtml);
        expect(retry.statusCode, retry.body).toBe(200);
        expect(emoticons(sent())).toEqual([]);
      });
    }
  });
});
