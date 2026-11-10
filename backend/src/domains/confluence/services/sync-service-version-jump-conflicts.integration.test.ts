/**
 * #1772 — the version-jump branch of `syncPage` (upstream version ahead of the
 * local Confluence row) must honour the configured local-edit conflict policy,
 * and decide BEFORE the attachment cache is cleaned or anything is downloaded.
 *
 * Real PostgreSQL, the real `ConfluenceClient` against an in-process HTTP
 * fixture (the mocked Confluence boundary), a real attachment cache under a
 * temp ATTACHMENTS_DIR, and the real sync-conflict-policy service loaded from
 * `admin_settings`. The only other stub turns on the Enterprise RAG permission
 * flag so restriction sync is observable.
 *
 * Fixture = finding F9: page synced at v5, Bob saves locally while his
 * integration is off (PUT /api/pages/:id shape: body_html/body_text,
 * version + 1, local markers), then upstream moves to v7.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDbAvailable, setupTestDb, teardownTestDb, truncateAllTables } from '../../../test-db-helper.js';
import { getPool, query } from '../../../core/db/postgres.js';
import { attachmentCacheDir } from '../../../core/services/attachment-store.js';
import { setAiPolicyEnforcementForTest } from '../../../core/services/ai-policy-activation.js';
import type * as EnterpriseFeatures from '../../../core/enterprise/features.js';
import type * as EnterpriseLoader from '../../../core/enterprise/loader.js';
import {
  _resetForTests as resetSyncConflictPolicy,
  initSyncConflictPolicyService,
  type SyncConflictPolicy,
} from '../../../core/services/sync-conflict-policy-service.js';
import { ConfluenceClient, type ConfluencePage } from './confluence-client.js';
import { setRateLimit } from './confluence-rate-limiter.js';
import { __internal } from './sync-service.js';

// `syncPageRestrictions` is gated on the Enterprise RAG permission flag, which
// the CE no-op plugin always reports off. Turn that one feature on (the loader
// stub of sync-service.integration.test.ts) so every exit can be seen to run
// restriction sync; the fixture answers 404 for restrictions ("none").
vi.mock('../../../core/enterprise/loader.js', async () => {
  const actual = await vi.importActual<typeof EnterpriseLoader>('../../../core/enterprise/loader.js');
  const { ENTERPRISE_FEATURES } = await vi.importActual<typeof EnterpriseFeatures>(
    '../../../core/enterprise/features.js',
  );
  return {
    ...actual,
    isFeatureEnabled: (feature: string) =>
      feature === ENTERPRISE_FEATURES.RAG_PERMISSION_ENFORCEMENT || actual.isFeatureEnabled(feature),
  };
});

// The ordinary Confluence cache captures its root at module initialisation,
// so the fixture root must exist before the production import graph loads.
// `vi.hoisted` runs before static imports, so its built-ins load dynamically here.
const { attachmentsRoot, originalAttachmentsRoot } = await vi.hoisted(async () => {
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const attachmentsRoot = join(tmpdir(), `sync-version-jump-${globalThis.crypto.randomUUID()}`);
  const originalAttachmentsRoot = process.env.ATTACHMENTS_DIR;
  process.env.ATTACHMENTS_DIR = attachmentsRoot;
  return { attachmentsRoot, originalAttachmentsRoot };
});

const canRun = await isDbAvailable();
const SPACE = 'DOCS';
const RUN_1 = '11111111-1111-4111-8111-111111111111';
const RUN_2 = '22222222-2222-4222-8222-222222222222';
const BOB_HTML = '<p>BOB LOCAL EDIT while standalone</p>';
const BOB_TEXT = 'BOB LOCAL EDIT while standalone';
const UPSTREAM_STORAGE = '<p>A upstream v7</p><ac:image><ri:attachment ri:filename="diagram.png" /></ac:image>';

const upstreamPages = new Map<string, ConfluencePage>();
const upstreamFiles = new Map<string, Map<string, string>>();
const requestedPaths: string[] = [];
let beforeAttachmentList: ((confluenceId: string) => Promise<void>) | null = null;
let client: ConfluenceClient;
let actorId: string;
let bobId: string;

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://fixture.test');
  requestedPaths.push(url.pathname);
  const list = url.pathname.match(/^\/rest\/api\/content\/([^/]+)\/child\/attachment$/);
  if (list) {
    const id = decodeURIComponent(list[1]!);
    if (beforeAttachmentList) await beforeAttachmentList(id);
    const files = [...(upstreamFiles.get(id) ?? new Map<string, string>())];
    json(res, 200, {
      results: files.map(([title, bytes], index) => ({
        id: `att-${index + 1}`,
        title,
        mediaType: 'image/png',
        metadata: { mediaType: 'image/png' },
        extensions: { mediaType: 'image/png', fileSize: Buffer.byteLength(bytes) },
        _links: { download: `/download/${encodeURIComponent(id)}/${encodeURIComponent(title)}` },
        version: { number: 1, when: '2026-11-01T00:00:00.000Z' },
      })),
      start: 0, limit: 200, size: files.length, _links: {},
    });
    return;
  }
  const download = url.pathname.match(/^\/download\/([^/]+)\/([^/]+)$/);
  if (download) {
    const bytes = upstreamFiles.get(decodeURIComponent(download[1]!))?.get(decodeURIComponent(download[2]!));
    if (bytes === undefined) { json(res, 404, { message: 'missing fixture attachment' }); return; }
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': Buffer.byteLength(bytes) });
    res.end(bytes);
    return;
  }
  const pageMatch = url.pathname.match(/^\/rest\/api\/content\/([^/]+)$/);
  if (pageMatch) {
    const page = upstreamPages.get(decodeURIComponent(pageMatch[1]!));
    if (page) json(res, 200, page);
    else json(res, 404, { message: 'Not found upstream' });
    return;
  }
  json(res, 404, { message: `unhandled fixture path ${url.pathname}` });
}

const upstream = createServer((req, res) => {
  void handle(req, res).catch((error: unknown) => {
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: error instanceof Error ? error.message : String(error) }));
  });
});

async function usePolicy(policy: SyncConflictPolicy): Promise<void> {
  await query(
    `INSERT INTO admin_settings (setting_key, setting_value) VALUES ('sync_conflict_policy', $1)
     ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value, updated_at = NOW()`,
    [policy],
  );
  await initSyncConflictPolicyService();
}

/** Page synced at v5 an hour ago. */
async function seedSyncedV5(confluenceId: string): Promise<number> {
  const r = await query<{ id: number }>(
    `INSERT INTO pages (source, confluence_id, space_key, title, body_storage, body_html, body_text, version, last_synced)
     VALUES ('confluence', $1, $2, 'Runbook', '<p>A v5</p>', '<p>A v5</p>', 'A v5', 5, NOW() - INTERVAL '1 hour')
     RETURNING id`,
    [confluenceId, SPACE],
  );
  return r.rows[0]!.id;
}

/** Bob's standalone save: the columns PUT /api/pages/:id writes. */
async function bobSavesLocally(pageId: number, html = BOB_HTML, text = BOB_TEXT): Promise<void> {
  await query(
    `UPDATE pages SET body_html = $2, body_text = $3, version = version + 1,
            local_modified_at = NOW(), local_modified_by = $4
      WHERE id = $1`,
    [pageId, html, text, bobId],
  );
}

function upstreamPage(confluenceId: string, version = 7, title = 'Runbook'): ConfluencePage {
  return {
    id: confluenceId, title, status: 'current', type: 'page',
    version: { number: version, when: '2026-11-10T10:00:00.000Z', by: { displayName: 'Alice' } },
    body: { storage: { value: UPSTREAM_STORAGE } },
    ancestors: [],
    metadata: { labels: { results: [] } },
  };
}

/** A pasted image that only the local edit knows about, plus a stale upstream file. */
async function seedCache(confluenceId: string): Promise<void> {
  const dir = attachmentCacheDir(confluenceId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'bob-pasted.png'), 'bob pasted bytes');
  await writeFile(join(dir, 'diagram.png'), 'stale v5 bytes');
  upstreamFiles.set(confluenceId, new Map([['diagram.png', 'fresh v7 bytes']]));
}

async function seedCollabDoc(pageId: number): Promise<void> {
  await query(`INSERT INTO page_collaborative_docs (page_id, doc_state) VALUES ($1, '\\x01'::bytea)`, [pageId]);
}

async function cached(confluenceId: string, file: string): Promise<string | null> {
  try { return await readFile(join(attachmentCacheDir(confluenceId), file), 'utf8'); } catch { return null; }
}

async function row(pageId: number) {
  const r = await query<{
    title: string; body_html: string; body_text: string; version: number;
    local_modified_at: Date | null; local_modified_by: string | null;
    conflict_pending: boolean; conflict_detected_at: Date | null;
  }>(
    `SELECT title, body_html, body_text, version, local_modified_at, local_modified_by,
            conflict_pending, conflict_detected_at
       FROM pages WHERE id = $1`,
    [pageId],
  );
  return r.rows[0]!;
}

async function syncAudits(pageId: number): Promise<Array<{ action: string; metadata: Record<string, unknown> }>> {
  const r = await query<{ action: string; metadata: Record<string, unknown> }>(
    `SELECT action, metadata FROM audit_log
      WHERE resource_type = 'page' AND resource_id = $1
        AND action IN ('SYNC_CONFLICT_DETECTED', 'SYNC_OVERWROTE_LOCAL_EDITS')
      ORDER BY created_at, metadata->>'sync_run_id', action`,
    [String(pageId)],
  );
  return r.rows;
}

async function pending(pageId: number) {
  const r = await query<{ confluence_version: number; body_storage: string; body_html: string; sync_run_id: string }>(
    `SELECT confluence_version, body_storage, body_html, sync_run_id FROM pending_sync_versions
      WHERE page_id = $1 ORDER BY detected_at, sync_run_id`,
    [pageId],
  );
  return r.rows;
}

async function snapshots(pageId: number) {
  const r = await query<{ version_number: number; body_html: string | null }>(
    'SELECT version_number, body_html FROM page_versions WHERE page_id = $1 ORDER BY version_number',
    [pageId],
  );
  return r.rows;
}

async function snapshotTitles(pageId: number) {
  const r = await query<{ version_number: number; title: string }>(
    'SELECT version_number, title FROM page_versions WHERE page_id = $1 ORDER BY version_number',
    [pageId],
  );
  return r.rows;
}

async function collabDocStored(pageId: number): Promise<boolean> {
  const r = await query<{ present: boolean }>(
    'SELECT EXISTS (SELECT 1 FROM page_collaborative_docs WHERE page_id = $1) AS present',
    [pageId],
  );
  return r.rows[0]!.present;
}

async function runSync(page: ConfluencePage, runId: string) {
  const counts = { pagesCreated: 0, pagesUpdated: 0, pagesDeleted: 0 };
  await __internal.syncPage(client, actorId, SPACE, page, new Date(), new Map(), counts, runId);
  return counts;
}

const attachmentList = (confluenceId: string) => `/rest/api/content/${confluenceId}/child/attachment`;
const restrictionFetch = (confluenceId: string) => `/rest/api/content/${confluenceId}/restriction`;

/** Synced through a routine v6 jump, then renamed locally only (PUT shape: title, version + 1, markers). */
async function seedRenamedLocally(confluenceId: string): Promise<number> {
  const id = await seedSyncedV5(confluenceId);
  const v6 = upstreamPage(confluenceId, 6);
  upstreamPages.set(confluenceId, v6);
  await runSync(v6, RUN_1);
  await query(
    `UPDATE pages SET title = 'Bob local title', version = version + 1,
            local_modified_at = last_synced + INTERVAL '1 second', local_modified_by = $2
      WHERE id = $1`,
    [id, bobId],
  );
  return id;
}

describe.skipIf(!canRun)('#1772 version-jump sync honours the local-edit conflict policy', () => {
  beforeAll(async () => {
    await setupTestDb();
    const listening = Promise.withResolvers<void>();
    upstream.listen(0, '127.0.0.1', listening.resolve);
    await listening.promise;
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('Confluence fixture did not bind TCP');
    client = new ConfluenceClient(`http://127.0.0.1:${address.port}`, 'fixture-pat');
    // Every walk also fetches restrictions; the 60/min default bucket would stall the file.
    setRateLimit(600);
  }, 30_000);

  beforeEach(async () => {
    await truncateAllTables();
    await rm(attachmentsRoot, { recursive: true, force: true });
    await mkdir(attachmentsRoot, { recursive: true });
    upstreamPages.clear();
    upstreamFiles.clear();
    requestedPaths.length = 0;
    beforeAttachmentList = null;
    const users = await query<{ id: string; username: string }>(
      `INSERT INTO users (username, password_hash, role)
       VALUES ('vj-sync-actor', 'unused', 'admin'), ('vj-bob', 'unused', 'user')
       RETURNING id, username`,
    );
    actorId = users.rows.find((u) => u.username === 'vj-sync-actor')!.id;
    bobId = users.rows.find((u) => u.username === 'vj-bob')!.id;
    await query('INSERT INTO user_settings (user_id, confluence_enabled) VALUES ($1, TRUE), ($2, FALSE)', [actorId, bobId]);
    await query(`INSERT INTO spaces (space_key, space_name) VALUES ($1, 'Docs')`, [SPACE]);
  });

  afterEach(() => {
    resetSyncConflictPolicy();
  });

  afterAll(async () => {
    upstream.closeAllConnections();
    const closed = Promise.withResolvers<void>();
    upstream.close((error) => (error ? closed.reject(error) : closed.resolve()));
    await closed.promise;
    await teardownTestDb();
    setRateLimit(60);
    if (originalAttachmentsRoot === undefined) delete process.env.ATTACHMENTS_DIR;
    else process.env.ATTACHMENTS_DIR = originalAttachmentsRoot;
    await rm(attachmentsRoot, { recursive: true, force: true });
  });

  it('compendiq-wins keeps the local edit, audits kept_local and skips cleanup, download and snapshot', async () => {
    await usePolicy('compendiq-wins');
    const id = await seedSyncedV5('vj-keep');
    await bobSavesLocally(id);
    await seedCache('vj-keep');
    await seedCollabDoc(id);
    const page = upstreamPage('vj-keep');
    upstreamPages.set(page.id, page);

    const counts = await runSync(page, RUN_1);

    const after = await row(id);
    expect(after.body_html).toBe(BOB_HTML);
    expect(after).toMatchObject({ body_text: BOB_TEXT, version: 6, local_modified_by: bobId, conflict_pending: false });
    expect(after.local_modified_at).not.toBeNull();
    expect(await syncAudits(id)).toEqual([{
      action: 'SYNC_CONFLICT_DETECTED',
      metadata: { confluence_id: 'vj-keep', policy: 'compendiq-wins', resolution: 'kept_local', sync_run_id: RUN_1 },
    }]);
    expect(await pending(id)).toEqual([]);
    expect(await snapshots(id)).toEqual([]);
    expect(await cached('vj-keep', 'bob-pasted.png')).toBe('bob pasted bytes');
    expect(await cached('vj-keep', 'diagram.png')).toBe('stale v5 bytes');
    expect(requestedPaths).not.toContain(attachmentList('vj-keep'));
    expect(requestedPaths).toContain(restrictionFetch('vj-keep'));
    expect(await collabDocStored(id)).toBe(true);
    expect(counts).toEqual({ pagesCreated: 0, pagesUpdated: 0, pagesDeleted: 0 });
  });

  it('manual-review queues the incoming version and leaves the live row, cache and collab state untouched', async () => {
    await usePolicy('manual-review');
    const id = await seedSyncedV5('vj-queue');
    await bobSavesLocally(id);
    await seedCache('vj-queue');
    await seedCollabDoc(id);
    const page = upstreamPage('vj-queue');
    upstreamPages.set(page.id, page);

    const counts = await runSync(page, RUN_1);

    const queued = await pending(id);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ confluence_version: 7, body_storage: UPSTREAM_STORAGE, sync_run_id: RUN_1 });
    expect(queued[0]!.body_html).toContain('A upstream v7');
    const after = await row(id);
    expect(after).toMatchObject({ body_html: BOB_HTML, body_text: BOB_TEXT, version: 6, conflict_pending: true });
    expect(after.conflict_detected_at).not.toBeNull();
    expect(after.local_modified_at).not.toBeNull();
    expect(await syncAudits(id)).toEqual([{
      action: 'SYNC_CONFLICT_DETECTED',
      metadata: { confluence_id: 'vj-queue', policy: 'manual-review', resolution: 'queued_for_review', sync_run_id: RUN_1 },
    }]);
    expect(await snapshots(id)).toEqual([]);
    expect(await cached('vj-queue', 'bob-pasted.png')).toBe('bob pasted bytes');
    expect(await cached('vj-queue', 'diagram.png')).toBe('stale v5 bytes');
    expect(requestedPaths).not.toContain(attachmentList('vj-queue'));
    expect(requestedPaths).toContain(restrictionFetch('vj-queue'));
    expect(await collabDocStored(id)).toBe(true);
    expect(counts).toEqual({ pagesCreated: 0, pagesUpdated: 0, pagesDeleted: 0 });
  });

  it('confluence-wins overwrites after snapshotting the local version and audits SYNC_OVERWROTE_LOCAL_EDITS', async () => {
    await usePolicy('confluence-wins');
    const id = await seedSyncedV5('vj-overwrite');
    await bobSavesLocally(id);
    await seedCache('vj-overwrite');
    await seedCollabDoc(id);
    const page = upstreamPage('vj-overwrite');
    upstreamPages.set(page.id, page);

    const counts = await runSync(page, RUN_1);

    const after = await row(id);
    expect(after.body_html).toContain('A upstream v7');
    expect(after).toMatchObject({ version: 7, local_modified_at: null, local_modified_by: null });
    expect(await snapshots(id)).toEqual([{ version_number: 6, body_html: BOB_HTML }]);
    expect(await cached('vj-overwrite', 'diagram.png')).toBe('fresh v7 bytes');
    expect(requestedPaths).toContain(attachmentList('vj-overwrite'));
    expect(await collabDocStored(id)).toBe(false);
    expect(counts).toEqual({ pagesCreated: 0, pagesUpdated: 1, pagesDeleted: 0 });
    const audits = await syncAudits(id);
    expect(audits.map((a) => a.action)).toEqual(['SYNC_OVERWROTE_LOCAL_EDITS']);
    expect(audits[0]!.metadata).toMatchObject({ confluence_id: 'vj-overwrite', policy: 'confluence-wins', sync_run_id: RUN_1 });
    const { local_modified_at: localAt, last_synced: syncedAt } = audits[0]!.metadata as { local_modified_at: string; last_synced: string };
    expect(Date.parse(localAt)).toBeGreaterThan(Date.parse(syncedAt));
  });

  it.each(['confluence-wins', 'compendiq-wins', 'manual-review'] as const)(
    'without a local edit an upstream version jump stays a routine update with no audit (%s)',
    async (policy) => {
      await usePolicy(policy);
      const cid = `vj-routine-${policy}`;
      const id = await seedSyncedV5(cid);
      await seedCache(cid);
      await seedCollabDoc(id);
      // No local save bumped the row, so a single-step jump v5 → v6 is the version jump here.
      const page = upstreamPage(cid, 6);
      upstreamPages.set(page.id, page);

      const counts = await runSync(page, RUN_1);

      const after = await row(id);
      expect(after.body_html).toContain('A upstream v7');
      expect(after).toMatchObject({ version: 6, local_modified_at: null, conflict_pending: false });
      expect(await syncAudits(id)).toEqual([]);
      expect(await pending(id)).toEqual([]);
      expect(await snapshots(id)).toEqual([{ version_number: 5, body_html: '<p>A v5</p>' }]);
      expect(await cached(cid, 'diagram.png')).toBe('fresh v7 bytes');
      expect(await collabDocStored(id)).toBe(false);
      expect(counts).toEqual({ pagesCreated: 0, pagesUpdated: 1, pagesDeleted: 0 });
    },
  );

  it('a local-edit marker older than last_synced is not a local edit (compendiq-wins applies the jump)', async () => {
    await usePolicy('compendiq-wins');
    const id = await seedSyncedV5('vj-stale-marker');
    await query(`UPDATE pages SET local_modified_at = last_synced - INTERVAL '1 minute', local_modified_by = $2 WHERE id = $1`, [id, bobId]);
    const page = upstreamPage('vj-stale-marker', 6);
    upstreamPages.set(page.id, page);

    await runSync(page, RUN_1);

    expect(await row(id)).toMatchObject({ version: 6, local_modified_at: null });
    expect(await syncAudits(id)).toEqual([]);
  });

  it('compendiq-wins re-evaluates on every run while upstream stays ahead: one kept_local audit per run (deliberate steady state)', async () => {
    await usePolicy('compendiq-wins');
    const id = await seedSyncedV5('vj-keep-repeat');
    await bobSavesLocally(id);
    await seedCache('vj-keep-repeat');
    const page = upstreamPage('vj-keep-repeat');
    upstreamPages.set(page.id, page);

    await runSync(page, RUN_1);
    await runSync(page, RUN_2);

    expect((await syncAudits(id)).map((a) => [a.action, a.metadata.resolution, a.metadata.sync_run_id])).toEqual([
      ['SYNC_CONFLICT_DETECTED', 'kept_local', RUN_1],
      ['SYNC_CONFLICT_DETECTED', 'kept_local', RUN_2],
    ]);
    // The local row keeps its own (older) version, so every walk re-enters the version-jump branch.
    expect(await row(id)).toMatchObject({ body_html: BOB_HTML, version: 6 });
    expect(requestedPaths).not.toContain(attachmentList('vj-keep-repeat'));
  });

  it('manual-review stacks one pending version per run while upstream stays ahead (deliberate steady state)', async () => {
    await usePolicy('manual-review');
    const id = await seedSyncedV5('vj-queue-repeat');
    await bobSavesLocally(id);
    const page = upstreamPage('vj-queue-repeat');
    upstreamPages.set(page.id, page);

    await runSync(page, RUN_1);
    await runSync(page, RUN_2);

    expect((await pending(id)).map((p) => [p.confluence_version, p.sync_run_id])).toEqual([[7, RUN_1], [7, RUN_2]]);
    expect((await syncAudits(id)).map((a) => [a.metadata.resolution, a.metadata.sync_run_id])).toEqual([
      ['queued_for_review', RUN_1],
      ['queued_for_review', RUN_2],
    ]);
    expect(await row(id)).toMatchObject({ body_html: BOB_HTML, version: 6, conflict_pending: true });
  });

  it('a local save that lands while attachments download is not overwritten by that run; the next run decides on it', async () => {
    await usePolicy('confluence-wins');
    const id = await seedSyncedV5('vj-race');
    await seedCache('vj-race');
    const page = upstreamPage('vj-race');
    upstreamPages.set(page.id, page);
    const raceHtml = '<p>BOB EDIT DURING DOWNLOAD</p>';
    beforeAttachmentList = async (confluenceId) => {
      if (confluenceId === 'vj-race') await bobSavesLocally(id, raceHtml, 'BOB EDIT DURING DOWNLOAD');
    };

    const first = await runSync(page, RUN_1);

    expect((await row(id)).body_html).toBe(raceHtml);
    expect(await row(id)).toMatchObject({ version: 6 });
    expect(await syncAudits(id)).toEqual([]);
    expect(first).toEqual({ pagesCreated: 0, pagesUpdated: 0, pagesDeleted: 0 });
    expect(requestedPaths).toContain(restrictionFetch('vj-race'));

    beforeAttachmentList = null;
    const second = await runSync(page, RUN_2);

    expect(await row(id)).toMatchObject({ version: 7, local_modified_at: null });
    expect(await snapshots(id)).toContainEqual({ version_number: 6, body_html: raceHtml });
    expect((await syncAudits(id)).map((a) => [a.action, a.metadata.sync_run_id])).toEqual([
      ['SYNC_OVERWROTE_LOCAL_EDITS', RUN_2],
    ]);
    expect(second.pagesUpdated).toBe(1);
  });

  it('a concurrent writer that advances the row past the incoming version wins: no download, no version regression', async () => {
    await usePolicy('confluence-wins');
    const id = await seedSyncedV5('vj-advanced');
    await seedCache('vj-advanced');
    const page = upstreamPage('vj-advanced');
    upstreamPages.set(page.id, page);

    const blocker = await getPool().connect();
    let syncing: Promise<unknown> | undefined;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT 1 FROM pages WHERE id = $1 FOR UPDATE', [id]);
      syncing = runSync(page, RUN_1);
      await expect.poll(async () => {
        const waiting = await query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'`,
        );
        return waiting.rows[0]!.n;
      }, { timeout: 10_000 }).toBeGreaterThan(0);
      await blocker.query(
        `UPDATE pages SET version = 8, body_html = '<p>A v8 from another run</p>', body_text = 'A v8 from another run',
                last_synced = NOW(), local_modified_at = NULL, local_modified_by = NULL
          WHERE id = $1`,
        [id],
      );
      await blocker.query('COMMIT');
      await syncing;
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
      await syncing?.catch(() => undefined);
    }

    expect((await row(id)).version).toBe(8);
    expect((await row(id)).body_html).toBe('<p>A v8 from another run</p>');
    expect(requestedPaths).not.toContain(attachmentList('vj-advanced'));
    expect(requestedPaths).toContain(restrictionFetch('vj-advanced'));
    expect(await cached('vj-advanced', 'diagram.png')).toBe('stale v5 bytes');
  });

  it.each([
    ['compendiq-wins', 'kept_local'],
    ['manual-review', 'queued_for_review'],
  ] as const)('a title-only local edit with an equal body is a local edit on a version jump: %s gives %s', async (policy, resolution) => {
    await usePolicy(policy);
    const cid = `vj-title-${policy}`;
    const id = await seedRenamedLocally(cid);
    requestedPaths.length = 0;
    const page = upstreamPage(cid, 8, 'Alice upstream title');
    upstreamPages.set(cid, page);

    const counts = await runSync(page, RUN_2);

    const after = await row(id);
    expect(after).toMatchObject({ title: 'Bob local title', version: 7, conflict_pending: policy === 'manual-review' });
    expect(after.local_modified_at).not.toBeNull();
    expect((await syncAudits(id)).map((a) => [a.action, a.metadata.policy, a.metadata.resolution, a.metadata.sync_run_id]))
      .toEqual([['SYNC_CONFLICT_DETECTED', policy, resolution, RUN_2]]);
    expect((await pending(id)).map((p) => [p.confluence_version, p.sync_run_id]))
      .toEqual(policy === 'manual-review' ? [[8, RUN_2]] : []);
    expect(requestedPaths).not.toContain(attachmentList(cid));
    expect(requestedPaths).toContain(restrictionFetch(cid));
    expect(counts).toEqual({ pagesCreated: 0, pagesUpdated: 0, pagesDeleted: 0 });
  });

  it('a title-only local edit with an equal body is overwritten with SYNC_OVERWROTE_LOCAL_EDITS under confluence-wins', async () => {
    await usePolicy('confluence-wins');
    const id = await seedRenamedLocally('vj-title-overwrite');
    const page = upstreamPage('vj-title-overwrite', 8, 'Alice upstream title');
    upstreamPages.set(page.id, page);

    const counts = await runSync(page, RUN_2);

    expect((await syncAudits(id)).map((a) => [a.action, a.metadata.sync_run_id]))
      .toEqual([['SYNC_OVERWROTE_LOCAL_EDITS', RUN_2]]);
    expect(await row(id)).toMatchObject({ title: 'Alice upstream title', version: 8, local_modified_at: null });
    expect(await snapshotTitles(id)).toContainEqual({ version_number: 7, title: 'Bob local title' });
    expect(counts.pagesUpdated).toBe(1);
  });

  it('a local save that left body and title equal to upstream stays a routine version jump with no audit', async () => {
    await usePolicy('compendiq-wins');
    const id = await seedSyncedV5('vj-unchanged-save');
    const v6 = upstreamPage('vj-unchanged-save', 6);
    upstreamPages.set(v6.id, v6);
    await runSync(v6, RUN_1);
    // Bob saves without changing title or body (e.g. an edit he reverted).
    await query(
      `UPDATE pages SET version = version + 1,
              local_modified_at = last_synced + INTERVAL '1 second', local_modified_by = $2
        WHERE id = $1`,
      [id, bobId],
    );
    const page = upstreamPage('vj-unchanged-save', 8);
    upstreamPages.set(page.id, page);

    const counts = await runSync(page, RUN_2);

    expect(await row(id)).toMatchObject({ title: 'Runbook', version: 8, local_modified_at: null });
    expect(await syncAudits(id)).toEqual([]);
    expect(counts.pagesUpdated).toBe(1);
  });

  it('writes the overwrite audit before the collab reconcile, so a failing reconcile cannot drop it', async () => {
    await usePolicy('confluence-wins');
    const id = await seedSyncedV5('vj-collab-fault');
    await bobSavesLocally(id);
    const page = upstreamPage('vj-collab-fault');
    upstreamPages.set(page.id, page);
    await query(`CREATE FUNCTION vj_fail_collab_invalidate() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'collab invalidate fault'; END $$;
      CREATE TRIGGER vj_fail_collab_invalidate BEFORE DELETE ON page_collaborative_docs
      FOR EACH STATEMENT EXECUTE FUNCTION vj_fail_collab_invalidate()`);
    try {
      await expect(runSync(page, RUN_1)).rejects.toThrow('collab invalidate fault');
    } finally {
      await query('DROP TRIGGER vj_fail_collab_invalidate ON page_collaborative_docs; DROP FUNCTION vj_fail_collab_invalidate()');
    }

    // The upsert committed before the reconcile failed: the overwrite is on record.
    expect(await row(id)).toMatchObject({ version: 7, local_modified_at: null });
    expect((await syncAudits(id)).map((a) => a.action)).toEqual(['SYNC_OVERWROTE_LOCAL_EDITS']);
  });

  it.each(['compendiq-wins', 'manual-review'] as const)(
    'an upstream-only rename with an equal body and no local edit stays a routine version jump (%s)',
    async (policy) => {
      await usePolicy(policy);
      const cid = `vj-upstream-rename-${policy}`;
      const id = await seedSyncedV5(cid);
      const v6 = upstreamPage(cid, 6);
      upstreamPages.set(cid, v6);
      await runSync(v6, RUN_1);
      const page = upstreamPage(cid, 7, 'Alice renamed upstream');
      upstreamPages.set(cid, page);

      const counts = await runSync(page, RUN_2);

      expect(await row(id)).toMatchObject({
        title: 'Alice renamed upstream', version: 7, local_modified_at: null, conflict_pending: false,
      });
      expect(await syncAudits(id)).toEqual([]);
      expect(await pending(id)).toEqual([]);
      expect(counts.pagesUpdated).toBe(1);
    },
  );

  it('the skip exit still publishes the AI policy the walk observed, so a restrictive label is not lost', async () => {
    await usePolicy('confluence-wins');
    await setAiPolicyEnforcementForTest(true);
    try {
      const id = await seedSyncedV5('vj-race-policy');
      await seedCache('vj-race-policy');
      const page: ConfluencePage = {
        ...upstreamPage('vj-race-policy'),
        metadata: { labels: { results: [{ name: 'no-ai' }] } },
      };
      upstreamPages.set(page.id, page);
      beforeAttachmentList = async (confluenceId) => {
        if (confluenceId === 'vj-race-policy') await bobSavesLocally(id, '<p>EDIT DURING DOWNLOAD</p>', 'EDIT DURING DOWNLOAD');
      };

      const counts = await runSync(page, RUN_1);

      // No content write on the skip exit, but the restrictive label of this walk is applied.
      expect(await row(id)).toMatchObject({ body_html: '<p>EDIT DURING DOWNLOAD</p>', version: 6 });
      expect((await query<{ ai_policy: string }>('SELECT ai_policy FROM pages WHERE id = $1', [id])).rows[0]!.ai_policy)
        .toBe('none');
      expect(counts).toEqual({ pagesCreated: 0, pagesUpdated: 0, pagesDeleted: 0 });
    } finally {
      await setAiPolicyEnforcementForTest(false);
    }
  });
});
