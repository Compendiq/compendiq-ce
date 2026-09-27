import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type * as Undici from 'undici';
import { createClient, type RedisClientType } from 'redis';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mockUndiciRequest = vi.hoisted(() => vi.fn());
vi.mock('undici', async (importOriginal) => ({
  ...(await importOriginal<typeof Undici>()),
  request: mockUndiciRequest,
}));

import { query } from '../../core/db/postgres.js';
import { setRedisClient } from '../../core/services/redis-cache.js';
import { encryptPat } from '../../core/utils/crypto.js';
import { withPageWriteTransaction } from '../../core/services/page-write-admission.js';
import {
  isDbAvailable,
  setupTestDb,
  teardownTestDb,
  truncateAllTables,
} from '../../test-db-helper.js';
import { isRedisAvailable } from '../../test-redis-helper.js';
import {
  buildKnowledgeTestApp,
  insertConfluencePage,
  insertLocalSpace,
  insertStandalonePage,
  insertUser,
} from './pages.test-helpers.js';

const available = await isDbAvailable() && await isRedisAvailable();

function httpResponse(statusCode: number, body: unknown = '') {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    statusCode,
    headers: {},
    body: { text: vi.fn().mockResolvedValue(text) },
  };
}

async function rowForPage(id: number): Promise<{
  deleted_at: Date | null;
  labels: string[];
  title: string;
  body_html: string;
  image_analysis_dirty: boolean;
  embedding_dirty: boolean;
} | undefined> {
  return (
    await query<{
      deleted_at: Date | null;
      labels: string[];
      title: string;
      body_html: string;
      image_analysis_dirty: boolean;
      embedding_dirty: boolean;
    }>(
      `SELECT deleted_at, labels, title, body_html, image_analysis_dirty, embedding_dirty
         FROM pages WHERE id = $1`,
      [id],
    )
  ).rows[0];
}

async function auditMetadata(action: string): Promise<Record<string, unknown>[]> {
  const result = await query<{ metadata: Record<string, unknown> }>(
    'SELECT metadata FROM audit_log WHERE action = $1 ORDER BY created_at, id',
    [action],
  );
  return result.rows.map((row) => row.metadata);
}

async function assignSpace(userId: string, spaceKey: string): Promise<void> {
  const role = await query<{ id: number }>(
    `INSERT INTO roles (name, display_name, permissions)
     VALUES ($1, 'Bulk test editor', ARRAY['read', 'comment', 'edit', 'delete'])
     RETURNING id`,
    [`bulk-editor-${randomUUID()}`],
  );
  await query(
    `INSERT INTO space_role_assignments (space_key, principal_type, principal_id, role_id)
     VALUES ($1, 'user', $2, $3)`,
    [spaceKey, userId, role.rows[0]!.id],
  );
}

async function seedConfluencePage(
  confluenceId: string,
  title: string,
  labels: string[] = [],
): Promise<number> {
  const id = await insertConfluencePage(confluenceId, title, 'CONF');
  await query(
    `UPDATE pages
        SET labels = $2, body_html = '<p>old</p>', body_storage = '<p>old</p>',
            body_text = 'old', version = 1, image_analysis_dirty = FALSE
      WHERE id = $1`,
    [id, labels],
  );
  return id;
}

describe.skipIf(!available)('bulk page routes — real PostgreSQL and Redis', () => {
  let app: FastifyInstance;
  let redis: RedisClientType;
  let actorId: string;
  let otherUserId: string;
  let attachmentsDir: string;

  beforeAll(async () => {
    vi.stubEnv('PAT_ENCRYPTION_KEY', 'bulk-pages-test-encryption-key-at-least-32-bytes');
    attachmentsDir = await mkdtemp(join(tmpdir(), 'bulk-pages-real-'));
    vi.stubEnv('ATTACHMENTS_DIR', attachmentsDir);
    await setupTestDb();
    redis = createClient({
      url: process.env.REDIS_URL,
      socket: { reconnectStrategy: false, connectTimeout: 1_000 },
    });
    await redis.connect();
    setRedisClient(redis);
    app = await buildKnowledgeTestApp(() => actorId, async (instance) => {
      instance.redis = redis;
      // Attachment modules capture ATTACHMENTS_DIR at import time; defer this
      // known route module until the suite's filesystem sandbox exists.
      const { pagesCrudRoutes } = await import('./pages-crud.js');
      await instance.register(pagesCrudRoutes, { prefix: '/api' });
    });
  });

  afterAll(async () => {
    await app.close();
    if (redis.isOpen) await redis.quit();
    await teardownTestDb();
    await rm(attachmentsDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    await truncateAllTables();
    await redis.flushDb();
    actorId = await insertUser(`bulk-actor-${randomUUID()}`);
    otherUserId = await insertUser(`bulk-other-${randomUUID()}`);
    await insertLocalSpace('LOCAL', actorId);
    await query(
      `INSERT INTO spaces (space_key, space_name, source, last_synced)
       VALUES ('CONF', 'Confluence', 'confluence', NOW())`,
    );
    await assignSpace(actorId, 'CONF');
    await query(
      `INSERT INTO user_settings (user_id, confluence_url, confluence_pat, confluence_enabled)
       VALUES ($1, 'https://confluence.example.com', $2, TRUE)`,
      [actorId, encryptPat('bulk-test-pat')],
    );
    mockUndiciRequest.mockImplementation(async (url: string, options?: { method?: string }) => {
      const method = options?.method ?? 'GET';
      if (method === 'GET' && url.includes('/rest/api/content/')) {
        const encodedId = url.match(/\/rest\/api\/content\/([^?]+)/)?.[1] ?? 'unknown';
        const id = decodeURIComponent(encodedId);
        return httpResponse(200, {
          id,
          title: `Remote ${id}`,
          status: 'current',
          type: 'page',
          version: { number: 7, when: '2026-09-19T00:00:00.000Z' },
          body: { storage: { value: `<p>Remote ${id}</p>` } },
          ancestors: [],
          metadata: { labels: { results: [] } },
        });
      }
      return httpResponse(method === 'DELETE' ? 204 : 200, method === 'DELETE' ? '' : {});
    });
  });

  it('validates that a bulk selection is non-empty and uses exactly one selection mode', async () => {
    const empty = await app.inject({
      method: 'POST',
      url: '/api/pages/bulk/delete',
      payload: { ids: [] },
    });
    expect(empty.statusCode).toBe(400);

    const mixed = await app.inject({
      method: 'POST',
      url: '/api/pages/bulk/replace-tags',
      payload: {
        ids: ['1'],
        filter: { spaceKey: 'CONF' },
        expectedCount: 1,
        tags: ['x'],
      },
    });
    expect(mixed.statusCode).toBe(400);
  });

  it('deletes authorized mixed-source rows, rejects a non-owner, reports missing IDs, and invalidates every user cache', async () => {
    const owned = await insertStandalonePage('Owned', 'private', actorId, 'LOCAL');
    const notOwned = await insertStandalonePage('Shared by another user', 'shared', otherUserId, 'LOCAL');
    const synced = await seedConfluencePage('conf-delete', 'Synced');
    await redis.set('kb:alice:pages:list', 'stale');
    await redis.set('kb:bob:spaces:list', 'stale');

    const response = await app.inject({
      method: 'POST',
      url: '/api/pages/bulk/delete',
      payload: { ids: [String(owned), String(notOwned), 'conf-delete', 'missing'] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ succeeded: 2, failed: 2 });
    expect(response.json().errors).toEqual(expect.arrayContaining([
      expect.stringContaining('not the owner'),
      expect.stringContaining('missing'),
    ]));
    expect((await rowForPage(owned))?.deleted_at).toBeInstanceOf(Date);
    expect((await rowForPage(notOwned))?.deleted_at).toBeNull();
    expect(await rowForPage(synced)).toBeUndefined();
    expect(await redis.exists('kb:alice:pages:list')).toBe(0);
    expect(await redis.exists('kb:bob:spaces:list')).toBe(0);

    const audits = await auditMetadata('PAGE_DELETED');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ affectedCount: 3, succeeded: 2, failed: 2 });
  });

  it('keeps independently failed Confluence deletes recoverable while successful components finish', async () => {
    const goodId = await seedConfluencePage('delete-good', 'Good');
    const badId = await seedConfluencePage('delete-bad', 'Bad');
    mockUndiciRequest.mockImplementation(async (url: string, options?: { method?: string }) => {
      if ((options?.method ?? 'GET') === 'DELETE' && url.endsWith('/delete-bad')) {
        return httpResponse(400, { message: 'remote policy denied deletion' });
      }
      return httpResponse(204);
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/pages/bulk/delete',
      payload: { ids: ['delete-good', 'delete-bad'] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ succeeded: 1, failed: 1 });
    expect(response.json().errors[0]).toContain('remote policy denied deletion');
    expect(await rowForPage(goodId)).toBeUndefined();
    expect((await rowForPage(badId))?.deleted_at).toBeInstanceOf(Date);
    const unresolved = await query<{ page_id: number }>(
      `SELECT unnest(page_ids) AS page_id
         FROM page_write_intents
        WHERE settled_at IS NULL`,
    );
    expect(unresolved.rows.map((row) => row.page_id)).toContain(badId);
  });

  it('treats an upstream 404 as an already-completed delete and reports missing credentials per page', async () => {
    const alreadyGone = await seedConfluencePage('already-gone', 'Already gone');
    mockUndiciRequest.mockResolvedValueOnce(httpResponse(404, { message: 'missing' }));

    const removed = await app.inject({
      method: 'POST',
      url: '/api/pages/bulk/delete',
      payload: { ids: ['already-gone'] },
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toMatchObject({ succeeded: 1, failed: 0 });
    expect(await rowForPage(alreadyGone)).toBeUndefined();

    const unconfigured = await seedConfluencePage('no-client', 'No client');
    await query(
      'UPDATE user_settings SET confluence_url = NULL, confluence_pat = NULL WHERE user_id = $1',
      [actorId],
    );
    const refused = await app.inject({
      method: 'POST',
      url: '/api/pages/bulk/delete',
      payload: { ids: ['no-client'] },
    });
    expect(refused.statusCode).toBe(200);
    expect(refused.json()).toMatchObject({ succeeded: 0, failed: 1 });
    expect(refused.json().errors[0]).toContain('Confluence not configured');
    expect((await rowForPage(unconfigured))?.deleted_at).toBeNull();
  });

  it('deletes Confluence-sourced rows only locally when integration is disabled', async () => {
    const pageId = await seedConfluencePage('local-only-delete', 'Local only');
    await query('UPDATE user_settings SET confluence_enabled = FALSE WHERE user_id = $1', [actorId]);

    const response = await app.inject({
      method: 'POST',
      url: '/api/pages/bulk/delete',
      payload: { ids: ['local-only-delete'] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ succeeded: 1, failed: 0 });
    expect(await rowForPage(pageId)).toBeUndefined();
    expect(mockUndiciRequest).not.toHaveBeenCalled();
  });

  it('re-syncs authorized rows independently and persists the successful remote representation', async () => {
    const goodId = await seedConfluencePage('sync-good', 'Old good');
    const badId = await seedConfluencePage('sync-bad', 'Old bad');
    mockUndiciRequest.mockImplementation(async (url: string) => {
      if (url.includes('/sync-bad?')) return httpResponse(400, { message: 'unreadable upstream page' });
      return httpResponse(200, {
        id: 'sync-good',
        title: 'Remote good',
        status: 'current',
        type: 'page',
        version: { number: 9, when: '2026-09-19T00:00:00.000Z' },
        body: { storage: { value: '<p>Fresh body</p>' } },
        ancestors: [],
        metadata: { labels: { results: [] } },
      });
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/pages/bulk/sync',
      payload: { ids: ['sync-good', 'sync-bad', 'not-found'] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ succeeded: 1, failed: 2 });
    expect(response.json().errors).toEqual(expect.arrayContaining([
      expect.stringContaining('sync-bad'),
      expect.stringContaining('not-found'),
    ]));
    expect(await rowForPage(goodId)).toMatchObject({
      title: 'Remote good',
      body_html: '<p>Fresh body</p>',
      image_analysis_dirty: true,
    });
    expect(await rowForPage(badId)).toMatchObject({ title: 'Old bad', body_html: '<p>old</p>' });

    mockUndiciRequest.mockResolvedValue(httpResponse(200, {
      id: 'sync-bad',
      title: 'Recovered upstream page',
      status: 'current',
      type: 'page',
      version: { number: 2 },
      body: { storage: { value: '<p>Recovered body</p>' } },
      ancestors: [],
      metadata: { labels: { results: [] } },
    }));
    const retry = await app.inject({
      method: 'POST',
      url: '/api/pages/bulk/sync',
      payload: { ids: ['sync-bad'] },
    });
    expect(retry.json()).toMatchObject({ succeeded: 1, failed: 0 });
    expect(await rowForPage(badId)).toMatchObject({
      title: 'Recovered upstream page',
      body_html: '<p>Recovered body</p>',
    });
  });

  it.each(['content', 'authority'] as const)(
    'does not apply a sync response after %s changes during the upstream read',
    async (change) => {
      const pageId = await seedConfluencePage('sync-race', 'Original page');
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      mockUndiciRequest.mockImplementationOnce(async () => {
        started.resolve();
        await release.promise;
        return httpResponse(200, {
          id: 'sync-race',
          title: 'Stale upstream page',
          status: 'current',
          type: 'page',
          version: { number: 9 },
          body: { storage: { value: '<p>Stale upstream body</p>' } },
          ancestors: [],
          metadata: { labels: { results: [] } },
        });
      });
      const pending = app.inject({
        method: 'POST',
        url: '/api/pages/bulk/sync',
        payload: { ids: ['sync-race'] },
      });
      try {
        await started.promise;
        if (change === 'content') {
          await withPageWriteTransaction([pageId], (client) => client.query(
            'UPDATE pages SET body_html = $2 WHERE id = $1',
            [pageId, '<p>New local content</p>'],
          ));
        } else {
          await query('UPDATE users SET deactivated_at = NOW() WHERE id = $1', [actorId]);
        }
      } finally {
        release.resolve();
      }
      const response = await pending;
      expect(response.json()).toMatchObject({ succeeded: 0, failed: 1 });
      expect(await rowForPage(pageId)).toMatchObject({
        title: 'Original page',
        body_html: change === 'content' ? '<p>New local content</p>' : '<p>old</p>',
      });
    },
  );

  it('refuses sync before external HTTP when Confluence integration is disabled', async () => {
    await seedConfluencePage('sync-disabled', 'Disabled');
    await query('UPDATE user_settings SET confluence_enabled = FALSE WHERE user_id = $1', [actorId]);

    const response = await app.inject({
      method: 'POST',
      url: '/api/pages/bulk/sync',
      payload: { ids: ['sync-disabled'] },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain('Confluence integration is disabled');
    expect(mockUndiciRequest).not.toHaveBeenCalled();
  });

  it('marks real rows for embedding and quality work without widening the caller-visible selection', async () => {
    const confluence = await seedConfluencePage('reprocess-me', 'Reprocess');
    const standalone = await insertStandalonePage('Standalone quality', 'private', actorId, 'LOCAL');
    await query(
      `UPDATE pages
          SET embedding_dirty = FALSE, quality_status = 'analyzed',
              quality_score = 95, quality_error = 'old', quality_retry_count = 3
        WHERE id = ANY($1::int[])`,
      [[confluence, standalone]],
    );

    // The route must still enqueue through the real embedding service. Hold an
    // unrelated production lease so that global scanner backs off immediately
    // after the route mutation, without replacing the worker with a test fake.
    await redis.set('embedding:lock:other-bulk-test-user', 'other-runtime', { EX: 60 });
    await redis.sAdd('embedding:locks:active', 'other-bulk-test-user');

    const embed = await app.inject({
      method: 'POST',
      url: '/api/pages/bulk/embed',
      payload: { ids: ['reprocess-me', 'not-found'] },
    });
    expect(embed.statusCode).toBe(200);
    expect(embed.json()).toMatchObject({ succeeded: 1, failed: 1 });
    expect(await rowForPage(confluence)).toMatchObject({ title: 'Reprocess', embedding_dirty: true });
    await expect.poll(() => redis.exists(`embedding:lock:${actorId}`)).toBe(0);

    // Keep the actual worker from racing the route-level mutation assertion.
    // Its distributed lease is the production exclusion mechanism, not a mock.
    await redis.set('worker:lock:quality-worker', 'another-runtime', { EX: 60 });
    const quality = await app.inject({
      method: 'POST',
      url: '/api/pages/bulk/quality',
      payload: { ids: ['reprocess-me', String(standalone)] },
    });
    expect(quality.statusCode).toBe(200);
    expect(quality.json()).toMatchObject({ succeeded: 2, failed: 0 });
    const qualityRows = await query<{
      id: number;
      quality_status: string;
      quality_score: number | null;
      quality_error: string | null;
      quality_retry_count: number;
    }>(
      `SELECT id, quality_status, quality_score, quality_error, quality_retry_count
         FROM pages WHERE id = ANY($1::int[]) ORDER BY id`,
      [[confluence, standalone]],
    );
    expect(qualityRows.rows).toEqual([
      {
        id: Math.min(confluence, standalone),
        quality_status: 'pending',
        quality_score: null,
        quality_error: null,
        quality_retry_count: 0,
      },
      {
        id: Math.max(confluence, standalone),
        quality_status: 'pending',
        quality_score: null,
        quality_error: null,
        quality_retry_count: 0,
      },
    ]);
  });

  it('applies additive and replacement label semantics to real rows and records one audit event per request', async () => {
    const standalone = await insertStandalonePage('Labels', 'private', actorId, 'LOCAL');
    await query('UPDATE pages SET labels = ARRAY[$2, $3] WHERE id = $1', [standalone, 'old', 'keep']);

    const additive = await app.inject({
      method: 'POST',
      url: '/api/pages/bulk/tag',
      payload: { ids: [String(standalone)], addTags: ['new', 'keep'], removeTags: ['old'] },
    });
    expect(additive.statusCode).toBe(200);
    expect(additive.json()).toMatchObject({ succeeded: 1, failed: 0 });
    expect((await rowForPage(standalone))?.labels).toEqual(['keep', 'new']);

    const replacement = await app.inject({
      method: 'POST',
      url: '/api/pages/bulk/replace-tags',
      payload: { ids: [String(standalone)], tags: ['  Alpha ', 'alpha', 'BETA'] },
    });
    expect(replacement.statusCode).toBe(200);
    expect(replacement.json()).toMatchObject({ succeeded: 1, failed: 0, cancelled: false });
    expect((await rowForPage(standalone))?.labels).toEqual(['alpha', 'beta']);
    expect(await auditMetadata('BULK_PAGE_TAGGED')).toHaveLength(1);
    expect(await auditMetadata('BULK_PAGE_TAGS_REPLACED')).toHaveLength(1);
  });

  it('reports independent remote-label failure, keeps the local original, and leaves the uncertain row pending', async () => {
    const goodId = await seedConfluencePage('labels-good', 'Good', ['old']);
    const badId = await seedConfluencePage('labels-bad', 'Bad', ['old']);
    mockUndiciRequest.mockImplementation(async (url: string, options?: { method?: string }) => {
      if ((options?.method ?? 'GET') === 'POST' && url.includes('/labels-bad/label')) {
        return httpResponse(400, { message: 'labels rejected upstream' });
      }
      return httpResponse(200, {});
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/pages/bulk/tag',
      payload: { ids: [String(goodId), String(badId)], addTags: ['new'] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ succeeded: 1, failed: 1 });
    expect(response.json().errors[0]).toContain('labels rejected upstream');
    expect((await rowForPage(goodId))?.labels).toEqual(['old', 'new']);
    expect((await rowForPage(badId))?.labels).toEqual(['old']);
    const pending = await query<{ page_ids: number[] }>(
      'SELECT page_ids FROM page_write_intents WHERE settled_at IS NULL',
    );
    expect(pending.rows.some((row) => row.page_ids.includes(badId))).toBe(true);
  });

  it('resolves filter-mode against the caller-visible set and rejects stale expected counts', async () => {
    const matchingA = await insertStandalonePage('A', 'private', actorId, 'LOCAL');
    const matchingB = await insertStandalonePage('B', 'private', actorId, 'LOCAL');
    const hidden = await insertStandalonePage('Hidden', 'private', otherUserId, 'LOCAL');

    const applied = await app.inject({
      method: 'POST',
      url: '/api/pages/bulk/replace-tags',
      payload: {
        filter: { spaceKey: 'LOCAL', source: 'standalone' },
        expectedCount: 2,
        driftToleranceFraction: 0,
        tags: ['filtered'],
      },
    });
    expect(applied.statusCode).toBe(200);
    expect(applied.json()).toMatchObject({ succeeded: 2, failed: 0 });
    expect((await rowForPage(matchingA))?.labels).toEqual(['filtered']);
    expect((await rowForPage(matchingB))?.labels).toEqual(['filtered']);
    expect((await rowForPage(hidden))?.labels).toEqual([]);

    const drift = await app.inject({
      method: 'POST',
      url: '/api/pages/bulk/replace-tags',
      payload: {
        filter: { spaceKey: 'LOCAL', source: 'standalone' },
        expectedCount: 20,
        driftToleranceFraction: 0,
        tags: ['must-not-apply'],
      },
    });
    expect(drift.statusCode).toBe(409);
    expect(drift.json()).toMatchObject({ error: 'CountDrift', expected: 20, actual: 2 });
    expect((await rowForPage(matchingA))?.labels).toEqual(['filtered']);
  });

  it('does not expose or mutate a Confluence page outside the caller space assignment', async () => {
    await query(
      `INSERT INTO spaces (space_key, space_name, source, last_synced)
       VALUES ('SECRET', 'Secret', 'confluence', NOW())`,
    );
    const secret = await insertConfluencePage('secret-page', 'Secret', 'SECRET');

    const response = await app.inject({
      method: 'POST',
      url: '/api/pages/bulk/replace-tags',
      payload: { ids: [String(secret)], tags: ['leak'] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ succeeded: 0, failed: 1 });
    expect(response.json().errors[0]).toContain('not found');
    expect((await rowForPage(secret))?.labels).toEqual([]);
  });
});
