import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
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
import { getPool, query } from '../../core/db/postgres.js';
import { setRedisClient } from '../../core/services/redis-cache.js';
import { setPageBaselineReadinessProvider } from '../../core/services/page-baseline-governance.js';
import {
  freezePage,
  previewPageBaseline,
  setPageBaselineCreationEnabled,
} from '../../core/services/page-baseline-service.js';
import { lockPageLifecycle, reconcilePageWriteIntent } from '../../core/services/page-write-admission.js';
import { registerOrdinaryPageWriteReconcilers } from '../../domains/confluence/services/ordinary-page-write-reconciler.js';
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
  for (let attempt = 0; attempt < 200; attempt += 1) {
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
    if (waiting.rows[0]?.waiting) return;
  }
  throw new Error('stale writer did not reach the lifecycle lock barrier');
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
      if (request.method !== 'PUT' || !request.url?.startsWith('/rest/api/content/')) {
        response.writeHead(404).end();
        return;
      }
      const body = await readRequestBody(request);
      confluenceRequests.push({
        method: request.method, url: request.url, body, authorization: request.headers.authorization,
      });
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
      const { pagesCrudRoutes } = await import('./pages-crud.js');
      await instance.register(pagesCrudRoutes, { prefix: '/api' });
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
    remoteVersion = 8;
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

  it('makes a visibility-only update visible through another user’s already-cached tree without bumping content', async () => {
    await insertLocalSpace('LOCAL', currentUserId);
    const pageId = await insertStandalonePage('Private page', 'private', currentUserId, 'LOCAL');
    const otherUser = await insertUser(`page-update-other-${randomUUID()}`);
    currentUserId = otherUser;
    const before = await app.inject({ method: 'GET', url: '/api/pages/tree' });
    expect(before.json<{ items: Array<{ id: string }> }>().items.some((item) => item.id === String(pageId))).toBe(false);

    currentUserId = (await query<{ created_by_user_id: string }>(
      'SELECT created_by_user_id FROM pages WHERE id = $1', [pageId],
    )).rows[0]!.created_by_user_id;
    const original = await pageRow(pageId);
    const response = await app.inject({
      method: 'PUT',
      url: `/api/pages/${pageId}`,
      payload: { title: 'Private page', bodyHtml: '<p>x</p>', version: 1, visibility: 'shared' },
    });
    expect(response.statusCode, response.body).toBe(200);

    const changed = await pageRow(pageId);
    expect(changed).toMatchObject({
      visibility: 'shared',
      version: original.version,
      content_revision: original.content_revision,
    });
    currentUserId = otherUser;
    const after = await app.inject({ method: 'GET', url: '/api/pages/tree' });
    expect(after.json<{ items: Array<{ id: string }> }>().items.some((item) => item.id === String(pageId))).toBe(true);
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

  it('pushes a Confluence edit over HTTP and persists the remote version and converted body', async () => {
    const pageId = await seedConfluencePage(currentUserId);

    const response = await app.inject({
      method: 'PUT',
      url: `/api/pages/${pageId}`,
      payload: { title: 'Remote title', bodyHtml: '<p>Remote body</p>', version: 7 },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ id: pageId, title: 'Remote title', version: 8, source: 'confluence' });
    expect(confluenceRequests).toHaveLength(1);
    expect(confluenceRequests[0]).toMatchObject({ method: 'PUT', url: '/rest/api/content/page-1' });
    expect(confluenceRequests[0]!.body).toMatchObject({ title: 'Remote title', version: { number: 8 } });
    const row = await pageRow(pageId);
    expect(row).toMatchObject({
      title: 'Remote title',
      version: 8,
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
});
