/**
 * Integration tests for delete atomicity (#766) — `DELETE /api/pages/:id` and
 * `POST /api/pages/bulk/delete` against a REAL PostgreSQL.
 *
 * #766 production bug: the route called Confluence first and ran several
 * separate local statements afterwards with no transaction, so any
 * post-upstream failure stranded a live local row whose Confluence
 * counterpart was already gone — and nothing ever converged it. The fixed
 * ordering is:
 *
 *   1. record the delete intent locally (soft-delete, single atomic UPDATE);
 *   2. call Confluence (irreversible);
 *   3. upstream success/404 → finish hard cleanup in ONE transaction;
 *   4. upstream failure (non-404) → clear the soft-delete (neither side changed).
 *
 * These tests drive the real route against real rows. Only the Confluence
 * client (external HTTP boundary, via `getClientForUser`) and infrastructure
 * side-channels (Redis cache, audit log, webhook hook, attachment filesystem)
 * are stubbed. A post-upstream DB failure is simulated with a real BEFORE
 * DELETE trigger on `pages` — the database itself rejects the hard delete,
 * exactly like a mid-flight connection/constraint failure would.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { ZodError } from 'zod';
import {
  setupTestDb,
  truncateAllTables,
  teardownTestDb,
  isDbAvailable,
} from '../../test-db-helper.js';
import { query } from '../../core/db/postgres.js';
import { ConfluenceError } from '../../domains/confluence/services/confluence-client.js';

// --- Boundary mocks (everything else is real) ---

vi.mock('../../core/services/redis-cache.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/services/redis-cache.js')>()),
  RedisCache: class MockRedisCache {
    get = vi.fn().mockResolvedValue(null);
    set = vi.fn().mockResolvedValue(undefined);
    invalidate = vi.fn().mockResolvedValue(undefined);
    // Shared/Confluence mutations clear every user's cache (#893).
    invalidateAcrossUsers = vi.fn().mockResolvedValue(undefined);
  },
}));

vi.mock('../../core/services/audit-service.js', () => ({
  logAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../core/services/webhook-emit-hook.js', () => ({
  emitWebhookEvent: vi.fn(),
}));

// Attachment cleanup touches the filesystem — out of scope here.
vi.mock('../../domains/confluence/services/attachment-handler.js', () => ({
  cleanPageAttachments: vi.fn().mockResolvedValue(undefined),
  syncDrawioAttachments: vi.fn().mockResolvedValue(undefined),
  syncImageAttachments: vi.fn().mockResolvedValue(undefined),
  getMissingAttachments: vi.fn().mockResolvedValue([]),
  writeAttachmentCache: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../domains/llm/services/embedding-service.js', () => ({
  processDirtyPages: vi.fn().mockResolvedValue(undefined),
  isProcessingUser: vi.fn().mockReturnValue(false),
  computePageRelationships: vi.fn().mockResolvedValue(0),
}));

vi.mock('../../domains/knowledge/services/quality-worker.js', () => ({
  triggerQualityBatch: vi.fn().mockResolvedValue(undefined),
}));

const mockGetUserAccessibleSpaces = vi.fn();
vi.mock('../../core/services/rbac-service.js', () => ({
  getUserAccessibleSpaces: (...args: unknown[]) => mockGetUserAccessibleSpaces(...args),
  invalidateRbacCache: vi.fn().mockResolvedValue(undefined),
}));

// Stub ONLY the Confluence client factory; keep the rest of sync-service real
// so `__internal.purgeDeletedPages` exercises the genuine convergence path.
const mockGetClientForUser = vi.fn();
vi.mock('../../domains/confluence/services/sync-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../domains/confluence/services/sync-service.js')>();
  return {
    ...actual,
    getClientForUser: (...args: unknown[]) => mockGetClientForUser(...args),
  };
});

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

// --- Tests ---

describe.skipIf(!dbAvailable)('delete atomicity — no local/Confluence divergence (#766)', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    await setupTestDb();

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
    app.decorate('redis', {});
    const { pagesCrudRoutes } = await import('./pages-crud.js');
    await app.register(pagesCrudRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    await unblockPageDeletes(); // safety: never leak the trigger across tests
    await truncateAllTables();
    const res = await query<{ id: string }>(
      "INSERT INTO users (username, email, password_hash, role) VALUES ('del_user', 'del@test', 'x', 'user') RETURNING id",
    );
    userId = res.rows[0]!.id;
    mockGetUserAccessibleSpaces.mockResolvedValue(['DEV']);
  });

  // ── single delete ─────────────────────────────────────────────────────────

  it('hard-deletes the row and pins when the Confluence delete succeeds', async () => {
    const pageId = await insertPage('conf-ok');
    await insertPin(pageId);
    mockGetClientForUser.mockResolvedValue({ deletePage: vi.fn().mockResolvedValue(undefined) });

    const response = await app.inject({ method: 'DELETE', url: '/api/pages/conf-ok' });

    expect(response.statusCode).toBe(200);
    expect(response.json().message).toBe('Page deleted');
    expect(await getRow('conf-ok')).toBeNull();
    const pins = await query('SELECT 1 FROM pinned_pages WHERE page_id = $1', [pageId]);
    expect(pins.rowCount).toBe(0);
  });

  it('(b) leaves the article fully intact when the Confluence delete fails — intent rolled back, neither side changed', async () => {
    await insertPage('conf-5xx');
    const deletePage = vi.fn().mockRejectedValue(new ConfluenceError('Confluence API error: HTTP 503', 503));
    mockGetClientForUser.mockResolvedValue({ deletePage });

    const response = await app.inject({ method: 'DELETE', url: '/api/pages/conf-5xx' });

    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(deletePage).toHaveBeenCalledWith('conf-5xx');
    // The row survives AND is still live (the #766 delete intent was cleared).
    const row = await getRow('conf-5xx');
    expect(row).not.toBeNull();
    expect(row!.deleted_at).toBeNull();
    expect(await liveCount('conf-5xx')).toBe(1);
  });

  it('(d) #719 regression: a 404 from Confluence still completes the local removal', async () => {
    const pageId = await insertPage('conf-404');
    await insertPin(pageId);
    mockGetClientForUser.mockResolvedValue({
      deletePage: vi.fn().mockRejectedValue(new ConfluenceError('Resource not found', 404)),
    });

    const response = await app.inject({ method: 'DELETE', url: '/api/pages/conf-404' });

    expect(response.statusCode).toBe(200);
    expect(response.json().message).toBe('Page was already removed in Confluence — removed locally');
    expect(await getRow('conf-404')).toBeNull();
  });

  it('(a) upstream delete succeeds but the local hard-delete fails → article is hidden (soft-deleted), never a live orphan; sync purge converges it', async () => {
    await insertPage('conf-strand');
    mockGetClientForUser.mockResolvedValue({ deletePage: vi.fn().mockResolvedValue(undefined) });

    await blockPageDeletes();
    try {
      const response = await app.inject({ method: 'DELETE', url: '/api/pages/conf-strand' });

      // The user-visible outcome (gone on both sides) is achieved — no error.
      expect(response.statusCode).toBe(200);

      // Pre-#766 behaviour left this row LIVE (deleted_at NULL) forever. Now it
      // must be soft-deleted: invisible to every user-facing query.
      const row = await getRow('conf-strand');
      expect(row).not.toBeNull();
      expect(row!.deleted_at).not.toBeNull();
      expect(await liveCount('conf-strand')).toBe(0);
    } finally {
      await unblockPageDeletes();
    }

    // Convergence: the standard sync lifecycle purges soft-deleted rows after
    // 30 days — prove the leftover row is fully removed by the real purge path.
    // Purge re-confirms the page is gone upstream before the irreversible local
    // delete (#766 review); here the upstream GET answers 404 (page trashed and
    // hidden / purged), so the purge proceeds.
    await query("UPDATE pages SET deleted_at = NOW() - INTERVAL '31 days' WHERE confluence_id = 'conf-strand'");
    const purgeClient = {
      getPage: vi.fn().mockRejectedValue(new ConfluenceError('Resource not found', 404)),
    };
    await purgeDeletedPages(purgeClient as never, 'DEV');
    expect(purgeClient.getPage).toHaveBeenCalledWith('conf-strand');
    expect(await getRow('conf-strand')).toBeNull();
  });

  // ── bulk delete ───────────────────────────────────────────────────────────

  it('bulk: success + 404 are removed, a 5xx page stays fully live (intent rolled back per page)', async () => {
    await insertPage('bulk-ok');
    await insertPage('bulk-5xx');
    await insertPage('bulk-404');
    const deletePage = vi.fn().mockImplementation((id: string) => {
      if (id === 'bulk-5xx') return Promise.reject(new ConfluenceError('Confluence API error: HTTP 503', 503));
      if (id === 'bulk-404') return Promise.reject(new ConfluenceError('Resource not found', 404));
      return Promise.resolve(undefined);
    });
    mockGetClientForUser.mockResolvedValue({ deletePage });

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
    // The upstream-failed page is fully live — soft-delete intent rolled back.
    const survivor = await getRow('bulk-5xx');
    expect(survivor).not.toBeNull();
    expect(survivor!.deleted_at).toBeNull();
    expect(await liveCount('bulk-5xx')).toBe(1);
  });

  it('bulk (a): upstream deletes succeed but local cleanup fails → rows hidden (soft-deleted), never live orphans', async () => {
    await insertPage('bulk-strand-1');
    await insertPage('bulk-strand-2');
    mockGetClientForUser.mockResolvedValue({ deletePage: vi.fn().mockResolvedValue(undefined) });

    await blockPageDeletes();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/bulk/delete',
        payload: { ids: ['bulk-strand-1', 'bulk-strand-2'] },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.succeeded).toBe(2);
      expect(body.failed).toBe(0);

      for (const cid of ['bulk-strand-1', 'bulk-strand-2']) {
        const row = await getRow(cid);
        expect(row).not.toBeNull();
        expect(row!.deleted_at).not.toBeNull();
        expect(await liveCount(cid)).toBe(0);
      }
    } finally {
      await unblockPageDeletes();
    }
  });
});
