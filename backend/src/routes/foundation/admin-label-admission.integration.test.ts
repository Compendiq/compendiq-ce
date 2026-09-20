import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance, type LightMyRequestResponse } from 'fastify';
import sensible from '@fastify/sensible';
import { ZodError } from 'zod';
import { getPool, query } from '../../core/db/postgres.js';
import { createClient, type RedisClientType } from 'redis';
import { PAGE_LIFECYCLE_LOCK_KEY } from '../../core/db/advisory-locks.js';
import { setRedisClient } from '../../core/services/redis-cache.js';
import { initPageBaselineOutbox } from '../../core/services/page-baseline-outbox.js';
import {
  cancelPageWriteIntentBeforeEffect,
  fencePageWriterRuntime,
  lockPageLifecycle,
  reservePageWriteIntent,
} from '../../core/services/page-write-admission.js';
import { isDbAvailable, setupTestDb, teardownTestDb, truncateAllTables } from '../../test-db-helper.js';
import { adminRoutes } from './admin.js';
import { pageBaselineRoutes } from '../knowledge/page-baselines.js';
import { setPageBaselineReadinessProvider } from '../../core/services/page-baseline-governance.js';

const available = await isDbAvailable();

describe.skipIf(!available)('administrative labels respect page write admission', () => {
  let app: FastifyInstance;
  let actorId: string;
  let pageIds: number[];
  let attachmentsDir: string;
  let redis: RedisClientType;
  let stopOutbox: () => Promise<void>;

  beforeAll(async () => {
    attachmentsDir = await mkdtemp(join(tmpdir(), 'baseline-labels-'));
    vi.stubEnv('ATTACHMENTS_DIR', attachmentsDir);
    await setupTestDb();
    redis = createClient({ url: process.env.REDIS_URL, socket: { reconnectStrategy: false } });
    await redis.connect();
    setRedisClient(redis);
    app = Fastify({ logger: false });
    await app.register(sensible);
    app.decorate('redis', redis);
    setPageBaselineReadinessProvider(async () => ({ ready: true, blockers: [] }));
    app.decorate('requireAdmin', async (request: { userId: string; userRole: string }) => {
      request.userId = actorId;
      request.userRole = 'admin';
    });
    app.decorate('authenticate', app.requireAdmin);
    app.setErrorHandler((error, _request, reply) => {
      reply.status(error instanceof ZodError ? 400 : error.statusCode ?? 500).send({ error: error.message });
    });
    await app.register(adminRoutes, { prefix: '/api' });
    await app.register(pageBaselineRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await redis.quit();
    setPageBaselineReadinessProvider(null);
    await teardownTestDb();
    await rm(attachmentsDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  beforeEach(async () => {
    await truncateAllTables();
    const actor = await query<{ id: string }>(
      "INSERT INTO users (username, password_hash, role) VALUES ('label-admin', 'x', 'admin') RETURNING id",
    );
    actorId = actor.rows[0]!.id;
    await query(
      'INSERT INTO user_settings (user_id, confluence_enabled) VALUES ($1, FALSE)',
      [actorId],
    );
    pageIds = [await seedPage('First', ['review', 'keep']), await seedPage('Second', ['review'])];
    stopOutbox = await initPageBaselineOutbox();
  });

  afterEach(async () => { await stopOutbox(); });

  async function seedPage(title: string, labels: string[]): Promise<number> {
    const row = await query<{ id: number }>(
      `INSERT INTO pages (source, title, body_html, body_storage, body_text, labels, created_by_user_id, visibility)
       VALUES ('standalone', $1, '<p>Body</p>', '', 'Body', $2, $3, 'shared') RETURNING id`,
      [title, labels, actorId],
    );
    return row.rows[0]!.id;
  }

  async function labels(): Promise<string[][]> {
    const rows = await query<{ labels: string[] }>('SELECT labels FROM pages ORDER BY id');
    return rows.rows.map((row) => row.labels);
  }

  function rename() {
    return app.inject({
      method: 'PUT', url: '/api/admin/labels/rename', payload: { oldName: 'review', newName: 'approved' },
    });
  }

  it('renames and removes actual labels without modifying unrelated labels', async () => {
    await seedPage('Other', ['other']);
    const renamed = await rename();
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(renamed.json().affectedPages).toBe(2);
    expect(await labels()).toEqual([['approved', 'keep'], ['approved'], ['other']]);
    const removed = await app.inject({ method: 'DELETE', url: '/api/admin/labels/approved' });
    expect(removed.statusCode, removed.body).toBe(200);
    expect(removed.json().affectedPages).toBe(2);
    expect(await labels()).toEqual([['keep'], [], ['other']]);
    const absent = await app.inject({ method: 'DELETE', url: '/api/admin/labels/approved' });
    expect(absent.statusCode, absent.body).toBe(200);
    expect(absent.json().affectedPages).toBe(0);
  });

  it('rejects the whole label operation when one affected article is frozen', async () => {
    const enabled = await app.inject({
      method: 'PUT', url: '/api/admin/page-baselines/activation', payload: { creationEnabled: true },
    });
    expect(enabled.statusCode, enabled.body).toBe(200);
    const previewResponse = await app.inject({ method: 'GET', url: `/api/pages/${pageIds[1]}/freeze-preview` });
    expect(previewResponse.statusCode, previewResponse.body).toBe(200);
    const preview = previewResponse.json<{ contentRevision: string; manifestDigest: string }>();
    const frozen = await app.inject({
      method: 'POST', url: `/api/pages/${pageIds[1]}/freeze`,
      payload: {
        reason: 'Approved labels are part of this baseline',
        expectedContentRevision: preview.contentRevision,
        expectedManifestDigest: preview.manifestDigest,
      },
    });
    expect(frozen.statusCode, frozen.body).toBe(200);
    const renamed = await rename();
    expect(renamed.statusCode, renamed.body).toBe(423);
    const removed = await app.inject({ method: 'DELETE', url: '/api/admin/labels/review' });
    expect(removed.statusCode, removed.body).toBe(423);
    expect(await labels()).toEqual([['review', 'keep'], ['review']]);
  });

  it('changes no page while one member has an unresolved writer', async () => {
    const intent = await reservePageWriteIntent({
      pageIds: [pageIds[1]!], kind: 'attachment.local.put', actorId,
      effect: { effectClass: 'local', pageId: pageIds[1]!, files: [] },
    });
    try {
      const renamed = await rename();
      expect(renamed.statusCode, renamed.body).toBe(409);
      const removed = await app.inject({ method: 'DELETE', url: '/api/admin/labels/review' });
      expect(removed.statusCode, removed.body).toBe(409);
      expect(await labels()).toEqual([['review', 'keep'], ['review']]);
    } finally {
      await cancelPageWriteIntentBeforeEffect(intent);
    }
    const retried = await rename();
    expect(retried.statusCode, retried.body).toBe(200);
    expect(await labels()).toEqual([['approved', 'keep'], ['approved']]);
  });

  it('refuses a membership expansion rather than updating a page it never locked', async () => {
    const blocker = await getPool().connect();
    let pending: Promise<LightMyRequestResponse> | undefined;
    try {
      await blocker.query('BEGIN');
      await lockPageLifecycle(blocker, [pageIds[0]!]);
      pending = rename();
      // Observe the actual waiting advisory lock, rather than assume a timing window.
      await vi.waitFor(async () => {
        const waiting = await query<{ count: string }>(
          `SELECT COUNT(*) AS count FROM pg_locks
           WHERE locktype = 'advisory' AND NOT granted
             AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
        );
        expect(Number(waiting.rows[0]!.count)).toBeGreaterThan(0);
      });
      await seedPage('Arrived while waiting', ['review']);
      await blocker.query('COMMIT');
      const response = await pending;
      expect(response.statusCode, response.body).toBe(409);
      expect(await labels()).toEqual([['review', 'keep'], ['review'], ['review']]);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
      if (pending) await pending;
    }
  });

  it('refuses a blocked fence after committed administrator demotion without deadlocking label admission', async () => {
    const intent = await reservePageWriteIntent({
      pageIds: [pageIds[0]!], kind: 'attachment.local.put', actorId,
      effect: { effectClass: 'local', pageId: pageIds[0]!, files: [] },
    });
    const blocker = await getPool().connect();
    let pending: Promise<LightMyRequestResponse> | undefined;
    let fencing: ReturnType<typeof fencePageWriterRuntime> | undefined;
    try {
      await blocker.query('BEGIN');
      await lockPageLifecycle(blocker, [pageIds[0]!]);
      const blockerIdentity = await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      pending = rename();
      let labelPid = 0;
      await vi.waitFor(async () => {
        const waiting = await query<{ pid: number }>(
          `SELECT pid FROM pg_locks
            WHERE locktype = 'advisory' AND NOT granted
              AND classid = $1 AND objid = $2
              AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
          [PAGE_LIFECYCLE_LOCK_KEY, pageIds[0]],
        );
        expect(waiting.rows).toHaveLength(1);
        labelPid = waiting.rows[0]!.pid;
      });
      fencing = fencePageWriterRuntime({
        runtimeId: intent.runtimeId,
        actorId,
        mode: 'durable_no_started_effects',
        reason: 'Retire the epoch while administrative labels are waiting',
      });
      const completed = Promise.allSettled([pending, fencing]);
      await vi.waitFor(async () => {
        const waiting = await query<{ waiting: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM pg_stat_activity
              WHERE datname = current_database() AND pid <> $1
                AND wait_event_type = 'Lock'
                AND ($1 = ANY(pg_blocking_pids(pid)) OR $2 = ANY(pg_blocking_pids(pid)))
           ) AS waiting`,
          [labelPid, blockerIdentity.rows[0]!.pid],
        );
        expect(waiting.rows[0]!.waiting).toBe(true);
      });
      await blocker.query("UPDATE users SET role = 'user' WHERE id = $1", [actorId]);
      await blocker.query('COMMIT');
      const [renamed, fenced] = await completed;
      expect(renamed.status).toBe('fulfilled');
      if (renamed.status === 'fulfilled') expect(renamed.value.statusCode, renamed.value.body).toBe(409);
      expect(fenced.status).toBe('rejected');
      if (fenced.status === 'rejected') {
        expect(fenced.reason).toMatchObject({
          statusCode: 403,
          reason: 'recovery_admin_required',
        });
      }
      expect(await labels()).toEqual([['review', 'keep'], ['review']]);
      expect((await query<{ retired: boolean }>(
        'SELECT fenced_at IS NOT NULL AS retired FROM page_writer_runtimes WHERE runtime_id = $1',
        [intent.runtimeId],
      )).rows[0]!.retired).toBe(false);
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
      await Promise.allSettled([pending, fencing].filter((promise) => promise !== undefined));
    }
  });
});
