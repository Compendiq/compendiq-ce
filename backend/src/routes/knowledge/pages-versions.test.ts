import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import sensible from '@fastify/sensible';
import { createClient, type RedisClientType } from 'redis';
import { ZodError } from 'zod';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getPool, query } from '../../core/db/postgres.js';
import {
  lockPageLifecycle,
  reconcilePageWriteIntent,
} from '../../core/services/page-write-admission.js';
import { setRedisClient } from '../../core/services/redis-cache.js';
import { encryptPat } from '../../core/utils/crypto.js';
import { bumpProviderCacheVersion } from '../../domains/llm/services/cache-bus.js';
import {
  isDbAvailable,
  setupTestDb,
  teardownTestDb,
  truncateAllTables,
} from '../../test-db-helper.js';
import { isRedisAvailable } from '../../test-redis-helper.js';
import { pagesVersionRoutes } from './pages-versions.js';

const [dbAvailable, redisAvailable] = await Promise.all([
  isDbAvailable(),
  isRedisAvailable(),
]);

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
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
  throw new Error('Version restore did not reach the lifecycle admission barrier');
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

type SeedPageOptions = {
  source?: 'standalone' | 'confluence';
  confluenceId?: string | null;
  spaceKey?: string | null;
  visibility?: 'private' | 'shared';
  ownerId?: string | null;
  version?: number;
  title?: string;
  bodyHtml?: string;
  bodyText?: string;
  lastModifiedAt?: Date | null;
};

describe.skipIf(!dbAvailable || !redisAvailable)('page version routes with real PostgreSQL and Redis', () => {
  let app: FastifyInstance;
  let redis: RedisClientType;
  let llmServer: Server;
  let llmBaseUrl = '';
  let userId = '';
  let otherUserId = '';
  let recoveryAdminId = '';
  let confluenceBaseUrl = '';
  let confluenceRequests: Array<{
    method: string;
    url: string;
    authorization: string | undefined;
    body?: {
      title: string;
      version: { number: number };
      body: { storage: { value: string } };
    };
  }> = [];
  let compactPutReply = false;
  let readbackStatus = 200;
  let providerPage: {
    id: string;
    type: string;
    status: string;
    title: string;
    version: { number: number };
    body: { storage: { value: string; representation: string } };
  } | null = null;
  let afterConfluencePut: (() => Promise<void>) | null = null;
  let llmRequests: Array<Record<string, unknown>> = [];
  const ownedRedisKeys = new Set<string>();
  const ownedUserIds = new Set<string>();

  beforeAll(async () => {
    process.env.PAT_ENCRYPTION_KEY ??= 'pages-versions-test-key-32bytes';
    await setupTestDb();
    redis = createClient({
      url: process.env.REDIS_URL,
      socket: { reconnectStrategy: false },
    });
    await redis.connect();
    setRedisClient(redis);

    llmServer = createServer(async (request, response) => {
      if (request.method === 'PUT' && request.url?.startsWith('/rest/api/content/')) {
        const body = JSON.parse(await readRequestBody(request)) as {
          title: string;
          version: { number: number };
          body: { storage: { value: string } };
        };
        const id = request.url.split('?')[0]!.split('/').at(-1)!;
        confluenceRequests.push({
          method: 'PUT',
          url: request.url,
          authorization: request.headers.authorization,
          body,
        });
        providerPage = {
          id,
          type: 'page',
          status: 'current',
          title: body.title,
          version: body.version,
          body: { storage: { value: body.body.storage.value, representation: 'storage' } },
        };
        if (afterConfluencePut) await afterConfluencePut();
        sendJson(response, 200, compactPutReply
          ? { id, type: 'page', title: body.title, version: body.version }
          : providerPage);
        return;
      }
      if (request.method === 'GET' && request.url?.startsWith('/rest/api/content/')) {
        confluenceRequests.push({
          method: 'GET',
          url: request.url,
          authorization: request.headers.authorization,
        });
        if (readbackStatus !== 200) {
          sendJson(response, readbackStatus, { message: 'readback refused by fixture' });
        } else if (providerPage) {
          sendJson(response, 200, providerPage);
        } else {
          sendJson(response, 404, { message: 'missing provider page' });
        }
        return;
      }
      if (request.method === 'POST' && request.url === '/v1/chat/completions') {
        llmRequests.push(JSON.parse(await readRequestBody(request)) as Record<string, unknown>);
        sendJson(response, 200, {
          choices: [{ message: { role: 'assistant', content: '- The introduction was expanded.' } }],
          usage: { prompt_tokens: 20, completion_tokens: 7 },
        });
        return;
      }
      sendJson(response, 404, { error: 'unexpected test endpoint' });
    });
    await new Promise<void>((resolve) => llmServer.listen(0, '127.0.0.1', resolve));
    const address = llmServer.address() as AddressInfo;
    llmBaseUrl = `http://127.0.0.1:${address.port}/v1`;
    confluenceBaseUrl = `http://127.0.0.1:${address.port}`;

    app = Fastify({ logger: false });
    await app.register(sensible);
    app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
      if (error instanceof ZodError) {
        return reply.status(400).send({ error: 'Validation failed' });
      }
      return reply.status(error.statusCode ?? 500).send({ error: error.message });
    });
    app.decorate('authenticate', async (request: FastifyRequest, reply: FastifyReply) => {
      const identity = request.headers['x-test-user'];
      if (typeof identity !== 'string') {
        return reply.code(401).send({ error: 'Unauthenticated' });
      }
      request.userId = identity;
    });
    app.decorateRequest('userId', '');
    app.decorate('redis', redis);
    await app.register(pagesVersionRoutes, { prefix: '/api' });
    await app.ready();
  });

  beforeEach(async () => {
    await truncateAllTables();
    await bumpProviderCacheVersion();
    llmRequests = [];
    confluenceRequests = [];
    compactPutReply = false;
    readbackStatus = 200;
    providerPage = null;
    afterConfluencePut = null;
    ownedRedisKeys.clear();
    ownedUserIds.clear();

    const users = await query<{ id: string; username: string }>(
      `INSERT INTO users (username, email, password_hash, role)
       VALUES ('versions-owner', 'versions-owner@test', 'x', 'user'),
              ('versions-other', 'versions-other@test', 'x', 'user'),
              ('versions-recovery', 'versions-recovery@test', 'x', 'admin')
       RETURNING id, username`,
    );
    userId = users.rows.find((row) => row.username === 'versions-owner')!.id;
    otherUserId = users.rows.find((row) => row.username === 'versions-other')!.id;
    recoveryAdminId = users.rows.find((row) => row.username === 'versions-recovery')!.id;
    ownedUserIds.add(userId);
    ownedUserIds.add(otherUserId);
    ownedUserIds.add(recoveryAdminId);
  });

  afterEach(async () => {
    const keys = [
      ...ownedRedisKeys,
      ...[...ownedUserIds].flatMap((id) => [
        `rbac:admin:${id}`,
        `rbac:spaces:${id}`,
        `rbac:global:${id}`,
      ]),
    ];
    if (keys.length > 0) await redis.del(keys);
  });

  afterAll(async () => {
    await app.close();
    await redis.quit();
    llmServer.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      llmServer.close((error) => error ? reject(error) : resolve());
    });
    await teardownTestDb();
  });

  async function seedPage(options: SeedPageOptions = {}): Promise<number> {
    const source = options.source ?? 'standalone';
    const result = await query<{ id: number }>(
      `INSERT INTO pages
         (confluence_id, source, space_key, title, body_storage, body_html, body_text,
          version, visibility, created_by_user_id, last_modified_at,
          embedding_dirty, embedding_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, FALSE, 'not_embedded')
       RETURNING id`,
      [
        options.confluenceId ?? null,
        source,
        options.spaceKey ?? null,
        options.title ?? 'Current title',
        options.bodyHtml ?? '<p>Current body</p>',
        options.bodyHtml ?? '<p>Current body</p>',
        options.bodyText ?? 'Current body',
        options.version ?? 3,
        options.visibility ?? 'private',
        options.ownerId === undefined ? userId : options.ownerId,
        options.lastModifiedAt === undefined ? new Date('2026-03-01T12:00:00Z') : options.lastModifiedAt,
      ],
    );
    return result.rows[0]!.id;
  }

  async function seedVersion(
    pageId: number,
    versionNumber: number,
    title: string,
    bodyHtml: string | null,
    bodyText: string | null,
    metadata: { editedAt?: Date | null; author?: string | null; message?: string | null } = {},
  ): Promise<void> {
    await query(
      `INSERT INTO page_versions
         (page_id, version_number, title, body_html, body_text, synced_at, edited_at, author, message)
       VALUES ($1, $2, $3, $4, $5, '2026-03-02T12:00:00Z', $6, $7, $8)`,
      [
        pageId,
        versionNumber,
        title,
        bodyHtml,
        bodyText,
        metadata.editedAt ?? null,
        metadata.author ?? null,
        metadata.message ?? null,
      ],
    );
  }

  async function configureConfluence(spaceKey: string, pat = 'restore-original-pat'): Promise<void> {
    await query(
      `INSERT INTO spaces (space_key, space_name, source, last_synced)
       VALUES ($1, $1, 'confluence', NOW())
       ON CONFLICT (space_key) DO NOTHING`,
      [spaceKey],
    );
    const role = await query<{ id: number }>(
      `INSERT INTO roles (name, display_name, permissions)
       VALUES ('versions-editor', 'Versions editor', ARRAY['read', 'write'])
       ON CONFLICT (name) DO UPDATE SET permissions = EXCLUDED.permissions
       RETURNING id`,
    );
    await query(
      `INSERT INTO space_role_assignments (space_key, principal_type, principal_id, role_id)
       VALUES ($1, 'user', $2, $3)
       ON CONFLICT DO NOTHING`,
      [spaceKey, userId, role.rows[0]!.id],
    );
    await query(
      `INSERT INTO user_settings (user_id, confluence_url, confluence_pat, confluence_enabled)
       VALUES ($1, $2, $3, TRUE)
       ON CONFLICT (user_id) DO UPDATE SET
         confluence_url = EXCLUDED.confluence_url,
         confluence_pat = EXCLUDED.confluence_pat,
         confluence_enabled = TRUE`,
      [userId, confluenceBaseUrl, encryptPat(pat)],
    );
  }

  it.each([
    ['GET', '/api/pages/1/versions', undefined],
    ['GET', '/api/pages/1/versions/1', undefined],
    ['POST', '/api/pages/1/versions/semantic-diff', { v1: 1, v2: 2 }],
    ['POST', '/api/pages/1/versions/1/restore', { version: 2 }],
  ] as const)('requires authentication for %s %s', async (method, url, payload) => {
    const response = await app.inject({ method, url, payload });
    expect(response.statusCode).toBe(401);
  });

  it('lists real local history newest-first, de-duplicates the live version, and keeps null live timestamps', async () => {
    const pageId = await seedPage({ version: 3, lastModifiedAt: null });
    await seedVersion(pageId, 3, 'Duplicate live snapshot', '<p>duplicate</p>', 'duplicate');
    await seedVersion(pageId, 2, 'Earlier title', '<p>Earlier body</p>', 'Earlier body', {
      editedAt: new Date('2026-02-28T10:00:00Z'),
      author: 'Alice',
      message: 'Updated introduction',
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/pages/${pageId}/versions`,
      headers: { 'x-test-user': userId },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      pageId: String(pageId),
      versions: [
        {
          versionNumber: 3,
          title: 'Current title',
          editedAt: null,
          syncedAt: null,
          isCurrent: true,
        },
        {
          versionNumber: 2,
          title: 'Earlier title',
          editedAt: '2026-02-28T10:00:00.000Z',
          author: 'Alice',
          message: 'Updated introduction',
          isCurrent: false,
        },
      ],
    });
    expect(response.json().backfillStatus).toBeUndefined();
  });

  it('returns an empty list for a missing page and enforces private-page and space RBAC', async () => {
    const privatePageId = await seedPage();
    await query(
      `INSERT INTO spaces (space_key, space_name)
       VALUES ('SECRET', 'Restricted space')`,
    );
    const restrictedPageId = await seedPage({
      source: 'confluence',
      confluenceId: 'restricted-page',
      spaceKey: 'SECRET',
      visibility: 'shared',
      ownerId: null,
    });

    const missing = await app.inject({
      method: 'GET',
      url: '/api/pages/not-present/versions',
      headers: { 'x-test-user': userId },
    });
    const privateDenied = await app.inject({
      method: 'GET',
      url: `/api/pages/${privatePageId}/versions`,
      headers: { 'x-test-user': otherUserId },
    });
    const spaceDenied = await app.inject({
      method: 'GET',
      url: `/api/pages/${restrictedPageId}/versions`,
      headers: { 'x-test-user': userId },
    });

    expect(missing.statusCode).toBe(200);
    expect(missing.json().versions).toEqual([]);
    expect(privateDenied.statusCode).toBe(403);
    expect(spaceDenied.statusCode).toBe(403);
  });

  it('returns current and historical detail from persisted rows and reports a missing version', async () => {
    const pageId = await seedPage({ version: 4 });
    await seedVersion(pageId, 2, 'Historical title', '<p>Historical body</p>', 'Historical body');

    const current = await app.inject({
      method: 'GET',
      url: `/api/pages/${pageId}/versions/4`,
      headers: { 'x-test-user': userId },
    });
    const historical = await app.inject({
      method: 'GET',
      url: `/api/pages/${pageId}/versions/2`,
      headers: { 'x-test-user': userId },
    });
    const missing = await app.inject({
      method: 'GET',
      url: `/api/pages/${pageId}/versions/99`,
      headers: { 'x-test-user': userId },
    });

    expect(current.statusCode).toBe(200);
    expect(current.json()).toMatchObject({ versionNumber: 4, bodyHtml: '<p>Current body</p>', isCurrent: true });
    expect(historical.statusCode).toBe(200);
    expect(historical.json()).toMatchObject({
      versionNumber: 2,
      title: 'Historical title',
      bodyHtml: '<p>Historical body</p>',
      isCurrent: false,
    });
    expect(missing.statusCode).toBe(404);
  });

  it('produces a semantic diff through the configured external HTTP provider and snapshots the live version', async () => {
    const pageId = await seedPage({ version: 3, bodyHtml: '<p>Expanded introduction</p>', bodyText: 'Expanded introduction' });
    await seedVersion(pageId, 1, 'First title', '<p>Short introduction</p>', 'Short introduction');
    const provider = await query<{ id: string }>(
      `INSERT INTO llm_providers
         (name, base_url, auth_type, verify_ssl, is_default, default_model)
       VALUES ('versions-diff', $1, 'none', TRUE, TRUE, 'diff-model')
       RETURNING id`,
      [llmBaseUrl],
    );
    await query(
      `INSERT INTO llm_usecase_assignments (usecase, provider_id, model)
       VALUES ('chat', $1, 'diff-model')
       ON CONFLICT (usecase) DO UPDATE SET provider_id = EXCLUDED.provider_id, model = EXCLUDED.model`,
      [provider.rows[0]!.id],
    );
    await bumpProviderCacheVersion();

    const response = await app.inject({
      method: 'POST',
      url: `/api/pages/${pageId}/versions/semantic-diff`,
      headers: { 'x-test-user': userId },
      payload: { v1: 1, v2: 3 },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({
      diff: '- The introduction was expanded.',
      v1: 1,
      v2: 3,
      pageId: String(pageId),
    });
    expect(llmRequests).toHaveLength(1);
    expect(llmRequests[0]).toMatchObject({ model: 'diff-model' });
    expect(JSON.stringify(llmRequests[0])).toContain('Short introduction');
    expect(JSON.stringify(llmRequests[0])).toContain('Expanded introduction');
    expect((await query(
      'SELECT version_number, body_html FROM page_versions WHERE page_id = $1 AND version_number = 3',
      [pageId],
    )).rows).toEqual([{ version_number: 3, body_html: '<p>Expanded introduction</p>' }]);
  });

  it('restores a standalone snapshot transactionally and records the superseded state and audit', async () => {
    const pageId = await seedPage({
      version: 3,
      title: 'Live title',
      bodyHtml: '<p>Live body</p>',
      bodyText: 'Live body',
    });
    await seedVersion(pageId, 1, 'Restored title', '<p>Restored body</p>', 'Restored body');

    const response = await app.inject({
      method: 'POST',
      url: `/api/pages/${pageId}/versions/1/restore`,
      headers: { 'x-test-user': userId },
      payload: { version: 3 },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      id: pageId,
      title: 'Restored title',
      version: 4,
      restoredFrom: 1,
      source: 'standalone',
      pushedToConfluence: false,
    });
    expect((await query(
      `SELECT title, body_html, body_text, version, embedding_dirty,
              local_modified_by::text AS local_modified_by
         FROM pages WHERE id = $1`,
      [pageId],
    )).rows).toEqual([{
      title: 'Restored title',
      body_html: '<p>Restored body</p>',
      body_text: 'Restored body',
      version: 4,
      embedding_dirty: true,
      local_modified_by: userId,
    }]);
    expect((await query(
      `SELECT title, body_html, body_text FROM page_versions
        WHERE page_id = $1 AND version_number = 3`,
      [pageId],
    )).rows).toEqual([{
      title: 'Live title',
      body_html: '<p>Live body</p>',
      body_text: 'Live body',
    }]);
    expect((await query<{ action: string; metadata: Record<string, unknown> }>(
      `SELECT action, metadata FROM audit_log
        WHERE resource_id = $1 AND action = 'PAGE_VERSION_RESTORED'`,
      [String(pageId)],
    )).rows).toEqual([{
      action: 'PAGE_VERSION_RESTORED',
      metadata: expect.objectContaining({ restoredFrom: 1, newVersion: 4, pushedToConfluence: false }),
    }]);
  });

  it('publishes a large Confluence restore exactly, records history, and keeps terminal metadata bounded', async () => {
    await configureConfluence('OPS');
    const pageId = await seedPage({
      source: 'confluence',
      confluenceId: 'restore-large',
      spaceKey: 'OPS',
      visibility: 'shared',
      ownerId: null,
      version: 3,
      title: 'Live before restore',
      bodyHtml: '<p>Live before restore</p>',
      bodyText: 'Live before restore',
    });
    const restoredText = `restored-${'y'.repeat(36_000)}-end`;
    await seedVersion(pageId, 1, 'Large historical title', `<p>${restoredText}</p>`, restoredText);

    const response = await app.inject({
      method: 'POST',
      url: `/api/pages/${pageId}/versions/1/restore`,
      headers: { 'x-test-user': userId },
      payload: { version: 3 },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      id: pageId,
      title: 'Large historical title',
      version: 4,
      restoredFrom: 1,
      pushedToConfluence: true,
    });
    expect((await query(
      'SELECT title, body_text, version FROM pages WHERE id = $1',
      [pageId],
    )).rows).toEqual([{
      title: 'Large historical title',
      body_text: restoredText,
      version: 4,
    }]);
    expect((await query(
      `SELECT title, body_html, body_text
         FROM page_versions WHERE page_id = $1 AND version_number = 3`,
      [pageId],
    )).rows).toEqual([{
      title: 'Live before restore',
      body_html: '<p>Live before restore</p>',
      body_text: 'Live before restore',
    }]);
    const intent = await query<{
      status: string;
      remote_terminal_result: Record<string, unknown>;
    }>(
      `SELECT status, remote_terminal_result
         FROM page_write_intents
        WHERE kind = 'page.version_restore' AND page_ids = ARRAY[$1]::integer[]`,
      [pageId],
    );
    expect(intent.rows[0]?.status).toBe('completed');
    expect(Buffer.byteLength(JSON.stringify(intent.rows[0]?.remote_terminal_result))).toBeLessThan(1024);
    expect(JSON.stringify(intent.rows[0]?.remote_terminal_result)).not.toContain(restoredText.slice(0, 128));
    expect(confluenceRequests.map((entry) => entry.method)).toEqual(['PUT']);
  });

  it('recovers a compact acknowledged restore after readback failure without issuing a second PUT', async () => {
    await configureConfluence('OPS');
    const pageId = await seedPage({
      source: 'confluence',
      confluenceId: 'restore-compact',
      spaceKey: 'OPS',
      visibility: 'shared',
      ownerId: null,
      version: 3,
      title: 'Live compact title',
      bodyHtml: '<p>Live compact body</p>',
      bodyText: 'Live compact body',
    });
    await seedVersion(pageId, 1, 'Compact historical', '<p>Compact restored body</p>', 'Compact restored body');
    compactPutReply = true;
    readbackStatus = 403;

    const response = await app.inject({
      method: 'POST',
      url: `/api/pages/${pageId}/versions/1/restore`,
      headers: { 'x-test-user': userId },
      payload: { version: 3 },
    });
    expect(response.statusCode).toBe(403);
    expect((await query(
      'SELECT title, body_text, version FROM pages WHERE id = $1',
      [pageId],
    )).rows).toEqual([{
      title: 'Live compact title',
      body_text: 'Live compact body',
      version: 3,
    }]);
    const pending = await query<{
      id: string;
      remote_terminal_result: Record<string, unknown>;
      remote_effects_completed_at: Date | null;
    }>(
      `SELECT id, remote_terminal_result, remote_effects_completed_at
         FROM page_write_intents
        WHERE kind = 'page.version_restore' AND page_ids = ARRAY[$1]::integer[] AND status = 'pending'`,
      [pageId],
    );
    expect(pending.rows[0]?.remote_effects_completed_at).toEqual(expect.any(Date));
    expect(JSON.stringify(pending.rows[0]?.remote_terminal_result)).not.toContain('Compact restored body');

    const retiredRuntime = `retired-restore-${Date.now()}`;
    await query(
      `INSERT INTO page_writer_runtimes
         (runtime_id, deployment_identity, fenced_at, fenced_by, fence_reason, fence_proof)
       VALUES ($1, '{"fixture":"retired restore writer"}', NOW(), $2,
               'Fixture confirms the acknowledged restore writer stopped',
               '{"kind":"verified_local_termination"}')`,
      [retiredRuntime, recoveryAdminId],
    );
    await query('UPDATE page_write_intents SET runtime_id = $2 WHERE id = $1', [
      pending.rows[0]!.id,
      retiredRuntime,
    ]);
    readbackStatus = 200;
    await expect(reconcilePageWriteIntent(pending.rows[0]!.id, {
      actorId: recoveryAdminId,
      reason: 'Recover compact acknowledged restore without replaying the provider mutation',
    })).resolves.toEqual({
      intentId: pending.rows[0]!.id,
      status: 'reconciled_applied',
    });
    expect((await query(
      'SELECT title, body_text, version FROM pages WHERE id = $1',
      [pageId],
    )).rows).toEqual([{
      title: 'Compact historical',
      body_text: 'Compact restored body',
      version: 4,
    }]);
    expect((await query(
      `SELECT title, body_html, body_text
         FROM page_versions WHERE page_id = $1 AND version_number = 3`,
      [pageId],
    )).rows).toEqual([{
      title: 'Live compact title',
      body_html: '<p>Live compact body</p>',
      body_text: 'Live compact body',
    }]);
    expect(confluenceRequests.filter((entry) => entry.method === 'PUT')).toHaveLength(1);
  });

  it('cancels a restore when its original actor is deactivated during the admission wait', async () => {
    await configureConfluence('OPS');
    const pageId = await seedPage({
      source: 'confluence',
      confluenceId: 'restore-revoked',
      spaceKey: 'OPS',
      visibility: 'shared',
      ownerId: null,
      version: 3,
    });
    await seedVersion(pageId, 1, 'Revoked target', '<p>Revoked target</p>', 'Revoked target');
    const blocker = await getPool().connect();
    await blocker.query('BEGIN');
    await lockPageLifecycle(blocker, [pageId]);
    try {
      const pending = app.inject({
        method: 'POST',
        url: `/api/pages/${pageId}/versions/1/restore`,
        headers: { 'x-test-user': userId },
        payload: { version: 3 },
      });
      await waitForBlockedLifecycleLock();
      await blocker.query('UPDATE users SET deactivated_at = NOW() WHERE id = $1', [userId]);
      await blocker.query('COMMIT');

      const response = await pending;
      expect(response.statusCode).toBe(403);
      expect(confluenceRequests).toEqual([]);
      expect((await query(
        `SELECT status FROM page_write_intents
          WHERE kind = 'page.version_restore' AND page_ids = ARRAY[$1]::integer[]`,
        [pageId],
      )).rows).toEqual([{ status: 'cancelled' }]);
    } catch (error) {
      await blocker.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      blocker.release();
    }
  });

  it('uses a PAT rotated while restore waits and re-resolves credentials again for compact readback', async () => {
    await configureConfluence('OPS');
    const pageId = await seedPage({
      source: 'confluence',
      confluenceId: 'restore-rotated-pat',
      spaceKey: 'OPS',
      visibility: 'shared',
      ownerId: null,
      version: 3,
    });
    await seedVersion(pageId, 1, 'Rotated target', '<p>Rotated target body</p>', 'Rotated target body');
    compactPutReply = true;
    afterConfluencePut = async () => {
      await query(
        'UPDATE user_settings SET confluence_pat = $2 WHERE user_id = $1',
        [userId, encryptPat('restore-readback-pat')],
      );
    };
    const blocker = await getPool().connect();
    await blocker.query('BEGIN');
    await lockPageLifecycle(blocker, [pageId]);
    try {
      const pending = app.inject({
        method: 'POST',
        url: `/api/pages/${pageId}/versions/1/restore`,
        headers: { 'x-test-user': userId },
        payload: { version: 3 },
      });
      await waitForBlockedLifecycleLock();
      await blocker.query(
        'UPDATE user_settings SET confluence_pat = $2 WHERE user_id = $1',
        [userId, encryptPat('restore-dispatch-pat')],
      );
      await blocker.query('COMMIT');

      const response = await pending;
      expect(response.statusCode, response.body).toBe(200);
      expect(confluenceRequests.map((entry) => ({
        method: entry.method,
        authorization: entry.authorization,
      }))).toEqual([
        { method: 'PUT', authorization: 'Bearer restore-dispatch-pat' },
        { method: 'GET', authorization: 'Bearer restore-readback-pat' },
      ]);
    } catch (error) {
      await blocker.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      blocker.release();
    }
  });

  it('refuses stale, collaborative, and unauthorized restores without changing authored state', async () => {
    const pageId = await seedPage({ version: 3 });
    await seedVersion(pageId, 1, 'Target', '<p>Target</p>', 'Target');

    const stale = await app.inject({
      method: 'POST',
      url: `/api/pages/${pageId}/versions/1/restore`,
      headers: { 'x-test-user': userId },
      payload: { version: 2 },
    });
    expect(stale.statusCode).toBe(409);

    const collabKey = `collab:active:${pageId}`;
    ownedRedisKeys.add(collabKey);
    await redis.sAdd(collabKey, 'versions-route-test-socket');
    const collaborative = await app.inject({
      method: 'POST',
      url: `/api/pages/${pageId}/versions/1/restore`,
      headers: { 'x-test-user': userId },
      payload: { version: 3 },
    });
    expect(collaborative.statusCode).toBe(409);
    expect(collaborative.json()).toMatchObject({ error: 'Collaborative editing session is active' });

    await redis.del(collabKey);
    const denied = await app.inject({
      method: 'POST',
      url: `/api/pages/${pageId}/versions/1/restore`,
      headers: { 'x-test-user': otherUserId },
      payload: { version: 3 },
    });
    expect(denied.statusCode).toBe(403);

    expect((await query(
      'SELECT title, body_html, version FROM pages WHERE id = $1',
      [pageId],
    )).rows).toEqual([{ title: 'Current title', body_html: '<p>Current body</p>', version: 3 }]);
    expect((await query(
      'SELECT id FROM page_write_intents WHERE page_ids @> ARRAY[$1]::integer[]',
      [pageId],
    )).rows).toEqual([]);
  });

  it('reports current-version and missing-target restore errors without producing history', async () => {
    const pageId = await seedPage({ version: 3 });

    const current = await app.inject({
      method: 'POST',
      url: `/api/pages/${pageId}/versions/3/restore`,
      headers: { 'x-test-user': userId },
      payload: { version: 3 },
    });
    const missing = await app.inject({
      method: 'POST',
      url: `/api/pages/${pageId}/versions/99/restore`,
      headers: { 'x-test-user': userId },
      payload: { version: 3 },
    });

    expect(current.statusCode).toBe(400);
    expect(missing.statusCode).toBe(404);
    expect((await query('SELECT id FROM page_versions WHERE page_id = $1', [pageId])).rows).toEqual([]);
  });
});
