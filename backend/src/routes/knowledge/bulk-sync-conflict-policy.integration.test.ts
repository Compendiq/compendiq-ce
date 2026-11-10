/**
 * #1779 — `POST /pages/bulk/sync` applies the sync conflict policy to a local
 * (standalone) edit exactly like the scheduled sync does:
 *   - compendiq-wins keeps the local row,
 *   - manual-review queues the incoming version,
 *   - confluence-wins overwrites only after a `page_versions` snapshot of the
 *     local version — one the real version-history routes list, serve and
 *     restore — and audits `SYNC_OVERWROTE_LOCAL_EDITS`,
 *   - the local version number never decreases,
 *   - a page without a local edit gets the routine refresh (no audit), and the
 *     collaborative document is invalidated only when its body is replaced.
 *
 * Real PostgreSQL. The policy is the real `admin_settings` row read by the real
 * cached getter. The only fake is Confluence, served over HTTP from this file.
 * Fixture = the issue's reproduction: X unchanged upstream (v5), Y bumped to
 * v7, both edited locally through `PUT /pages/:id` while the integration was
 * off (v5 → v6), then the integration switched on in SQL.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { PageVersionDetailSchema, PageVersionsResponseSchema } from '@compendiq/contracts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { query } from '../../core/db/postgres.js';
import { htmlToText } from '../../core/services/content-converter.js';
import {
  _resetForTests as resetSyncConflictPolicy,
  initSyncConflictPolicyService,
  type SyncConflictPolicy,
} from '../../core/services/sync-conflict-policy-service.js';
import { encryptPat } from '../../core/utils/crypto.js';
import {
  insertTestRuntime,
  isDbAvailable,
  setupTestDb,
  teardownTestDb,
  truncateAllTables,
} from '../../test-db-helper.js';
import { buildKnowledgeTestApp, insertUser } from './pages.test-helpers.js';
import { pagesCrudRoutes } from './pages-crud.js';
import { pagesVersionRoutes } from './pages-versions.js';

const dbAvailable = await isDbAvailable();

interface UpstreamPage { title: string; version: number; storage: string }
const upstream = new Map<string, UpstreamPage>();
const server = createServer((request, response) => {
  request.resume();
  const segments = new URL(request.url ?? '/', 'http://confluence.test').pathname.split('/');
  response.setHeader('content-type', 'application/json');
  // Version list (`…/content/{id}/version`), imported when Version History opens.
  const listed = segments.at(-1) === 'version' ? upstream.get(segments.at(-2) ?? '') : undefined;
  if (request.method === 'GET' && listed) {
    const results = Array.from({ length: listed.version }, (_, index) => ({
      number: index + 1, when: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
      by: { displayName: 'carol' }, message: '',
    }));
    response.end(JSON.stringify({ results, size: results.length, _links: {} }));
    return;
  }
  const page = upstream.get(segments.at(-1) ?? '');
  if (request.method !== 'GET' || !page) {
    response.statusCode = 404;
    response.end('{}');
    return;
  }
  response.end(JSON.stringify({
    id: segments.at(-1), title: page.title, type: 'page', status: 'current',
    version: { number: page.version }, body: { storage: { value: page.storage } },
    ancestors: [], metadata: { labels: { results: [] } },
  }));
});

const X = { confluenceId: '8001', title: 'Page X', base: '<p>X v5</p>', edit: '<p>BOB STANDALONE EDIT 8001</p>' };
const Y = {
  confluenceId: '8002', title: 'Page Y', base: '<p>Y v5</p>', edit: '<p>BOB STANDALONE EDIT 8002</p>',
  upstream: '<p>Y upstream v7</p>',
};

interface PageRow {
  title: string;
  body_html: string;
  body_text: string;
  version: number;
  local_modified_at: Date | null;
  local_modified_by: string | null;
  last_synced: Date | null;
  conflict_pending: boolean;
}

describe.skipIf(!dbAvailable)('POST /pages/bulk/sync conflict policy (#1779)', () => {
  let app: FastifyInstance;
  let userId: string;
  let xId: number;
  let yId: number;

  const bulkSync = (ids: string[]) =>
    app.inject({ method: 'POST', url: '/api/pages/bulk/sync', payload: { ids } });

  async function setPolicy(policy: SyncConflictPolicy): Promise<void> {
    await query(
      `INSERT INTO admin_settings (setting_key, setting_value) VALUES ('sync_conflict_policy', $1)
       ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value`,
      [policy],
    );
    await initSyncConflictPolicyService();
  }

  async function seedSyncedPage(confluenceId: string, title: string, html: string, version: number): Promise<number> {
    const inserted = await query<{ id: number }>(
      `INSERT INTO pages (confluence_id, source, space_key, title, body_storage, body_html, body_text,
                          version, last_synced, inherit_perms)
       VALUES ($1, 'confluence', 'DEV', $2, $3, $3, $4, $5, NOW() - INTERVAL '1 hour', TRUE)
       RETURNING id`,
      [confluenceId, title, html, htmlToText(html), version],
    );
    return inserted.rows[0]!.id;
  }

  /** The issue's local edit: PUT with the integration off stays local (v5 → v6). */
  async function standaloneEdit(pageId: number, title: string, html: string): Promise<void> {
    await query('UPDATE user_settings SET confluence_enabled = FALSE WHERE user_id = $1', [userId]);
    const put = await app.inject({
      method: 'PUT', url: `/api/pages/${pageId}`, payload: { title, bodyHtml: html, version: 5 },
    });
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json()).toMatchObject({ version: 6 });
    await query('UPDATE user_settings SET confluence_enabled = TRUE WHERE user_id = $1', [userId]);
  }

  async function pageRow(id: number): Promise<PageRow> {
    const result = await query<PageRow>(
      `SELECT title, body_html, body_text, version, local_modified_at, local_modified_by,
              last_synced, conflict_pending
         FROM pages WHERE id = $1`,
      [id],
    );
    return result.rows[0]!;
  }

  async function versionsOf(id: number) {
    return (await query<{ version_number: number; title: string; body_html: string | null; body_text: string | null }>(
      `SELECT version_number, title, body_html, body_text FROM page_versions
        WHERE page_id = $1 ORDER BY version_number`,
      [id],
    )).rows;
  }

  async function pendingOf(id: number) {
    return (await query<{ confluence_version: number; body_storage: string; body_html: string; sync_run_id: string }>(
      `SELECT confluence_version, body_storage, body_html, sync_run_id FROM pending_sync_versions
        WHERE page_id = $1 ORDER BY detected_at, id`,
      [id],
    )).rows;
  }

  async function syncAuditsOf(id: number) {
    return (await query<{ action: string; user_id: string | null; metadata: Record<string, unknown> }>(
      `SELECT action, user_id, metadata FROM audit_log
        WHERE resource_type = 'page' AND resource_id = $1 AND action LIKE 'SYNC\\_%'
        ORDER BY created_at, id`,
      [String(id)],
    )).rows;
  }

  /** Version-history reads and restores stay local (no import, no Confluence push). */
  async function inStandaloneMode<T>(run: () => Promise<T>): Promise<T> {
    await query('UPDATE user_settings SET confluence_enabled = FALSE WHERE user_id = $1', [userId]);
    try {
      return await run();
    } finally {
      await query('UPDATE user_settings SET confluence_enabled = TRUE WHERE user_id = $1', [userId]);
    }
  }

  async function historyOf(id: number): Promise<string[]> {
    const listed = await app.inject({ method: 'GET', url: `/api/pages/${id}/versions` });
    expect(listed.statusCode, listed.body).toBe(200);
    return PageVersionsResponseSchema.parse(listed.json()).versions
      .map((entry) => `${entry.versionNumber}${entry.isCurrent ? ' (current)' : ''}`);
  }

  async function historyEntry(id: number, versionNumber: number) {
    const fetched = await app.inject({ method: 'GET', url: `/api/pages/${id}/versions/${versionNumber}` });
    expect(fetched.statusCode, fetched.body).toBe(200);
    return PageVersionDetailSchema.parse(fetched.json());
  }

  beforeAll(async () => {
    await setupTestDb();
    const listening = Promise.withResolvers<void>();
    server.once('error', listening.reject);
    server.listen(0, '127.0.0.1', listening.resolve);
    await listening.promise;
    app = await buildKnowledgeTestApp(() => userId, async (instance) => {
      await instance.register(pagesCrudRoutes, { prefix: '/api' });
      await instance.register(pagesVersionRoutes, { prefix: '/api' });
    });
  });

  beforeEach(async () => {
    await truncateAllTables();
    resetSyncConflictPolicy();
    upstream.clear();
    userId = await insertUser('bob');
    await query("INSERT INTO spaces (space_key, space_name, source) VALUES ('DEV', 'Development', 'confluence')");
    const role = (await query<{ id: number }>(
      "INSERT INTO roles (name, display_name, permissions) VALUES ('bulk-conflict-editor', 'Editor', ARRAY['read','edit']) RETURNING id",
    )).rows[0]!;
    await query(
      "INSERT INTO space_role_assignments (space_key, principal_type, principal_id, role_id) VALUES ('DEV', 'user', $1, $2)",
      [userId, role.id],
    );
    await query(
      `INSERT INTO user_settings (user_id, confluence_url, confluence_pat, confluence_enabled)
       VALUES ($1, $2, $3, TRUE)`,
      [userId, `http://127.0.0.1:${(server.address() as AddressInfo).port}`, encryptPat('test-pat')],
    );
    xId = await seedSyncedPage(X.confluenceId, X.title, X.base, 5);
    yId = await seedSyncedPage(Y.confluenceId, Y.title, Y.base, 5);
    upstream.set(X.confluenceId, { title: X.title, version: 5, storage: X.base });
    upstream.set(Y.confluenceId, { title: Y.title, version: 7, storage: Y.upstream });
  });

  afterEach(() => {
    resetSyncConflictPolicy();
  });

  afterAll(async () => {
    await app.close();
    server.closeAllConnections();
    const closed = Promise.withResolvers<void>();
    server.close((error) => (error ? closed.reject(error) : closed.resolve()));
    await closed.promise;
    await teardownTestDb();
  });

  it('compendiq-wins keeps both standalone edits, counts them as succeeded and audits kept_local', async () => {
    await standaloneEdit(xId, X.title, X.edit);
    await standaloneEdit(yId, Y.title, Y.edit);
    await setPolicy('compendiq-wins');
    const xBefore = await pageRow(xId);
    const yBefore = await pageRow(yId);

    const response = await bulkSync([X.confluenceId, Y.confluenceId]);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ succeeded: 2, failed: 0, errors: [] });
    const x = await pageRow(xId);
    expect(x.body_html).toBe(X.edit);
    expect(x.version).toBe(6);
    // Upstream-unchanged X and upstream-newer Y: the local rows are untouched.
    expect(x).toEqual(xBefore);
    expect(await pageRow(yId)).toEqual(yBefore);
    expect([...await pendingOf(xId), ...await pendingOf(yId)]).toEqual([]);
    expect([...await versionsOf(xId), ...await versionsOf(yId)]).toEqual([]);
    for (const [id, confluenceId] of [[xId, X.confluenceId], [yId, Y.confluenceId]] as const) {
      expect(await syncAuditsOf(id)).toEqual([{
        action: 'SYNC_CONFLICT_DETECTED',
        user_id: userId,
        metadata: expect.objectContaining({
          confluence_id: confluenceId, policy: 'compendiq-wins', resolution: 'kept_local',
          sync_run_id: expect.any(String),
        }),
      }]);
    }
  });

  it('manual-review queues the incoming version of both pages, keeps the local rows, and re-queues on every run', async () => {
    await standaloneEdit(xId, X.title, X.edit);
    await standaloneEdit(yId, Y.title, Y.edit);
    await setPolicy('manual-review');
    const xBefore = await pageRow(xId);

    const first = await bulkSync([X.confluenceId, Y.confluenceId]);

    expect(first.json()).toEqual({ succeeded: 2, failed: 0, errors: [] });
    const x = await pageRow(xId);
    expect(x.body_html).toBe(X.edit);
    expect(x).toEqual({ ...xBefore, conflict_pending: true });
    expect(await pageRow(yId)).toMatchObject({ body_html: Y.edit, version: 6, conflict_pending: true });
    const xQueue = await pendingOf(xId);
    const yQueue = await pendingOf(yId);
    // The scheduler queues an upstream-unchanged page with a local edit too;
    // the route reproduces that decision rather than inventing a second rule.
    expect(xQueue).toEqual([expect.objectContaining({ confluence_version: 5, body_storage: X.base, body_html: X.base })]);
    expect(yQueue).toEqual([expect.objectContaining({ confluence_version: 7, body_storage: Y.upstream, body_html: Y.upstream })]);
    const runId = xQueue[0]!.sync_run_id;
    expect(yQueue[0]!.sync_run_id).toBe(runId);
    for (const id of [xId, yId]) {
      expect(await syncAuditsOf(id)).toEqual([{
        action: 'SYNC_CONFLICT_DETECTED',
        user_id: userId,
        metadata: expect.objectContaining({ policy: 'manual-review', resolution: 'queued_for_review', sync_run_id: runId }),
      }]);
    }

    // Deliberate steady state: every run re-evaluates and stacks another row.
    const second = await bulkSync([Y.confluenceId]);
    expect(second.json()).toEqual({ succeeded: 1, failed: 0, errors: [] });
    const yQueueAfter = await pendingOf(yId);
    expect(yQueueAfter).toHaveLength(2);
    expect(yQueueAfter[1]!.sync_run_id).not.toBe(runId);
    expect(await pageRow(yId)).toMatchObject({ body_html: Y.edit, version: 6 });
  });

  it('confluence-wins overwrites only after snapshotting the local version, audits it, and never lowers the version', async () => {
    await standaloneEdit(xId, X.title, X.edit);
    await standaloneEdit(yId, Y.title, Y.edit);
    await setPolicy('confluence-wins');
    const xBefore = await pageRow(xId);
    const yBefore = await pageRow(yId);

    const response = await bulkSync([X.confluenceId, Y.confluenceId]);

    expect(response.json()).toEqual({ succeeded: 2, failed: 0, errors: [] });
    const x = await pageRow(xId);
    // Confluence is not ahead of X (5 < 6): the incoming body becomes a NEW live
    // version, so the snapshot of the local v6 stays ordinary history.
    expect(x.version).toBe(7);
    expect(x).toMatchObject({ body_html: X.base, local_modified_at: null, local_modified_by: null });
    expect(await pageRow(yId)).toMatchObject({ body_html: Y.upstream, version: 7, local_modified_at: null });
    expect(await versionsOf(xId)).toEqual([
      { version_number: 6, title: X.title, body_html: X.edit, body_text: htmlToText(X.edit) },
    ]);
    expect(await versionsOf(yId)).toEqual([
      { version_number: 6, title: Y.title, body_html: Y.edit, body_text: htmlToText(Y.edit) },
    ]);
    for (const [id, confluenceId, before] of [[xId, X.confluenceId, xBefore], [yId, Y.confluenceId, yBefore]] as const) {
      expect(await syncAuditsOf(id)).toEqual([{
        action: 'SYNC_OVERWROTE_LOCAL_EDITS',
        user_id: userId,
        metadata: expect.objectContaining({
          confluence_id: confluenceId, policy: 'confluence-wins',
          local_modified_at: before.local_modified_at!.toISOString(),
          last_synced: before.last_synced!.toISOString(),
          sync_run_id: expect.any(String),
        }),
      }]);
    }
    expect([...await pendingOf(xId), ...await pendingOf(yId)]).toEqual([]);
  });

  it.each([
    ['behind the local one (the issue\'s page X: 5 < 6)', 5, X.base],
    ['equal to the local one (6 = 6, edited in Confluence too)', 6, '<p>X carol upstream v6</p>'],
  ])('keeps the overwritten local edit listed, readable and restorable when Confluence\'s version is %s', async (
    _label, upstreamVersion, upstreamBody,
  ) => {
    upstream.set(X.confluenceId, { title: X.title, version: upstreamVersion, storage: upstreamBody });
    await standaloneEdit(xId, X.title, X.edit);
    await setPolicy('confluence-wins');

    expect((await bulkSync([X.confluenceId])).json()).toEqual({ succeeded: 1, failed: 0, errors: [] });

    // The incoming body is a NEW live version, so the local v6 stays ordinary history.
    expect(await pageRow(xId)).toMatchObject({ body_html: upstreamBody, version: 7 });
    const restored = await inStandaloneMode(async () => {
      expect(await historyOf(xId)).toEqual(['7 (current)', '6']);
      expect(await historyEntry(xId, 6)).toMatchObject({ bodyHtml: X.edit, isCurrent: false });
      return app.inject({ method: 'POST', url: `/api/pages/${xId}/versions/6/restore`, payload: {} });
    });
    expect(restored.statusCode, restored.body).toBe(200);
    expect(await pageRow(xId)).toMatchObject({ body_html: X.edit, version: 8 });
  });

  it('without a local edit the refresh is routine: no audit, no snapshot, no queue, and the version never decreases', async () => {
    // X is locally ahead (an earlier overwrite kept v6) but carries no local edit.
    await query('UPDATE pages SET version = 6 WHERE id = $1', [xId]);
    await setPolicy('manual-review');

    const response = await bulkSync([X.confluenceId, Y.confluenceId]);

    expect(response.json()).toEqual({ succeeded: 2, failed: 0, errors: [] });
    const x = await pageRow(xId);
    expect(x.version).toBe(6);
    expect(x).toMatchObject({ body_html: X.base, conflict_pending: false, local_modified_at: null });
    expect(await pageRow(yId)).toMatchObject({ body_html: Y.upstream, version: 7, conflict_pending: false });
    for (const id of [xId, yId]) {
      expect(await syncAuditsOf(id)).toEqual([]);
      expect(await versionsOf(id)).toEqual([]);
      expect(await pendingOf(id)).toEqual([]);
    }
  });

  it('leaves a local edit whose body already matches upstream untouched', async () => {
    // A title-only standalone edit: the body still equals Confluence's v5.
    await standaloneEdit(xId, 'Bob local title', X.base);
    await setPolicy('confluence-wins');
    const before = await pageRow(xId);

    const response = await bulkSync([X.confluenceId]);

    expect(response.json()).toEqual({ succeeded: 1, failed: 0, errors: [] });
    expect(before).toMatchObject({ title: 'Bob local title', version: 6 });
    expect(await pageRow(xId)).toEqual(before);
    expect(await versionsOf(xId)).toEqual([]);
    expect(await syncAuditsOf(xId)).toEqual([]);
  });

  it('invalidates the collaborative document only for the page whose body is replaced', async () => {
    await setPolicy('confluence-wins');
    // First refresh aligns both rows with the converter's exact output.
    expect((await bulkSync([X.confluenceId, Y.confluenceId])).json()).toMatchObject({ succeeded: 2, failed: 0 });
    await query(
      `INSERT INTO page_collaborative_docs (page_id, doc_state) VALUES ($1, '\\x01'::bytea), ($2, '\\x01'::bytea)`,
      [xId, yId],
    );
    upstream.set(Y.confluenceId, { title: Y.title, version: 8, storage: '<p>Y upstream v8</p>' });

    const response = await bulkSync([X.confluenceId, Y.confluenceId]);

    expect(response.json()).toEqual({ succeeded: 2, failed: 0, errors: [] });
    const docs = await query<{ page_id: number }>('SELECT page_id FROM page_collaborative_docs ORDER BY page_id');
    expect(docs.rows.map((row) => row.page_id)).toEqual([xId]);
  });

  it.each([
    ['other content', 'Older v6', '<p>an older v6</p>'],
    ['the same body under another title', 'Older title', X.edit],
  ])('refuses the overwrite when version history already holds %s for the local version', async (_label, title, html) => {
    await standaloneEdit(xId, X.title, X.edit);
    await setPolicy('confluence-wins');
    await query(
      `INSERT INTO page_versions (page_id, version_number, title, body_html, body_text)
       VALUES ($1, 6, $2, $3, $4)`,
      [xId, title, html, htmlToText(html)],
    );

    const response = await bulkSync([X.confluenceId]);

    // Reported like any per-page failure: HTTP 200 with the page in `errors`.
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ succeeded: 0, failed: 1 });
    expect(response.json().errors).toEqual([
      `Page ${X.confluenceId}: Version 6 in the page's version history already holds other content, `
      + 'so the local edit could not be stored there and was kept; it gets a new version number when the page is saved again',
    ]);
    expect(await pageRow(xId)).toMatchObject({ title: X.title, body_html: X.edit, version: 6 });
    expect(await versionsOf(xId)).toEqual([
      { version_number: 6, title, body_html: html, body_text: htmlToText(html) },
    ]);
    expect(await syncAuditsOf(xId)).toEqual([]);
  });

  it('stores the local edit in the body-less history row that opening Version History imported', async () => {
    // Opening Version History imports one metadata-only row per Confluence version.
    expect(await historyOf(yId)).toContain('5 (current)');
    expect((await versionsOf(yId)).map((entry) => [entry.version_number, entry.body_html]))
      .toEqual([1, 2, 3, 4, 5, 6, 7].map((number) => [number, null]));
    await standaloneEdit(yId, Y.title, Y.edit);
    await setPolicy('confluence-wins');

    const response = await bulkSync([Y.confluenceId]);

    expect(response.json()).toEqual({ succeeded: 1, failed: 0, errors: [] });
    expect(await pageRow(yId)).toMatchObject({ body_html: Y.upstream, version: 7, local_modified_at: null });
    expect((await versionsOf(yId)).find((entry) => entry.version_number === 6))
      .toEqual({ version_number: 6, title: Y.title, body_html: Y.edit, body_text: htmlToText(Y.edit) });
    expect(await syncAuditsOf(yId)).toEqual([expect.objectContaining({ action: 'SYNC_OVERWROTE_LOCAL_EDITS' })]);
    const restored = await inStandaloneMode(async () => {
      expect(await historyEntry(yId, 6)).toMatchObject({ bodyHtml: Y.edit, isCurrent: false });
      return app.inject({ method: 'POST', url: `/api/pages/${yId}/versions/6/restore`, payload: {} });
    });
    expect(restored.statusCode, restored.body).toBe(200);
    expect(await pageRow(yId)).toMatchObject({ body_html: Y.edit });
  });

  it('leaves a live collaborative session alone when the upstream version is not newer', async () => {
    // Snapshot-HTML drift under a live room is a false conflict (shared helper rule).
    await query("UPDATE pages SET body_html = '<p>X v5 (live snapshot)</p>' WHERE id = $1", [xId]);
    const runtimeId = await insertTestRuntime();
    await query(
      'INSERT INTO page_runtime_admissions (runtime_id, page_id, actor_id, lifecycle_revision) VALUES ($1, $2, $3, 0)',
      [runtimeId, xId, userId],
    );
    await setPolicy('confluence-wins');

    const response = await bulkSync([X.confluenceId]);

    expect(response.json()).toEqual({ succeeded: 1, failed: 0, errors: [] });
    expect(await pageRow(xId)).toMatchObject({ body_html: '<p>X v5 (live snapshot)</p>', version: 5 });
    expect(await syncAuditsOf(xId)).toEqual([]);
  });
});
