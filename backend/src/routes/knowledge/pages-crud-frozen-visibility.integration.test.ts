import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
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
import { getPool, query } from '../../core/db/postgres.js';
import { lockPageLifecycle } from '../../core/services/page-write-admission.js';
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


const dbAvailable = await isDbAvailable();
let app: FastifyInstance;
let userId: string;
let pageId: number;
let redis: RedisClientType;
let attachmentsDir: string;


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

describe.skipIf(!dbAvailable)('frozen page visibility admission — real PostgreSQL', () => {
  beforeAll(async () => {
    await setupTestDb();
    attachmentsDir = await mkdtemp(join(tmpdir(), 'frozen-visibility-'));
    vi.stubEnv('ATTACHMENTS_DIR', attachmentsDir);
    redis = createClient({ url: process.env.REDIS_URL, socket: { reconnectStrategy: false } });
    await redis.connect();
    setRedisClient(redis);
    app = await buildKnowledgeTestApp(() => userId, async (instance) => {
      instance.redis = redis;
      const { pagesCrudRoutes } = await import('./pages-crud.js');
      await instance.register(pagesCrudRoutes, { prefix: '/api' });
    });
  });

  afterAll(async () => {
    await app.close();
    setPageBaselineReadinessProvider(null);
    await redis.quit();
    await teardownTestDb();
    await rm(attachmentsDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  beforeEach(async () => {
    await truncateAllTables();
    setPageBaselineReadinessProvider(async () => ({ ready: true, blockers: [] }));
    const admin = await insertUser(`baseline-admin-${randomUUID()}`);
    await query("UPDATE users SET role = 'admin' WHERE id = $1", [admin]);
    await query(
      `INSERT INTO user_settings (user_id, confluence_enabled)
       VALUES ($1, FALSE)`,
      [admin],
    );
    await setPageBaselineCreationEnabled(admin, true);
    userId = await insertUser(`frozen-visibility-${randomUUID()}`);
    await query(
      `INSERT INTO user_settings (user_id, confluence_enabled)
       VALUES ($1, FALSE)`,
      [userId],
    );
    await insertLocalSpace('NOTES', userId);
    pageId = await insertStandalonePage('Frozen', 'private', userId, 'NOTES');
    const prepared = await previewPageBaseline(pageId, userId);
    await freezePage({
      pageId,
      actorId: userId,
      reason: 'Approved evidence',
      expectedContentRevision: prepared.contentRevision,
      expectedManifestDigest: prepared.manifestDigest,
      reportedSignatories: [],
    });
  });

  it('projects rendering-only frozen HTML without replacing authored bodyHtml', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/pages/${pageId}`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.bodyHtml).toBe('<p>x</p>');
    expect(body.renderedBodyHtml).toBe('<p>x</p>');
  });

  it('allows a visibility-only delta without rewriting the protected payload', async () => {
    const before = await query<{
      version: number;
      content_revision: string;
      body_html: string;
    }>(
      'SELECT version, content_revision::text, body_html FROM pages WHERE id = $1',
      [pageId],
    );

    const response = await app.inject({
      method: 'PUT',
      url: `/api/pages/${pageId}`,
      payload: {
        title: 'Frozen',
        bodyHtml: '<p>x</p>',
        version: 1,
        visibility: 'shared',
      },
    });

    expect(response.statusCode).toBe(200);
    const after = await query<{
      visibility: string;
      version: number;
      content_revision: string;
      body_html: string;
    }>(
      'SELECT visibility, version, content_revision::text, body_html FROM pages WHERE id = $1',
      [pageId],
    );
    expect(after.rows[0]).toEqual({
      visibility: 'shared',
      version: before.rows[0]!.version,
      content_revision: before.rows[0]!.content_revision,
      body_html: before.rows[0]!.body_html,
    });
  });

  it('rejects changed protected bytes even when the request also changes visibility', async () => {
    await query("UPDATE pages SET visibility = 'shared' WHERE id = $1", [pageId]);

    const response = await app.inject({
      method: 'PUT',
      url: `/api/pages/${pageId}`,
      payload: {
        title: 'Frozen',
        bodyHtml: '<p>changed</p>',
        version: 1,
        visibility: 'private',
      },
    });

    expect(response.statusCode).toBe(423);
    const persisted = await query<{ visibility: string; body_html: string }>(
      'SELECT visibility, body_html FROM pages WHERE id = $1',
      [pageId],
    );
    expect(persisted.rows[0]).toEqual({ visibility: 'shared', body_html: '<p>x</p>' });
  });


  it('rejects a stale shared-page writer after the owner makes the page private under the lock', async () => {
    await query("UPDATE pages SET visibility = 'shared' WHERE id = $1", [pageId]);
    const staleUserId = await insertUser(`stale-visibility-${randomUUID()}`);
    userId = staleUserId;

    const blocker = await getPool().connect();
    await blocker.query('BEGIN');
    await lockPageLifecycle(blocker, [pageId]);
    try {
      const staleWrite = app.inject({
        method: 'PUT',
        url: `/api/pages/${pageId}`,
        payload: {
          title: 'Frozen',
          bodyHtml: '<p>x</p>',
          version: 1,
          visibility: 'shared',
        },
      });
      await waitForBlockedLifecycleLock();

      await blocker.query("UPDATE pages SET visibility = 'private' WHERE id = $1", [pageId]);
      await blocker.query('COMMIT');

      const response = await staleWrite;
      expect(response.statusCode).toBe(403);
      const persisted = await query<{ visibility: string }>(
        'SELECT visibility FROM pages WHERE id = $1',
        [pageId],
      );
      expect(persisted.rows[0]?.visibility).toBe('private');
    } catch (err) {
      await blocker.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      blocker.release();
    }
  });
});
