/**
 * Delete outcomes against real PostgreSQL, Redis, and attachment files.
 * The local row is hidden before irreversible Confluence I/O. A failed
 * response is not proof that the provider did nothing: retain the row, bytes,
 * and unresolved admission rather than reviving content or reporting success.
 * A confirmed remote delete does not make failed local cleanup a success.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { ZodError } from 'zod';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  setupTestDb,
  truncateAllTables,
  teardownTestDb,
  isDbAvailable,
  waitForDatabaseCondition,
} from '../../test-db-helper.js';
import { getPool, query } from '../../core/db/postgres.js';
import { ConfluenceClient } from '../../domains/confluence/services/confluence-client.js';
import { PAGE_ICON_STORE_DIRNAME } from '../../core/services/page-icon-store.js';
import { ATTACHMENT_SNAPSHOT_LOCK_ID } from '../../core/db/advisory-locks.js';
import { createClient, type RedisClientType } from 'redis';
import { encryptPat } from '../../core/utils/crypto.js';
import { setRedisClient } from '../../core/services/redis-cache.js';
import type * as Undici from 'undici';

const httpRequest = vi.hoisted(() => vi.fn());
vi.mock('undici', async (importOriginal) => ({
  ...(await importOriginal<typeof Undici>()),
  request: httpRequest,
}));

const CONFLUENCE_URL = 'https://confluence.delete.test';
const httpStatuses = new Map<string, number>();

const { __internal } = await import('../../domains/confluence/services/sync-service.js');
const { purgeDeletedPages } = __internal;

const dbAvailable = await isDbAvailable();

// --- Fixtures ---

let userId: string;

async function insertPage(confluenceId: string, spaceKey = 'DEV'): Promise<number> {
  const res = await query<{ id: number }>(
    `INSERT INTO pages (confluence_id, source, space_key, title, body_text,
                         body_storage, body_html, inherit_perms)
     VALUES ($1, 'confluence', $2, $3, 'text', '', '', TRUE)
     RETURNING id`,
    [confluenceId, spaceKey, `Page ${confluenceId}`],
  );
  return res.rows[0]!.id;
}

async function insertPin(pageId: number): Promise<void> {
  await query('INSERT INTO pinned_pages (user_id, page_id) VALUES ($1, $2)', [userId, pageId]);
}

/** Insert a standalone (non-Confluence) page owned by `ownerId`. */
async function insertStandalone(
  title: string,
  ownerId: string,
  visibility: 'private' | 'shared',
): Promise<number> {
  const res = await query<{ id: number }>(
    `INSERT INTO pages (source, title, body_text, body_storage, body_html,
                        created_by_user_id, visibility, version, page_type,
                        embedding_dirty, embedding_status, last_synced)
     VALUES ('standalone', $1, 'text', NULL, '<p>x</p>', $2, $3, 1, 'page', TRUE, 'not_embedded', NOW())
     RETURNING id`,
    [title, ownerId, visibility],
  );
  return res.rows[0]!.id;
}

async function getRowById(id: number): Promise<{ id: number; deleted_at: Date | null } | null> {
  const res = await query<{ id: number; deleted_at: Date | null }>(
    'SELECT id, deleted_at FROM pages WHERE id = $1',
    [id],
  );
  return res.rows[0] ?? null;
}

async function getRow(confluenceId: string): Promise<{ id: number; deleted_at: Date | null } | null> {
  const res = await query<{ id: number; deleted_at: Date | null }>(
    'SELECT id, deleted_at FROM pages WHERE confluence_id = $1',
    [confluenceId],
  );
  return res.rows[0] ?? null;
}

/** Count of rows a user-facing query would still surface (all list/tree/search
 *  queries filter `deleted_at IS NULL`). */
async function liveCount(confluenceId: string): Promise<number> {
  const res = await query<{ n: string }>(
    'SELECT COUNT(*) AS n FROM pages WHERE confluence_id = $1 AND deleted_at IS NULL',
    [confluenceId],
  );
  return parseInt(res.rows[0]!.n, 10);
}

/** Simulate a DB-side failure of the hard delete with a real trigger. */
async function blockPageDeletes(): Promise<void> {
  await query(`
    CREATE OR REPLACE FUNCTION test_block_page_delete() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION 'simulated post-upstream DB failure'; END
    $$ LANGUAGE plpgsql;
  `);
  await query(`
    CREATE TRIGGER test_block_page_delete
    BEFORE DELETE ON pages FOR EACH ROW
    EXECUTE FUNCTION test_block_page_delete();
  `);
}

async function unblockPageDeletes(): Promise<void> {
  await query('DROP TRIGGER IF EXISTS test_block_page_delete ON pages');
  await query('DROP FUNCTION IF EXISTS test_block_page_delete()');
}

/**
 * #1349 fixer r1 — the page-icon store on REAL disk.
 *
 * `discardPageIconForDeletedPage` is an `rm -rf` of `page-icons/<pages.id>/`
 * and migrations 095/096 persist only the sha, so those bytes are the only
 * copy: the store's own contract says "call it only where the ROW is gone".
 * These helpers let the delete tests assert the disk outcome of BOTH branches
 * (row destroyed → mark collected; transaction rolled back → mark kept),
 * which is only meaningful against the real `fs.rm` and the real trigger.
 */
let attachmentsDir: string;
let originalAttachmentsDir: string | undefined;

let redis: RedisClientType;
function iconDir(pageId: number): string {
  return path.join(attachmentsDir, PAGE_ICON_STORE_DIRNAME, String(pageId));
}

async function seedIcon(pageId: number): Promise<void> {
  await fs.mkdir(iconDir(pageId), { recursive: true });
  await fs.writeFile(path.join(iconDir(pageId), `${'a'.repeat(64)}.png`), 'mark-bytes');
}

async function iconExists(pageId: number): Promise<boolean> {
  try {
    await fs.stat(path.join(iconDir(pageId), `${'a'.repeat(64)}.png`));
    return true;
  } catch {
    return false;
  }
}

async function waitForAttachmentMutationWaiter(blockerPid: number): Promise<boolean> {
  return waitForDatabaseCondition(async () => {
    const result = await query<{ waiting: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM pg_locks
          WHERE locktype = 'advisory'
            AND mode = 'ShareLock'
            AND NOT granted
            AND classid = 0
            AND objid = $1
            AND $2 = ANY(pg_blocking_pids(pid))
       ) AS waiting`,
      [ATTACHMENT_SNAPSHOT_LOCK_ID, blockerPid],
    );
    return result.rows[0]?.waiting ?? false;
  });
}

// --- Tests ---

describe.skipIf(!dbAvailable)('delete atomicity — no local/Confluence divergence (#766)', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    await setupTestDb();

    originalAttachmentsDir = process.env.ATTACHMENTS_DIR;
    attachmentsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cq-delete-atomicity-'));
    process.env.ATTACHMENTS_DIR = attachmentsDir;
    vi.stubEnv('PAT_ENCRYPTION_KEY', 'delete-atomicity-disposable-key-over-32-characters');
    redis = createClient({ url: process.env.REDIS_URL, socket: { reconnectStrategy: false } });
    await redis.connect();
    setRedisClient(redis);

    app = Fastify({ logger: false });
    await app.register(sensible);
    app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
      if (error instanceof ZodError) {
        return reply.status(400).send({ error: 'Validation failed' });
      }
      return reply.status(error.statusCode ?? 500).send({ error: error.message });
    });
    app.decorate('authenticate', async (request: { userId: string }) => {
      request.userId = userId;
    });
    app.decorate('requireAdmin', async (request: { userId: string }) => {
      request.userId = userId;
    });
    app.decorate('redis', redis);
    const { pagesCrudRoutes } = await import('./pages-crud.js');
    await app.register(pagesCrudRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await redis.quit();
    await teardownTestDb();
    if (originalAttachmentsDir === undefined) delete process.env.ATTACHMENTS_DIR;
    else process.env.ATTACHMENTS_DIR = originalAttachmentsDir;
    await fs.rm(attachmentsDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  beforeEach(async () => {
    httpRequest.mockReset();
    httpStatuses.clear();
    httpRequest.mockImplementation(async (url: string, options: { method: string }) => {
      const parsed = new URL(url);
      if (parsed.origin !== CONFLUENCE_URL) throw new Error(`Unexpected outbound origin: ${parsed.origin}`);
      const statusCode = httpStatuses.get(`${options.method} ${parsed.pathname}`)
        ?? (options.method === 'DELETE' ? 204 : undefined);
      if (statusCode === undefined) throw new Error(`Unexpected outbound request: ${options.method} ${parsed.pathname}`);
      return {
        statusCode,
        headers: {},
        body: { text: async () => statusCode < 400 ? '' : JSON.stringify({ message: 'Upstream failure' }) },
      };
    });
    await unblockPageDeletes();
    await truncateAllTables();
    await redis.flushDb();
    const res = await query<{ id: string }>(
      "INSERT INTO users (username, email, password_hash, role) VALUES ('del_user', 'del@test', 'x', 'user') RETURNING id",
    );
    userId = res.rows[0]!.id;
    await query("INSERT INTO spaces (space_key, space_name) VALUES ('DEV', 'Development')");
    const role = await query<{ id: number }>(
      `INSERT INTO roles (name, display_name, permissions)
       VALUES ('delete-manager', 'Delete manager', ARRAY['read', 'write', 'delete', 'manage'])
       ON CONFLICT (name) DO UPDATE SET permissions = EXCLUDED.permissions RETURNING id`,
    );
    await query(
      `INSERT INTO space_role_assignments (space_key, principal_type, principal_id, role_id)
       VALUES ('DEV', 'user', $1, $2)`,
      [userId, role.rows[0]!.id],
    );
    await query(
      `INSERT INTO user_settings (user_id, confluence_url, confluence_pat, confluence_enabled)
       VALUES ($1, $2, $3, TRUE)`,
      [userId, CONFLUENCE_URL, encryptPat('disposable-confluence-pat')],
    );
  });

  // ── single delete ─────────────────────────────────────────────────────────

  it('keeps a permanent standalone delete and its directory cleanup behind one snapshot barrier', async () => {
    const pageId = await insertStandalone('Barrier delete', userId, 'private');
    const localDir = path.join(attachmentsDir, 'local', String(pageId));
    await fs.mkdir(localDir, { recursive: true });
    await fs.writeFile(path.join(localDir, 'diagram.png'), 'bytes');

    const holder = await getPool().connect();
    await holder.query('SELECT pg_advisory_lock($1)', [ATTACHMENT_SNAPSHOT_LOCK_ID]);
    const blockerPid = await holder
      .query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      .then((result) => result.rows[0]!.pid);
    let unlocked = false;
    try {
      const pending = app.inject({
        method: 'DELETE',
        url: `/api/pages/${pageId}?permanent=true`,
      });
      expect(await waitForAttachmentMutationWaiter(blockerPid)).toBe(true);
      expect(await getRowById(pageId)).not.toBeNull();
      await expect(fs.stat(path.join(localDir, 'diagram.png'))).resolves.toBeTruthy();

      await holder.query('SELECT pg_advisory_unlock($1)', [ATTACHMENT_SNAPSHOT_LOCK_ID]);
      unlocked = true;
      const response = await pending;

      expect(response.statusCode).toBe(200);
      expect(await getRowById(pageId)).toBeNull();
      await expect(fs.stat(localDir)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      if (!unlocked) {
        await holder.query('SELECT pg_advisory_unlock($1)', [ATTACHMENT_SNAPSHOT_LOCK_ID]);
      }
      holder.release();
    }
  });

  it('hard-deletes the row and pins when the Confluence delete succeeds', async () => {
    const pageId = await insertPage('conf-ok');
    await insertPin(pageId);
    await seedIcon(pageId);

    const response = await app.inject({ method: 'DELETE', url: '/api/pages/conf-ok' });

    expect(response.statusCode).toBe(200);
    expect(await getRow('conf-ok')).toBeNull();
    const pins = await query('SELECT 1 FROM pinned_pages WHERE page_id = $1', [pageId]);
    expect(pins.rowCount).toBe(0);
    // The row really is gone, so the mark has no owner left (#1349).
    expect(await iconExists(pageId)).toBe(false);
  });

  it('keeps an uncertain Confluence delete hidden and blocks a conflicting retry', async () => {
    const pageId = await insertPage('conf-5xx');
    await seedIcon(pageId);
    httpStatuses.set('DELETE /rest/api/content/conf-5xx', 503);

    const response = await app.inject({ method: 'DELETE', url: '/api/pages/conf-5xx' });

    expect(response.statusCode).toBe(503);
    const row = await getRow('conf-5xx');
    expect(row).not.toBeNull();
    expect(row!.deleted_at).not.toBeNull();
    expect(await liveCount('conf-5xx')).toBe(0);
    expect(await iconExists(pageId)).toBe(true);

    const attemptsBeforeRetry = httpRequest.mock.calls.length;
    const retry = await app.inject({ method: 'DELETE', url: '/api/pages/conf-5xx' });
    expect(retry.statusCode).toBe(409);
    expect(httpRequest.mock.calls).toHaveLength(attemptsBeforeRetry);
    const pending = await query<{ status: string }>(
      'SELECT status FROM page_write_intents WHERE page_ids @> ARRAY[$1]::int[]',
      [pageId],
    );
    expect(pending.rows).toEqual([{ status: 'pending' }]);
  });

  it('(d) #719 regression: a 404 from Confluence still completes the local removal', async () => {
    const pageId = await insertPage('conf-404');
    await insertPin(pageId);
    httpStatuses.set('DELETE /rest/api/content/conf-404', 404);

    const response = await app.inject({ method: 'DELETE', url: '/api/pages/conf-404' });

    expect(response.statusCode).toBe(200);
    expect(await getRow('conf-404')).toBeNull();
  });

  // #1623 — integration mode and encrypted credentials are real database state.
  it('integration off → destroys the local row and issues no Confluence delete', async () => {
    await query(
      'UPDATE user_settings SET confluence_enabled = FALSE WHERE user_id = $1',
      [userId],
    );
    const pageId = await insertPage('conf-off');
    await insertPin(pageId);

    const response = await app.inject({ method: 'DELETE', url: '/api/pages/conf-off' });

    expect(response.statusCode).toBe(200);
    // Gone locally…
    expect(await getRow('conf-off')).toBeNull();
    const pins = await query('SELECT 1 FROM pinned_pages WHERE page_id = $1', [pageId]);
    expect(pins.rowCount).toBe(0);
    expect(httpRequest).not.toHaveBeenCalled();
  });

  it('integration off → bulk delete destroys the local rows and issues no Confluence delete', async () => {
    await query(
      'UPDATE user_settings SET confluence_enabled = FALSE WHERE user_id = $1',
      [userId],
    );
    await insertPage('bulk-off-1');
    await insertPage('bulk-off-2');

    const response = await app.inject({
      method: 'POST',
      url: '/api/pages/bulk/delete',
      payload: { ids: ['bulk-off-1', 'bulk-off-2'] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ succeeded: 2, failed: 0 });
    expect(await getRow('bulk-off-1')).toBeNull();
    expect(await getRow('bulk-off-2')).toBeNull();
    expect(httpRequest).not.toHaveBeenCalled();
  });

  it('reports failed local cleanup after upstream deletion and keeps the hidden row and its bytes', async () => {
    const strandedId = await insertPage('conf-strand');
    await seedIcon(strandedId);

    await blockPageDeletes();
    try {
      const response = await app.inject({ method: 'DELETE', url: '/api/pages/conf-strand' });

      expect(response.statusCode).toBe(500);

      // Pre-#766 behaviour left this row LIVE (deleted_at NULL) forever. Now it
      // must be soft-deleted: invisible to every user-facing query.
      const row = await getRow('conf-strand');
      expect(row).not.toBeNull();
      expect(row!.deleted_at).not.toBeNull();
      expect(await liveCount('conf-strand')).toBe(0);

      // #1349 fixer r1: the transaction ROLLED BACK, so the row is still there
      // and still carries `icon_kind = 'image'`. Discarding the mark here would
      // destroy the only copy of the user's bytes for a page that still exists
      // — the icon store's own contract is "call it only where the ROW is gone".
      expect(await iconExists(strandedId)).toBe(true);
    } finally {
      await unblockPageDeletes();
    }

  });

  // ── bulk delete ───────────────────────────────────────────────────────────

  it('bulk reports independent success and 404 while retaining an uncertain 503 member', async () => {
    const okId = await insertPage('bulk-ok');
    const failedId = await insertPage('bulk-5xx');
    await insertPage('bulk-404');
    await seedIcon(okId);
    await seedIcon(failedId);
    httpStatuses.set('DELETE /rest/api/content/bulk-5xx', 503);
    httpStatuses.set('DELETE /rest/api/content/bulk-404', 404);

    const response = await app.inject({
      method: 'POST',
      url: '/api/pages/bulk/delete',
      payload: { ids: ['bulk-ok', 'bulk-5xx', 'bulk-404'] },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.succeeded).toBe(2);
    expect(body.failed).toBe(1);
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0]).toContain('bulk-5xx');

    // Upstream-deleted pages are hard-removed locally (one transaction).
    expect(await getRow('bulk-ok')).toBeNull();
    expect(await getRow('bulk-404')).toBeNull();
    // The uncertain member stays hidden with its files and pending admission.
    const survivor = await getRow('bulk-5xx');
    expect(survivor).not.toBeNull();
    expect(survivor!.deleted_at).not.toBeNull();
    expect(await liveCount('bulk-5xx')).toBe(0);
    // Marks follow their rows: destroyed for the page the commit removed, kept
    // for the page that survived upstream failure (#1349).
    expect(await iconExists(okId)).toBe(false);
    expect(await iconExists(failedId)).toBe(true);
  });

  it('bulk (a): upstream deletes succeed but local cleanup fails → rows hidden (soft-deleted), never live orphans', async () => {
    const strandedIds = [await insertPage('bulk-strand-1'), await insertPage('bulk-strand-2')];
    for (const id of strandedIds) await seedIcon(id);

    await blockPageDeletes();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/bulk/delete',
        payload: { ids: ['bulk-strand-1', 'bulk-strand-2'] },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.succeeded).toBe(0);
      expect(body.failed).toBe(2);

      for (const cid of ['bulk-strand-1', 'bulk-strand-2']) {
        const row = await getRow(cid);
        expect(row).not.toBeNull();
        expect(row!.deleted_at).not.toBeNull();
        expect(await liveCount(cid)).toBe(0);
      }
      // A failed DELETE cannot collect files whose row still exists.
      for (const id of strandedIds) expect(await iconExists(id)).toBe(true);
    } finally {
      await unblockPageDeletes();
    }
  });

  // ── bulk delete ownership (#861) ────────────────────────────────────────────

  it('bulk: a non-owner cannot trash another user\'s shared standalone page (#861)', async () => {
    // A second user A owns a SHARED standalone page. The request user (B) can
    // SEE it (shared standalone is visible to everyone) but must not be able to
    // delete it — mirroring the single-delete owner-only 403.
    const ownerA = (await query<{ id: string }>(
      "INSERT INTO users (username, email, password_hash, role) VALUES ('owner_a', 'a@test', 'x', 'user') RETURNING id",
    )).rows[0]!.id;
    const pageId = await insertStandalone('A shared page', ownerA, 'shared');

    const response = await app.inject({
      method: 'POST',
      url: '/api/pages/bulk/delete',
      payload: { ids: [String(pageId)] },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.succeeded).toBe(0);
    expect(body.failed).toBe(1);
    expect(body.errors).toHaveLength(1);

    // The page is untouched — still live.
    const row = await getRowById(pageId);
    expect(row).not.toBeNull();
    expect(row!.deleted_at).toBeNull();
  });

  it('ordinary aged trash with confirmed remote absence is purged with its icon', async () => {
    const pageId = await insertPage('ordinary-trash');
    await seedIcon(pageId);
    await query("UPDATE pages SET deleted_at = NOW() - INTERVAL '31 days' WHERE id = $1", [pageId]);
    httpStatuses.set('GET /rest/api/content/ordinary-trash', 404);

    await purgeDeletedPages(new ConfluenceClient(CONFLUENCE_URL, 'disposable-confluence-pat'), 'DEV');

    expect(await getRowById(pageId)).toBeNull();
    expect(await iconExists(pageId)).toBe(false);
  });

  it('bulk: an owner can still trash their own shared standalone page (#861)', async () => {
    // Positive companion: user B owns a SHARED standalone page and bulk-deletes
    // it — the owner check must not regress the normal path.
    const pageId = await insertStandalone('B shared page', userId, 'shared');

    const response = await app.inject({
      method: 'POST',
      url: '/api/pages/bulk/delete',
      payload: { ids: [String(pageId)] },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.succeeded).toBe(1);
    expect(body.failed).toBe(0);

    // Standalone bulk-delete is a soft-delete (move to trash).
    const row = await getRowById(pageId);
    expect(row).not.toBeNull();
    expect(row!.deleted_at).not.toBeNull();
  });
});
