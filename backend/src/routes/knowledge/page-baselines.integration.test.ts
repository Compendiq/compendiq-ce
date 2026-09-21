import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PageFreezeHistoryResponseSchema,
  PageFreezePreviewResponseSchema,
  PageLifecycleMutationResponseSchema,
  type PageFreezePreviewResponse,
  type PageLifecycleState,
} from '@compendiq/contracts';
import { getPool, query } from '../../core/db/postgres.js';
import { isDbAvailable, setupTestDb, teardownTestDb, truncateAllTables } from '../../test-db-helper.js';
import { setPageBaselineReadinessProvider } from '../../core/services/page-baseline-governance.js';
import { cleanupAbandonedBaselinePreparations } from '../../core/services/page-baseline-service.js';
import { pageBaselineRoutes } from './page-baselines.js';
import { createClient, type RedisClientType } from 'redis';
import { setRedisClient } from '../../core/services/redis-cache.js';
import { initPageBaselineOutbox, kickPageLifecycleOutbox } from '../../core/services/page-baseline-outbox.js';
import {
  admitPageRuntime,
  cancelPageWriteIntentBeforeEffect,
  releasePageRuntime,
  reservePageWriteIntent,
  withPageWriteTransaction,
} from '../../core/services/page-write-admission.js';
import { REAL_PNG_40x30_BASE64 } from '../../core/services/test-image-fixtures.js';

const dbAvailable = await isDbAvailable();

// Only authenticated identity is supplied at the HTTP boundary. All authority,
// lifecycle decisions, persistence, manifests and retained files remain real.
describe.skipIf(!dbAvailable)('baseline lifecycle HTTP invariants', () => {
  let app: FastifyInstance;
  let attachmentsDir: string;
  let admin: string;
  let owner: string;
  let reader: string;
  let pageId: number;
  let redis: RedisClientType;
  let stopOutbox: () => Promise<void>;

  beforeAll(async () => {
    await setupTestDb();
    redis = createClient({ url: process.env.REDIS_URL, socket: { reconnectStrategy: false } });
    await redis.connect();
    setRedisClient(redis);
    attachmentsDir = await mkdtemp(join(tmpdir(), 'baseline-http-'));
    vi.stubEnv('ATTACHMENTS_DIR', attachmentsDir);
    app = Fastify({ logger: false });
    app.decorate('authenticate', async (request: FastifyRequest, reply: FastifyReply) => {
      const identity = request.headers['x-test-user'];
      if (typeof identity !== 'string') return reply.code(401).send({ error: 'Unauthenticated' });
      request.userId = identity;
    });
    // A stale admin claim must never defeat the service's current database check.
    app.decorate('requireAdmin', async (request: FastifyRequest) => { request.userRole = 'admin'; });
    app.redis = redis;
    const [{ pagesCrudRoutes }, { pagesVersionRoutes }, { localAttachmentsRoutes }] = await Promise.all([
      import('./pages-crud.js'),
      import('./pages-versions.js'),
      import('./local-attachments.js'),
    ]);
    await app.register(pagesCrudRoutes, { prefix: '/api' });
    await app.register(pagesVersionRoutes, { prefix: '/api' });
    await app.register(localAttachmentsRoutes, { prefix: '/api' });
    await app.register(pageBaselineRoutes, { prefix: '/api' });
    await app.ready();
  });

  beforeEach(async () => {
    await truncateAllTables();
    setPageBaselineReadinessProvider(async () => ({ ready: true, blockers: [] }));
    const users = await query<{ id: string; username: string }>(
      `INSERT INTO users (username, email, password_hash, role, display_name)
       VALUES ('baseline-admin', 'baseline-admin@test', 'x', 'admin', 'Administrator'),
              ('baseline-owner', 'baseline-owner@test', 'x', 'user', 'Original owner'),
              ('baseline-reader', 'baseline-reader@test', 'x', 'user', 'Reader')
       RETURNING id, username`,
    );
    admin = users.rows.find((row) => row.username === 'baseline-admin')!.id;
    owner = users.rows.find((row) => row.username === 'baseline-owner')!.id;
    reader = users.rows.find((row) => row.username === 'baseline-reader')!.id;
    const page = await query<{ id: number }>(
      `INSERT INTO pages (source, title, body_html, body_storage, body_text, visibility, created_by_user_id)
       VALUES ('standalone', 'Reviewed document', '<p>Approved text</p>', '<p>Approved text</p>', 'Approved text', 'shared', $1)
       RETURNING id`, [owner],
    );
    pageId = page.rows[0]!.id;
    const activation = await app.inject({
      method: 'PUT', url: '/api/admin/page-baselines/activation',
      headers: { 'x-test-user': admin }, payload: { creationEnabled: true },
    });
    expect(activation.statusCode, activation.body).toBe(200);
    stopOutbox = await initPageBaselineOutbox();
  });

  afterEach(async () => { await stopOutbox(); });

  afterAll(async () => {
    await app.close();
    await redis.quit();
    setPageBaselineReadinessProvider(null);
    await teardownTestDb();
    await rm(attachmentsDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  async function preview(actor = owner): Promise<PageFreezePreviewResponse> {
    const response = await app.inject({
      method: 'GET', url: `/api/pages/${pageId}/freeze-preview`, headers: { 'x-test-user': actor },
    });
    expect(response.statusCode, response.body).toBe(200);
    return PageFreezePreviewResponseSchema.parse(response.json());
  }

  function freeze(prepared: PageFreezePreviewResponse, actor = owner) {
    return app.inject({
      method: 'POST', url: `/api/pages/${pageId}/freeze`, headers: { 'x-test-user': actor },
      payload: {
        reason: 'Release reviewed for the board', expectedContentRevision: prepared.contentRevision,
        expectedManifestDigest: prepared.manifestDigest,
        reportedSignatories: [{ displayName: 'Claimed approver', email: 'private-signatory@example.test' }],
      },
    });
  }

  function thaw(state: PageLifecycleState, actor = admin) {
    return app.inject({
      method: 'POST', url: `/api/pages/${pageId}/unfreeze`, headers: { 'x-test-user': actor },
      payload: {
        reason: 'Reopen for the next revision', expectedBaselineId: state.baselineId,
        expectedLifecycleRevision: state.lifecycleRevision,
      },
    });
  }

  it('serializes repeated freeze/thaw requests without duplicate transitions or rewriting a same-version snapshot', async () => {
    const existing = await query<{ id: string }>(
      `INSERT INTO page_versions (page_id, version_number, title, body_html, body_text)
       VALUES ($1, 1, 'Earlier snapshot', '<p>Earlier text</p>', 'Earlier text') RETURNING id`, [pageId],
    );
    const prepared = await preview();
    expect(await preview()).toEqual(prepared);
    const responses = await Promise.all([freeze(prepared), freeze(prepared)]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const state = PageLifecycleMutationResponseSchema.parse(responses.find((response) => response.statusCode === 200)!.json()).state;
    expect(state).toMatchObject({ isFrozen: true, provenance: 'manual_assertion', frozenVersion: 1 });
    const thaws = await Promise.all([thaw(state), thaw(state)]);
    expect(thaws.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const thawed = PageLifecycleMutationResponseSchema.parse(
      thaws.find((response) => response.statusCode === 200)!.json(),
    ).state;
    expect(thawed).toMatchObject({
      isFrozen: false, baselineId: null, frozenVersion: null, frozenAt: null,
      frozenBy: null, frozenByName: null, freezeReason: null, provenance: null,
      lifecycleRevision: String(BigInt(state.lifecycleRevision) + 1n),
    });
    expect((await query('SELECT id, title, body_html FROM page_versions WHERE page_id = $1', [pageId])).rows)
      .toEqual([{ id: existing.rows[0]!.id, title: 'Earlier snapshot', body_html: '<p>Earlier text</p>' }]);
    expect((await query(
      `SELECT version, baseline_id, frozen_by_user_id, freeze_reported_signatories, freeze_reported_reference
         FROM pages WHERE id = $1`, [pageId],
    )).rows).toEqual([{
      version: 1, baseline_id: null, frozen_by_user_id: null,
      freeze_reported_signatories: null, freeze_reported_reference: null,
    }]);
    expect((await query('SELECT action, baseline_id, version, manifest_digest FROM page_baseline_history WHERE original_page_id = $1 ORDER BY created_at, id', [pageId])).rows)
      .toEqual([
        { action: 'freeze', baseline_id: prepared.baselineId, version: 1, manifest_digest: prepared.manifestDigest },
        { action: 'thaw', baseline_id: prepared.baselineId, version: 1, manifest_digest: prepared.manifestDigest },
      ]);
    const next = await preview();
    expect(next.baselineId).not.toBe(prepared.baselineId);
    expect((await thaw(state)).statusCode).toBe(409);
  });

  it('rejects completed freeze replays without claiming new evidence was recorded', async () => {
    const prepared = await preview();
    expect((await freeze(prepared)).statusCode).toBe(200);
    const evidenceBefore = (await query(
      'SELECT to_jsonb(b) AS evidence FROM page_baselines b WHERE id = $1', [prepared.baselineId],
    )).rows;
    const historyBefore = (await query(
      'SELECT to_jsonb(h) AS entry FROM page_baseline_history h WHERE baseline_id = $1 ORDER BY created_at, id',
      [prepared.baselineId],
    )).rows;

    const exactReplay = await freeze(prepared);
    expect(exactReplay.statusCode, exactReplay.body).toBe(423);
    const differentClaim = await app.inject({
      method: 'POST', url: `/api/pages/${pageId}/freeze`, headers: { 'x-test-user': admin },
      payload: {
        reason: 'A different administrator supplied a different claim',
        expectedContentRevision: prepared.contentRevision,
        expectedManifestDigest: prepared.manifestDigest,
        reportedSignatories: [{ displayName: 'Different reported approver' }],
        reportedReference: 'review-board/different-decision',
      },
    });
    expect(differentClaim.statusCode, differentClaim.body).toBe(423);
    expect((await query(
      'SELECT to_jsonb(b) AS evidence FROM page_baselines b WHERE id = $1', [prepared.baselineId],
    )).rows).toEqual(evidenceBefore);
    expect((await query(
      'SELECT to_jsonb(h) AS entry FROM page_baseline_history h WHERE baseline_id = $1 ORDER BY created_at, id',
      [prepared.baselineId],
    )).rows).toEqual(historyBefore);
  });

  it('releases superseded preview capacity without removing published evidence', async () => {
    const bytes = Buffer.from(REAL_PNG_40x30_BASE64, 'base64');
    const liveUrl = `/api/local-attachments/${pageId}/capacity.png`;
    const uploaded = await app.inject({
      method: 'PUT', url: liveUrl, headers: { 'x-test-user': owner },
      payload: { dataUri: `data:image/png;base64,${REAL_PNG_40x30_BASE64}` },
    });
    expect(uploaded.statusCode, uploaded.body).toBe(200);
    await query('UPDATE pages SET body_html = $2 WHERE id = $1', [pageId, `<img src="${liveUrl}">`]);
    const selected = await preview();
    const superseded = await preview(admin);
    expect(superseded.baselineId).not.toBe(selected.baselineId);
    expect(selected.totalBytes).toBe(bytes.length);
    expect((await query('SELECT reserved_bytes::text FROM page_baseline_capacity')).rows)
      .toEqual([{ reserved_bytes: String(bytes.length * 2) }]);

    const frozen = await freeze(selected);
    expect(frozen.statusCode, frozen.body).toBe(200);
    await cleanupAbandonedBaselinePreparations();
    expect((await query(
      'SELECT id, status FROM page_baselines WHERE original_page_id = $1', [pageId],
    )).rows).toEqual([{ id: selected.baselineId, status: 'published' }]);
    expect((await query('SELECT reserved_bytes::text FROM page_baseline_capacity')).rows)
      .toEqual([{ reserved_bytes: String(bytes.length) }]);
    await expect(access(join(attachmentsDir, 'page-baselines', superseded.baselineId)))
      .rejects.toMatchObject({ code: 'ENOENT' });
    const retained = await app.inject({
      method: 'GET',
      url: `/api/admin/page-baselines/${selected.baselineId}/attachments/${selected.attachments[0]!.identity}`,
      headers: { 'x-test-user': admin },
    });
    expect(retained.statusCode, retained.body).toBe(200);
    expect(retained.rawPayload).toEqual(bytes);
  });

  it('refuses published evidence rewrites, abandonment and ledger deletion at the database boundary', async () => {
    const prepared = await preview();
    const frozen = await freeze(prepared);
    expect(frozen.statusCode, frozen.body).toBe(200);
    const state = PageLifecycleMutationResponseSchema.parse(frozen.json()).state;
    expect((await thaw(state)).statusCode).toBe(200);
    const before = await query(
      'SELECT to_jsonb(b) AS evidence FROM page_baselines b WHERE id = $1', [prepared.baselineId],
    );
    const historyBefore = await query(
      'SELECT to_jsonb(h) AS entry FROM page_baseline_history h WHERE baseline_id = $1 ORDER BY created_at, id',
      [prepared.baselineId],
    );

    for (const mutation of [
      "UPDATE page_baselines SET body_html = '<p>Altered evidence</p>' WHERE id = $1",
      "UPDATE page_baselines SET manifest_digest = repeat('0', 64) WHERE id = $1",
      "UPDATE page_baselines SET status = 'abandoned', abandoned_at = NOW() WHERE id = $1",
      'DELETE FROM page_baselines WHERE id = $1',
      "UPDATE page_baseline_history SET reason = 'Rewritten history' WHERE baseline_id = $1",
      'DELETE FROM page_baseline_history WHERE baseline_id = $1',
    ]) {
      await expect(query(mutation, [prepared.baselineId])).rejects.toMatchObject({ code: 'P0001' });
    }

    expect((await query(
      'SELECT to_jsonb(b) AS evidence FROM page_baselines b WHERE id = $1', [prepared.baselineId],
    )).rows).toEqual(before.rows);
    expect((await query(
      'SELECT to_jsonb(h) AS entry FROM page_baseline_history h WHERE baseline_id = $1 ORDER BY created_at, id',
      [prepared.baselineId],
    )).rows).toEqual(historyBefore.rows);
  });

  it('exposes current role capabilities and privacy-safe lifecycle summaries across read surfaces', async () => {
    for (const actor of [owner, admin, reader]) {
      const detail = await app.inject({
        method: 'GET', url: `/api/pages/${pageId}`, headers: { 'x-test-user': actor },
      });
      expect(detail.statusCode, detail.body).toBe(200);
      expect(detail.json()).toMatchObject({
        isFrozen: false, baselineId: null, frozenVersion: null, provenance: null,
        canFreeze: actor !== reader, canUnfreeze: false, canApprove: false,
      });
    }
    for (const url of ['/api/pages', '/api/pages/tree']) {
      const initial = await app.inject({ method: 'GET', url, headers: { 'x-test-user': reader } });
      expect(initial.statusCode, initial.body).toBe(200);
      expect(initial.json<{ items: Array<Record<string, unknown>> }>().items.find(
        (item) => String(item.id) === String(pageId),
      )).toMatchObject({ isFrozen: false, baselineId: null, frozenVersion: null });
    }

    const prepared = await preview();
    const frozen = await freeze(prepared);
    expect(frozen.statusCode, frozen.body).toBe(200);
    const state = PageLifecycleMutationResponseSchema.parse(frozen.json()).state;
    await vi.waitFor(async () => {
      await kickPageLifecycleOutbox();
      expect((await query(
        'SELECT COUNT(*)::int AS pending FROM page_lifecycle_outbox WHERE delivered_at IS NULL',
      )).rows).toEqual([{ pending: 0 }]);
    });
    for (const actor of [owner, admin, reader]) {
      const detail = await app.inject({
        method: 'GET', url: `/api/pages/${pageId}`, headers: { 'x-test-user': actor },
      });
      expect(detail.statusCode, detail.body).toBe(200);
      expect(detail.json()).toMatchObject({
        isFrozen: true, baselineId: prepared.baselineId, frozenVersion: 1,
        provenance: 'manual_assertion', canFreeze: false,
        canUnfreeze: actor === admin, canApprove: false, canMutateContent: false,
      });
      expect(detail.body).not.toContain('private-signatory@example.test');
    }
    for (const url of ['/api/pages', '/api/pages/tree']) {
      const summary = await app.inject({ method: 'GET', url, headers: { 'x-test-user': reader } });
      expect(summary.statusCode, summary.body).toBe(200);
      const item = summary.json<{ items: Array<Record<string, unknown>> }>().items.find(
        (entry) => String(entry.id) === String(pageId),
      );
      expect(item).toMatchObject({
        isFrozen: true, baselineId: prepared.baselineId, frozenVersion: 1,
      });
      expect(item).not.toHaveProperty('reportedSignatories');
      expect(item).not.toHaveProperty('freezeReason');
      expect(summary.body).not.toContain('private-signatory@example.test');
    }

    expect((await thaw(state)).statusCode).toBe(200);
    await vi.waitFor(async () => {
      await kickPageLifecycleOutbox();
      expect((await query(
        'SELECT COUNT(*)::int AS pending FROM page_lifecycle_outbox WHERE delivered_at IS NULL',
      )).rows).toEqual([{ pending: 0 }]);
    });
    for (const url of ['/api/pages', '/api/pages/tree']) {
      const summary = await app.inject({ method: 'GET', url, headers: { 'x-test-user': reader } });
      expect(summary.statusCode, summary.body).toBe(200);
      expect(summary.json<{ items: Array<Record<string, unknown>> }>().items.find(
        (item) => String(item.id) === String(pageId),
      )).toMatchObject({ isFrozen: false, baselineId: null, frozenVersion: null });
    }
  });

  it.each([
    {
      writer: 'save', method: 'PUT', resource: 'pages', suffix: '',
      payload: { title: 'Concurrent title', bodyHtml: '<p>Concurrent save</p>', version: 2 },
    },
    {
      writer: 'restore', method: 'POST', resource: 'pages', suffix: '/versions/1/restore',
      payload: { version: 2 },
    },
    { writer: 'delete', method: 'DELETE', resource: 'pages', suffix: '', payload: undefined },
    {
      writer: 'attachment', method: 'PUT', resource: 'local-attachments', suffix: '/raced.png',
      payload: { dataUri: `data:image/png;base64,${REAL_PNG_40x30_BASE64}` },
    },
  ] as const)('a winning freeze refuses a concurrent $writer before authored or file effects', async (writer) => {
    await query('UPDATE pages SET version = 2 WHERE id = $1', [pageId]);
    await query(
      `INSERT INTO page_versions (page_id, version_number, title, body_html, body_text)
       VALUES ($1, 1, 'Historical title', '<p>Historical text</p>', 'Historical text')`, [pageId],
    );
    const prepared = await preview();
    await query(`
      CREATE FUNCTION test_hold_http_freeze() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.baseline_id IS NULL AND NEW.baseline_id IS NOT NULL THEN
          PERFORM pg_advisory_xact_lock(279, 775);
        END IF;
        RETURN NEW;
      END
      $$;
      CREATE TRIGGER test_hold_http_freeze BEFORE UPDATE ON pages
        FOR EACH ROW EXECUTE FUNCTION test_hold_http_freeze()
    `);
    const barrier = await getPool().connect();
    const inFlight: Promise<unknown>[] = [];
    try {
      await barrier.query('BEGIN');
      const holder = await barrier.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      await barrier.query('SELECT pg_advisory_xact_lock(279, 775)');
      const freezing = freeze(prepared).then((response) => response);
      inFlight.push(freezing);
      let freezePid = 0;
      await vi.waitFor(async () => {
        const blocked = await query<{ pid: number }>(
          `SELECT pid FROM pg_stat_activity
            WHERE wait_event_type = 'Lock' AND $1 = ANY(pg_blocking_pids(pid))`,
          [holder.rows[0]!.pid],
        );
        expect(blocked.rows).toHaveLength(1);
        freezePid = blocked.rows[0]!.pid;
      });
      const writing = app.inject({
        method: writer.method,
        url: `/api/${writer.resource}/${pageId}${writer.suffix}`,
        headers: { 'x-test-user': owner },
        payload: writer.payload,
      }).then((response) => response);
      inFlight.push(writing);
      await vi.waitFor(async () => {
        const blocked = await query<{ exists: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM pg_stat_activity
              WHERE wait_event_type = 'Lock' AND $1 = ANY(pg_blocking_pids(pid))
           ) AS exists`, [freezePid],
        );
        expect(blocked.rows[0]?.exists).toBe(true);
      });
      await expect(access(join(attachmentsDir, 'local', String(pageId), 'raced.png')))
        .rejects.toMatchObject({ code: 'ENOENT' });
      await barrier.query('ROLLBACK');
      const [frozen, denied] = await Promise.all([freezing, writing]);
      expect(frozen.statusCode, frozen.body).toBe(200);
      expect(denied.statusCode, denied.body).toBe(423);
      expect((await query(
        `SELECT title, body_html, version, deleted_at, baseline_id FROM pages WHERE id = $1`, [pageId],
      )).rows).toEqual([{
        title: 'Reviewed document', body_html: '<p>Approved text</p>', version: 2,
        deleted_at: null, baseline_id: prepared.baselineId,
      }]);
      expect((await query('SELECT filename FROM local_attachments WHERE page_id = $1', [pageId])).rows)
        .toEqual([]);
      await expect(access(join(attachmentsDir, 'local', String(pageId), 'raced.png')))
        .rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await barrier.query('ROLLBACK');
      barrier.release();
      await Promise.allSettled(inFlight);
      await query('DROP TRIGGER test_hold_http_freeze ON pages; DROP FUNCTION test_hold_http_freeze()');
    }
  });

  it.each([
    {
      failure: 'snapshot',
      add: 'ALTER TABLE page_versions ADD CONSTRAINT baseline_fixture_failure CHECK (version_number < 0) NOT VALID',
      drop: 'ALTER TABLE page_versions DROP CONSTRAINT baseline_fixture_failure',
    },
    {
      failure: 'audit',
      add: "ALTER TABLE audit_log ADD CONSTRAINT baseline_fixture_failure CHECK (action <> 'PAGE_FROZEN') NOT VALID",
      drop: 'ALTER TABLE audit_log DROP CONSTRAINT baseline_fixture_failure',
    },
  ])('rolls back publication, live state and history on a real $failure failure, retaining the retry preparation', async ({ add, drop }) => {
    const prepared = await preview();
    await query(add);
    try {
      expect((await freeze(prepared)).statusCode).toBe(500);
      expect((await query('SELECT baseline_id, version FROM pages WHERE id = $1', [pageId])).rows)
        .toEqual([{ baseline_id: null, version: 1 }]);
      expect((await query('SELECT status FROM page_baselines WHERE id = $1', [prepared.baselineId])).rows)
        .toEqual([{ status: 'prepared' }]);
      expect((await query('SELECT id FROM page_baseline_history WHERE original_page_id = $1', [pageId])).rows).toEqual([]);
      expect((await query('SELECT id FROM page_versions WHERE page_id = $1', [pageId])).rows).toEqual([]);
      expect((await query("SELECT id FROM audit_log WHERE action = 'PAGE_FROZEN' AND resource_id = $1", [String(pageId)])).rows).toEqual([]);
    } finally {
      await query(drop);
    }
    expect(await preview()).toEqual(prepared);
    const retried = await freeze(prepared);
    expect(retried.statusCode, retried.body).toBe(200);
  });

  it('keeps PostgreSQL microseconds in a timestamp/id cursor, including tied timestamps', async () => {
    // PostgreSQL retains microseconds while its JS Date parser does not. Force a
    // non-millisecond tie so cursor precision loss cannot pass by clock luck.
    await query(`CREATE FUNCTION baseline_fixture_history_time() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN NEW.created_at := '2026-01-01T00:00:00.000001Z'::timestamptz; RETURN NEW; END $$`);
    await query(`CREATE TRIGGER baseline_fixture_history_time BEFORE INSERT ON page_baseline_history
      FOR EACH ROW EXECUTE FUNCTION baseline_fixture_history_time()`);
    try {
      const frozen = await freeze(await preview());
      expect(frozen.statusCode, frozen.body).toBe(200);
      const thawed = await thaw(PageLifecycleMutationResponseSchema.parse(frozen.json()).state);
      expect(thawed.statusCode, thawed.body).toBe(200);
      const expected = (await query<{ id: string }>(
        'SELECT id FROM page_baseline_history WHERE original_page_id = $1 ORDER BY created_at, id', [pageId],
      )).rows.map((row) => row.id);
      const first = await app.inject({
        method: 'GET', url: `/api/pages/${pageId}/freeze-history?limit=1`, headers: { 'x-test-user': reader },
      });
      expect(first.statusCode, first.body).toBe(200);
      const firstPage = PageFreezeHistoryResponseSchema.parse(first.json());
      const second = await app.inject({
        method: 'GET', url: `/api/pages/${pageId}/freeze-history?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor!)}`,
        headers: { 'x-test-user': reader },
      });
      expect(second.statusCode, second.body).toBe(200);
      const secondPage = PageFreezeHistoryResponseSchema.parse(second.json());
      expect([...firstPage.entries, ...secondPage.entries].map((entry) => entry.id)).toEqual(expected);
      expect(secondPage.nextCursor).toBeNull();
    } finally {
      await query('DROP TRIGGER baseline_fixture_history_time ON page_baseline_history');
      await query('DROP FUNCTION baseline_fixture_history_time()');
    }
  });

  it('rejects an invalid cursor UUID before it becomes a database cast error', async () => {
    const cursor = Buffer.from(JSON.stringify(['2026-01-01T00:00:00.000001Z', '-'.repeat(36)])).toString('base64url');
    const response = await app.inject({
      method: 'GET', url: `/api/pages/${pageId}/freeze-history?cursor=${cursor}`,
      headers: { 'x-test-user': reader },
    });
    expect(response.statusCode, response.body).toBe(400);
  });

  it('enforces current authority, redacts claimed email, and retains evidence after actor and source deletion', async () => {
    expect((await app.inject({ method: 'GET', url: `/api/pages/${pageId}/freeze-preview` })).statusCode).toBe(401);
    const prepared = await preview();
    expect((await freeze(prepared, reader)).statusCode).toBe(403);
    const frozen = await freeze(prepared);
    expect(frozen.statusCode, frozen.body).toBe(200);
    const state = PageLifecycleMutationResponseSchema.parse(frozen.json()).state;
    expect((await thaw(state, owner)).statusCode).toBe(403);
    const history = await app.inject({
      method: 'GET', url: `/api/pages/${pageId}/freeze-history`, headers: { 'x-test-user': reader },
    });
    expect(history.statusCode, history.body).toBe(200);
    expect(history.body).not.toContain('private-signatory@example.test');
    expect(history.json().entries[0]).toMatchObject({
      provenance: 'manual_assertion', reportedSignatories: [{ displayName: 'Claimed approver' }],
    });
    await query("UPDATE pages SET visibility = 'private' WHERE id = $1", [pageId]);
    expect((await app.inject({
      method: 'GET', url: `/api/pages/${pageId}/freeze-history`, headers: { 'x-test-user': reader },
    })).statusCode).toBe(404);
    await query('DELETE FROM users WHERE id = $1', [owner]);
    const actorHistory = await app.inject({
      method: 'GET', url: `/api/admin/page-baselines/${prepared.baselineId}/history`, headers: { 'x-test-user': admin },
    });
    expect(actorHistory.statusCode, actorHistory.body).toBe(200);
    expect(actorHistory.json().entries[0]).toMatchObject({ actorId: null, actorName: 'Original owner' });
    expect((await thaw(state)).statusCode).toBe(200);
    await query('UPDATE pages SET deleted_at = NOW() WHERE id = $1', [pageId]);
    expect((await app.inject({
      method: 'GET', url: `/api/pages/${pageId}/freeze-history`, headers: { 'x-test-user': admin },
    })).statusCode).toBe(404);
    await query('DELETE FROM pages WHERE id = $1', [pageId]);
    const evidence = await app.inject({
      method: 'GET', url: `/api/admin/page-baselines/${prepared.baselineId}`, headers: { 'x-test-user': admin },
    });
    expect(evidence.statusCode, evidence.body).toBe(200);
    expect(evidence.json()).toMatchObject({
      livePageId: null, originalPageId: pageId, manifestDigest: prepared.manifestDigest,
      publishedBy: null, publishedByName: 'Original owner',
      reportedSignatories: [{ displayName: 'Claimed approver', email: 'private-signatory@example.test' }],
    });
    await query("UPDATE users SET role = 'user' WHERE id = $1", [admin]);
    expect((await app.inject({
      method: 'GET', url: `/api/admin/page-baselines/${prepared.baselineId}`, headers: { 'x-test-user': admin },
    })).statusCode).toBe(403);
  });

  it('retains downloadable evidence after thaw, live replacement and HTTP permanent deletion', async () => {
    const original = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><path d="M0 0h1v1H0z"/></svg>');
    const replacement = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><circle cx=".5" cy=".5" r=".5"/></svg>');
    const liveUrl = `/api/local-attachments/${pageId}/evidence.svg`;
    const uploaded = await app.inject({
      method: 'PUT', url: liveUrl, headers: { 'x-test-user': owner },
      payload: { dataUri: `data:image/svg+xml;base64,${original.toString('base64')}` },
    });
    expect(uploaded.statusCode, uploaded.body).toBe(200);
    await query('UPDATE pages SET body_html = $2 WHERE id = $1', [
      pageId, `<p>Retained evidence</p><img src="${liveUrl}">`,
    ]);
    const prepared = await preview();
    const attachment = prepared.attachments.find((item) => item.filename === 'evidence.svg')!;
    const evidenceUrl = `/api/admin/page-baselines/${prepared.baselineId}/attachments/${attachment.identity}`;
    const frozen = await freeze(prepared);
    expect(frozen.statusCode, frozen.body).toBe(200);
    const state = PageLifecycleMutationResponseSchema.parse(frozen.json()).state;
    expect((await thaw(state)).statusCode).toBe(200);

    const replaced = await app.inject({
      method: 'PUT', url: liveUrl, headers: { 'x-test-user': owner },
      payload: { dataUri: `data:image/svg+xml;base64,${replacement.toString('base64')}` },
    });
    expect(replaced.statusCode, replaced.body).toBe(200);
    const live = await app.inject({ method: 'GET', url: liveUrl, headers: { 'x-test-user': owner } });
    expect(live.statusCode, live.body).toBe(200);
    expect(live.rawPayload).toEqual(replacement);
    const retained = await app.inject({
      method: 'GET', url: evidenceUrl, headers: { 'x-test-user': admin },
    });
    expect(retained.statusCode, retained.body).toBe(200);
    expect(retained.rawPayload).toEqual(original);

    const deleted = await app.inject({
      method: 'DELETE', url: `/api/pages/${pageId}?permanent=true`, headers: { 'x-test-user': owner },
    });
    expect(deleted.statusCode, deleted.body).toBe(200);
    await expect(access(join(attachmentsDir, 'local', String(pageId), 'evidence.svg')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    const retainedAfterDelete = await app.inject({
      method: 'GET', url: evidenceUrl, headers: { 'x-test-user': admin },
    });
    expect(retainedAfterDelete.statusCode, retainedAfterDelete.body).toBe(200);
    expect(retainedAfterDelete.rawPayload).toEqual(original);
    expect((await app.inject({
      method: 'GET', url: evidenceUrl, headers: { 'x-test-user': reader },
    })).statusCode).toBe(403);
    expect((await app.inject({
      method: 'GET',
      url: `/api/pages/${pageId}/baselines/${prepared.baselineId}/media/${attachment.identity}`,
      headers: { 'x-test-user': admin },
    })).statusCode).toBe(404);
  });

  it('refuses an in-flight SQL writer, then rejects its stale version-less preview', async () => {
    const prepared = await preview();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const writing = withPageWriteTransaction([pageId], async (client) => {
      await client.query(
        "UPDATE pages SET body_html = '<p>Concurrent authored text</p>' WHERE id = $1",
        [pageId],
      );
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    try {
      expect((await freeze(prepared)).statusCode).toBe(409);
      expect((await query(
        'SELECT baseline_id, version FROM pages WHERE id = $1', [pageId],
      )).rows).toEqual([{ baseline_id: null, version: 1 }]);
    } finally {
      release.resolve();
      await writing;
    }
    expect((await freeze(prepared)).statusCode).toBe(409);
    expect((await query(
      "SELECT id FROM page_baselines WHERE original_page_id = $1 AND status = 'published'", [pageId],
    )).rows).toEqual([]);
    const fresh = await preview();
    expect(fresh.contentRevision).not.toBe(prepared.contentRevision);
    expect((await freeze(fresh)).statusCode).toBe(200);
    expect((await query(
      'SELECT version, body_html FROM page_baselines WHERE id = $1', [fresh.baselineId],
    )).rows).toEqual([{ version: 1, body_html: '<p>Concurrent authored text</p>' }]);
  });

  it.each(['writer', 'editor'] as const)('does not publish over an admitted %s and succeeds after clean release', async (kind) => {
    const prepared = await preview();
    const intent = kind === 'writer' ? await reservePageWriteIntent({
      pageIds: [pageId], actorId: owner, kind: 'attachment.local.put',
      effect: { effectClass: 'local', pageId, files: [] },
    }) : null;
    const admission = kind === 'editor' ? await admitPageRuntime(pageId, owner) : null;
    try {
      expect((await freeze(prepared)).statusCode).toBe(409);
      expect((await query(
        'SELECT action FROM page_baseline_history WHERE original_page_id = $1', [pageId],
      )).rows).toEqual([]);
    } finally {
      if (intent) await cancelPageWriteIntentBeforeEffect(intent);
      if (admission) await releasePageRuntime(admission);
    }
    const response = await freeze(prepared);
    expect(response.statusCode, response.body).toBe(200);
    expect(PageLifecycleMutationResponseSchema.parse(response.json()).state.baselineId).toBe(prepared.baselineId);
  });

  it('rejects changed live media even when the page revision still matches its preview', async () => {
    const directory = join(attachmentsDir, 'local', String(pageId));
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'evidence.png'), Buffer.from('original retained bytes'));
    await query(
      'UPDATE pages SET body_html = $2 WHERE id = $1',
      [pageId, `<img src="/api/local-attachments/${pageId}/evidence.png">`],
    );
    const prepared = await preview();
    // Simulate an out-of-band filesystem change: no SQL revision can reveal it.
    await writeFile(join(directory, 'evidence.png'), Buffer.from('changed live bytes'));
    expect((await query<{ content_revision: string }>(
      'SELECT content_revision::text FROM pages WHERE id = $1', [pageId],
    )).rows[0]!.content_revision).toBe(prepared.contentRevision);
    expect((await freeze(prepared)).statusCode).toBe(409);
    expect((await query(
      'SELECT status FROM page_baselines WHERE id = $1', [prepared.baselineId],
    )).rows).toEqual([{ status: 'prepared' }]);
    expect((await query(
      'SELECT baseline_id FROM pages WHERE id = $1', [pageId],
    )).rows).toEqual([{ baseline_id: null }]);
  });

  it('requires current space-manage authority rather than edit permission or a cached prior grant', async () => {
    const spaceKey = 'BASELINE-ROLE-SCOPE';
    await query('UPDATE pages SET space_key = $2 WHERE id = $1', [pageId, spaceKey]);
    const role = await query<{ id: number }>(
      `INSERT INTO roles (name, display_name, permissions)
       VALUES ('baseline-scope-role', 'Baseline scope role', ARRAY['read', 'edit'])
       RETURNING id`,
    );
    const roleId = role.rows[0]!.id;
    await query(
      `INSERT INTO space_role_assignments (space_key, principal_type, principal_id, role_id)
       VALUES ($1, 'user', $2, $3)`,
      [spaceKey, reader, roleId],
    );
    expect((await app.inject({
      method: 'GET', url: `/api/pages/${pageId}/freeze-preview`, headers: { 'x-test-user': reader },
    })).statusCode).toBe(403);
    await query("UPDATE roles SET permissions = ARRAY['read', 'edit', 'manage'] WHERE id = $1", [roleId]);
    const prepared = await preview(reader);
    const response = await freeze(prepared, reader);
    expect(response.statusCode, response.body).toBe(200);
    const state = PageLifecycleMutationResponseSchema.parse(response.json()).state;
    expect(state.canUnfreeze).toBe(true);
    await query(
      'DELETE FROM space_role_assignments WHERE space_key = $1 AND principal_id = $2',
      [spaceKey, reader],
    );
    expect((await thaw(state, reader)).statusCode).toBe(403);
    expect((await query(
      'SELECT baseline_id FROM pages WHERE id = $1', [pageId],
    )).rows).toEqual([{ baseline_id: prepared.baselineId }]);
    await query(
      `INSERT INTO space_role_assignments (space_key, principal_type, principal_id, role_id)
       VALUES ($1, 'user', $2, $3)`,
      [spaceKey, reader, roleId],
    );
    expect((await thaw(state, reader)).statusCode).toBe(200);
  });
});
