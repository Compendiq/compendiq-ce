import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { createClient, type RedisClientType } from 'redis';
import type * as Undici from 'undici';

// #780: mock undici at the HTTP boundary ONLY — `request` is what the
// ConfluenceClient uses for every REST call. Everything else (Agent for
// tls-config, etc.) stays real, as does the entire DB path.
vi.mock('undici', async (importOriginal) => ({
  ...(await importOriginal<typeof Undici>()),
  request: vi.fn(),
}));

import { request } from 'undici';
import {
  setupTestDb,
  truncateAllTables,
  teardownTestDb,
  isDbAvailable,
} from '../../test-db-helper.js';
import { isRedisAvailable } from '../../test-redis-helper.js';
import { query } from '../../core/db/postgres.js';
import { encryptPat } from '../../core/utils/crypto.js';
import { setRedisClient } from '../../core/services/redis-cache.js';
import { flushPageWriteInvalidations } from '../../core/services/page-write-invalidation.js';
import { pagesVersionRoutes } from './pages-versions.js';

const mockRequest = vi.mocked(request);

/**
 * #780 reproduction: GET /api/pages/:id/versions on a Confluence DC page with a
 * long edit history must return EVERY version (current + all historical),
 * newest-first — not just the synthetic current row.
 *
 * Only the Confluence HTTP boundary (undici `request`) is mocked, simulating a
 * real Confluence DATA CENTER instance:
 *   - `GET /rest/experimental/content/{id}/version` → the full paginated list
 *     (this is the only place DC serves the version list);
 *   - `GET /rest/api/content/{id}/version`          → 404 (on DC that path has
 *     no GET collection — only DELETE of a single version exists).
 *
 * Credentials, PAT decryption, RBAC, page resolution, the backfill upserts and
 * the history read all run against the real test Postgres.
 */

const [dbAvailable, redisAvailable] = await Promise.all([
  isDbAvailable(),
  isRedisAvailable(),
]);

function jsonResponse(data: unknown, statusCode = 200) {
  return {
    statusCode,
    headers: {},
    body: { text: async () => JSON.stringify(data) },
  } as never;
}

/** Build `count` Confluence version entries, newest-first starting at `from`. */
function versionEntries(from: number, count: number) {
  return Array.from({ length: count }, (_, i) => ({
    number: from - i,
    when: `2026-01-01T00:00:${String((from - i) % 60).padStart(2, '0')}Z`,
    by: { displayName: `author-${from - i}` },
    message: `edit ${from - i}`,
    minorEdit: false,
  }));
}

describe.skipIf(!dbAvailable || !redisAvailable)('page versions against Confluence DC with real PostgreSQL and Redis', () => {
  let app: FastifyInstance;
  let redis: RedisClientType;
  let userId = '';
  const ownedPageIds = new Set<number>();
  const ownedRedisKeys = new Set<string>();

  beforeAll(async () => {
    await setupTestDb();
    redis = createClient({
      url: process.env.REDIS_URL,
      socket: { reconnectStrategy: false },
    });
    await redis.connect();
    setRedisClient(redis);
    app = Fastify({ logger: false });
    await app.register(sensible);
    app.decorate('authenticate', async (request: { userId: string }) => {
      request.userId = userId;
    });
    app.decorate('redis', redis);
    app.decorateRequest('userId', '');
    await app.register(pagesVersionRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await redis.quit();
    await teardownTestDb();
  });

  beforeEach(async () => {
    await truncateAllTables();
    mockRequest.mockReset();
    ownedPageIds.clear();
    ownedRedisKeys.clear();
    const u = await query<{ id: string }>(
      `INSERT INTO users (username, password_hash, role)
       VALUES ('versions_780_admin', 'fakehash', 'admin') RETURNING id`,
    );
    userId = u.rows[0]!.id;
    await query(`INSERT INTO spaces (space_key, space_name) VALUES ('DEV', 'Dev space')`);
    await query(
      `INSERT INTO user_settings (user_id, confluence_url, confluence_pat)
       VALUES ($1, 'https://confluence.example.com', $2)`,
      [userId, encryptPat('test-pat-780')],
    );
  });

  afterEach(async () => {
    await flushPageWriteInvalidations();
    const keys = [
      `rbac:admin:${userId}`,
      `rbac:spaces:${userId}`,
      `rbac:global:${userId}`,
      ...ownedRedisKeys,
      ...[...ownedPageIds].map((pageId) => `collab:active:${pageId}`),
    ];
    await redis.del(keys);
  });

  async function seedConfluencePage(confluenceId: string, version: number): Promise<number> {
    const res = await query<{ id: number }>(
      `INSERT INTO pages (confluence_id, space_key, title, body_html, body_text, version, source, last_modified_at, embedding_dirty, embedding_status)
       VALUES ($1, 'DEV', 'Page 780', '<p>live</p>', 'live', $2, 'confluence', NOW(), FALSE, 'not_embedded')
       RETURNING id`,
      [confluenceId, version],
    );
    ownedPageIds.add(res.rows[0]!.id);
    return res.rows[0]!.id;
  }

  /**
   * Simulate a Confluence DATA CENTER instance for one page id:
   * version list only at the experimental path (paginated), 404 on the
   * Cloud-style stable path.
   */
  function mockDataCenter(confluenceId: string, totalVersions: number, pageSize = 100) {
    mockRequest.mockImplementation(async (rawUrl) => {
      const url = new URL(String(rawUrl));
      if (url.pathname === `/rest/experimental/content/${confluenceId}/version`) {
        const start = Number(url.searchParams.get('start') ?? '0');
        const limit = Number(url.searchParams.get('limit') ?? String(pageSize));
        const remaining = Math.max(0, totalVersions - start);
        const count = Math.min(limit, remaining, pageSize);
        const results = versionEntries(totalVersions - start, count);
        const hasMore = start + count < totalVersions;
        return jsonResponse({
          results,
          start,
          limit,
          size: results.length,
          _links: hasMore ? { next: `/rest/experimental/content/${confluenceId}/version?start=${start + count}` } : {},
        });
      }
      if (url.pathname === `/rest/api/content/${confluenceId}/version`) {
        // DC: no GET on the stable path — only DELETE of a single version.
        return jsonResponse({ message: 'No resource and method matched' }, 404);
      }
      throw new Error(`Unexpected Confluence request in test: ${String(rawUrl)}`);
    });
  }

  it('returns ALL versions of a multi-version DC page, newest-first, with backfillStatus ok', async () => {
    // 120 versions → exercises pagination (100 + 20) at the HTTP boundary.
    const total = 120;
    const pageId = await seedConfluencePage('780123', total);
    mockDataCenter('780123', total);

    const r = await app.inject({ method: 'GET', url: `/api/pages/${pageId}/versions` });

    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.backfillStatus).toBe('ok');
    expect(body.backfillDetail).toBeUndefined();

    // Complete history: the synthetic current row + every historical version.
    expect(body.versions).toHaveLength(total);
    const numbers = body.versions.map((v: { versionNumber: number }) => v.versionNumber);
    expect(numbers).toEqual(Array.from({ length: total }, (_, i) => total - i)); // 120..1, newest-first

    // The live version appears exactly once (the backfilled duplicate of the
    // current version number is dropped in favour of the synthetic row).
    expect(numbers.filter((n: number) => n === total)).toHaveLength(1);
    expect(body.versions[0]).toMatchObject({ versionNumber: total, isCurrent: true });
    expect(body.versions[1]).toMatchObject({
      versionNumber: total - 1,
      isCurrent: false,
      author: `author-${total - 1}`,
      message: `edit ${total - 1}`,
    });

    // The import persisted to the real DB (all 120 metadata rows).
    const db = await query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM page_versions WHERE page_id = $1',
      [pageId],
    );
    expect(Number(db.rows[0]!.count)).toBe(total);
  });

  it('publishes a sparse successful restore response from the submitted representation without leaving recovery work', async () => {
    const pageId = await seedConfluencePage('780restore', 5);
    await query(
      `UPDATE pages
          SET title = 'Live before restore',
              body_storage = '<p>live</p>',
              body_html = '<p>live</p>',
              body_text = 'live'
        WHERE id = $1`,
      [pageId],
    );
    await query(
      `INSERT INTO page_versions
         (page_id, version_number, title, body_html, body_text)
       VALUES ($1, 2, 'Restored title', '<p>restored</p>', 'restored')`,
      [pageId],
    );
    const pageCacheKey = `kb:${userId}:pages:versions-route`;
    const searchCacheKey = `kb:${userId}:search:versions-route`;
    const unrelatedCacheKey = `versions-route:${userId}:unrelated`;
    ownedRedisKeys.add(pageCacheKey);
    ownedRedisKeys.add(searchCacheKey);
    ownedRedisKeys.add(unrelatedCacheKey);
    await redis.mSet({
      [pageCacheKey]: 'stale page cache',
      [searchCacheKey]: 'stale search cache',
      [unrelatedCacheKey]: 'keep',
    });
    let submittedStorage = '';
    mockRequest.mockImplementation(async (rawUrl, options) => {
      const url = new URL(String(rawUrl));
      if (
        url.pathname === '/rest/api/content/780restore'
        && options?.method === 'PUT'
      ) {
        const sent = JSON.parse(String(options.body)) as {
          title: string;
          version: { number: number };
          body: { storage: { value: string } };
        };
        submittedStorage = sent.body.storage.value;
        expect(sent).toMatchObject({
          title: 'Restored title',
          version: { number: 6 },
          body: {
            storage: {
              representation: 'storage',
            },
          },
        });
        expect(submittedStorage).toContain('restored');
        // Confluence DC may omit the optional body.storage expansion on a
        // successful PUT. The accepted version and submitted representation
        // are still sufficient for ordinary publication.
        return jsonResponse({
          id: '780restore',
          title: sent.title,
          version: sent.version,
        });
      }
      throw new Error(`Unexpected Confluence request in restore test: ${String(rawUrl)}`);
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/pages/${pageId}/versions/2/restore`,
      payload: { version: 5 },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      id: pageId,
      title: 'Restored title',
      version: 6,
      restoredFrom: 2,
      pushedToConfluence: true,
    });
    expect(await redis.mGet([pageCacheKey, searchCacheKey, unrelatedCacheKey]))
      .toEqual([null, null, 'keep']);
    const page = await query<{
      title: string;
      body_storage: string;
      body_html: string;
      body_text: string;
      version: number;
      embedding_dirty: boolean;
    }>(
      `SELECT title, body_storage, body_html, body_text, version, embedding_dirty
         FROM pages WHERE id = $1`,
      [pageId],
    );
    expect(page.rows[0]).toEqual({
      title: 'Restored title',
      body_storage: submittedStorage,
      body_html: '<p>restored</p>',
      body_text: 'restored',
      version: 6,
      embedding_dirty: true,
    });
    const snapshot = await query<{
      title: string;
      body_html: string;
      body_text: string;
    }>(
      `SELECT title, body_html, body_text
         FROM page_versions
        WHERE page_id = $1 AND version_number = 5`,
      [pageId],
    );
    expect(snapshot.rows[0]).toEqual({
      title: 'Live before restore',
      body_html: '<p>live</p>',
      body_text: 'live',
    });
    const intent = await query<{
      status: string;
      effect: Record<string, unknown>;
      remote_effect_started_at: Date | null;
      remote_effects_completed_at: Date | null;
      cache_invalidation_pending: boolean;
    }>(
      `SELECT status, effect, remote_effect_started_at, remote_effects_completed_at,
              cache_invalidation_pending
         FROM page_write_intents
        WHERE kind = 'page.version_restore' AND page_ids = ARRAY[$1]::integer[]`,
      [pageId],
    );
    expect(intent.rows[0]).toEqual({
      status: 'completed',
      effect: {
        effectClass: 'remote',
        pageId,
        confluenceId: '780restore',
        expectedRemoteVersion: '5',
        intendedStateDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        targetVersion: 2,
      },
      remote_effect_started_at: expect.any(Date),
      remote_effects_completed_at: expect.any(Date),
      cache_invalidation_pending: false,
    });
    expect(JSON.stringify(intent.rows[0]!.effect)).not.toContain('Restored title');
    expect(JSON.stringify(intent.rows[0]!.effect)).not.toContain('<p>restored</p>');
    expect((await query(
      `SELECT id FROM page_write_intents
        WHERE status = 'pending' AND page_ids @> ARRAY[$1]::integer[]`,
      [pageId],
    )).rows).toEqual([]);
  });

  it('lazily fetches and persists a metadata-only historical body through the external HTTP boundary', async () => {
    const pageId = await seedConfluencePage('780detail', 5);
    await query(
      `INSERT INTO page_versions
         (page_id, version_number, title, body_html, body_text)
       VALUES ($1, 2, 'Historical detail', NULL, NULL)`,
      [pageId],
    );
    mockRequest.mockImplementation(async (rawUrl, options) => {
      const url = new URL(String(rawUrl));
      if (
        url.pathname === '/rest/api/content/780detail'
        && url.searchParams.get('status') === 'historical'
        && url.searchParams.get('version') === '2'
        && options?.method === 'GET'
      ) {
        return jsonResponse({
          id: '780detail',
          title: 'Historical detail',
          version: { number: 2 },
          body: { storage: { value: '<p>Historical <strong>body</strong></p>' } },
        });
      }
      throw new Error(`Unexpected Confluence request in detail test: ${String(rawUrl)}`);
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/pages/${pageId}/versions/2`,
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      versionNumber: 2,
      title: 'Historical detail',
      bodyHtml: '<p>Historical <strong>body</strong></p>',
      bodyText: 'Historical body',
      isCurrent: false,
    });
    expect((await query(
      `SELECT body_html, body_text FROM page_versions
        WHERE page_id = $1 AND version_number = 2`,
      [pageId],
    )).rows).toEqual([{
      body_html: '<p>Historical <strong>body</strong></p>',
      body_text: 'Historical body',
    }]);
  });

  it('retains an unresolved intent and unchanged local state when the remote restore fails', async () => {
    const pageId = await seedConfluencePage('780unknown', 5);
    await query(
      `UPDATE pages
          SET title = 'Live before failure',
              body_storage = '<p>live before failure</p>',
              body_html = '<p>live before failure</p>',
              body_text = 'live before failure'
        WHERE id = $1`,
      [pageId],
    );
    await query(
      `INSERT INTO page_versions
         (page_id, version_number, title, body_html, body_text)
       VALUES ($1, 2, 'Unpublished target', '<p>unpublished target</p>', 'unpublished target')`,
      [pageId],
    );
    mockRequest.mockImplementation(async (rawUrl, options) => {
      const url = new URL(String(rawUrl));
      if (url.pathname === '/rest/api/content/780unknown' && options?.method === 'PUT') {
        return jsonResponse({ message: 'provider failed after accepting the request' }, 500);
      }
      throw new Error(`Unexpected Confluence request in failed restore test: ${String(rawUrl)}`);
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/pages/${pageId}/versions/2/restore`,
      payload: { version: 5 },
    });

    expect(response.statusCode).toBe(500);
    expect((await query(
      'SELECT title, body_storage, body_html, body_text, version FROM pages WHERE id = $1',
      [pageId],
    )).rows).toEqual([{
      title: 'Live before failure',
      body_storage: '<p>live before failure</p>',
      body_html: '<p>live before failure</p>',
      body_text: 'live before failure',
      version: 5,
    }]);
    expect((await query<{
      status: string;
      remote_effect_started_at: Date | null;
      remote_effects_completed_at: Date | null;
      cache_invalidation_pending: boolean;
    }>(
      `SELECT status, remote_effect_started_at, remote_effects_completed_at,
              cache_invalidation_pending
         FROM page_write_intents
        WHERE kind = 'page.version_restore' AND page_ids = ARRAY[$1]::integer[]`,
      [pageId],
    )).rows).toEqual([{
      status: 'pending',
      remote_effect_started_at: expect.any(Date),
      remote_effects_completed_at: null,
      cache_invalidation_pending: false,
    }]);
    expect((await query(
      `SELECT action FROM audit_log
        WHERE action = 'PAGE_VERSION_RESTORED' AND resource_id = $1`,
      [String(pageId)],
    )).rows).toEqual([]);
  });

  it('surfaces a "failed" status with the underlying reason when no version endpoint exists at all', async () => {
    const pageId = await seedConfluencePage('780404', 3);
    // Neither path is served (e.g. a proxy stripping /rest) — both 404.
    mockRequest.mockImplementation(async () => jsonResponse({ message: 'nope' }, 404));

    const r = await app.inject({ method: 'GET', url: `/api/pages/${pageId}/versions` });

    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.backfillStatus).toBe('failed');
    // #780: the dialog must show WHY the import failed (the underlying
    // Confluence error), not only a bare generic hint.
    expect(body.backfillDetail).toMatch(/incomplete/i);
    expect(body.backfillDetail).toMatch(/404/);
    // PR #784 review: the reason is sanitized for the dialog — single-line.
    expect(body.backfillDetail).not.toMatch(/\n/);
    expect(body.versions).toHaveLength(1);
    expect(body.versions[0]).toMatchObject({ versionNumber: 3, isCurrent: true });
  });
});
