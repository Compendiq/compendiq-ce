/**
 * #1349 — call-site test: the standalone DELETE route reaches the attachment
 * cleanup on a HARD delete and never on a soft delete.
 *
 * Mock harness mirrors pages-crud-webhooks.test.ts; the cleanup's own
 * behaviour (both stores, the shared-keyspace guard) is covered against real
 * Postgres + a temp tree in
 * `core/services/standalone-attachment-cleanup.integration.test.ts`.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { ZodError } from 'zod';
import { pagesCrudRoutes } from './pages-crud.js';

vi.mock('../../core/services/redis-cache.js', () => ({
  RedisCache: class MockRedisCache {
    get = vi.fn().mockResolvedValue(null);
    set = vi.fn().mockResolvedValue(undefined);
    invalidate = vi.fn().mockResolvedValue(undefined);
    invalidateAcrossUsers = vi.fn().mockResolvedValue(undefined);
  },
}));

vi.mock('../../core/services/audit-service.js', () => ({
  logAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../core/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const mockGetClientForUser = vi.fn();
vi.mock('../../domains/confluence/services/sync-service.js', () => ({
  // #1623: the toggle helper the page/AI write paths consult.
  isConfluenceEnabled: vi.fn().mockResolvedValue(true),
  getClientForUser: (...args: unknown[]) => mockGetClientForUser(...args),
}));

vi.mock('../../core/services/content-converter.js', () => ({
  htmlToConfluence: vi.fn((html: string) => html),
  confluenceToHtml: vi.fn((html: string) => html),
  htmlToText: vi.fn((html: string) => html.replace(/<[^>]*>/g, '')),
}));

vi.mock('../../domains/confluence/services/attachment-handler.js', () => ({
  cleanPageAttachments: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../domains/llm/services/embedding-service.js', () => ({
  processDirtyPages: vi.fn().mockResolvedValue(undefined),
  isProcessingUser: vi.fn().mockReturnValue(false),
}));

const mockGetUserAccessibleSpaces = vi.fn();
vi.mock('../../core/services/rbac-service.js', () => ({
  getUserAccessibleSpaces: (...args: unknown[]) => mockGetUserAccessibleSpaces(...args),
}));

vi.mock('../../core/services/webhook-emit-hook.js', () => ({
  emitWebhookEvent: vi.fn(),
}));

const mockCleanupStandaloneDirs = vi.fn().mockResolvedValue(undefined);
vi.mock('../../core/services/standalone-attachment-cleanup.js', () => ({
  cleanupStandalonePageAttachmentDirs: (...args: unknown[]) => mockCleanupStandaloneDirs(...args),
}));

const mutationLockState = { active: false };
const mockWithAttachmentMutationLock = vi.fn();
vi.mock('../../core/services/attachment-snapshot-lock.js', () => ({
  withLocalAttachmentMutationLock: (...args: unknown[]) => mockWithAttachmentMutationLock(...args),
}));

const mockDiscardPageIcon = vi.fn().mockResolvedValue(undefined);
vi.mock('../../core/services/page-icon-store.js', () => ({
  discardPageIconForDeletedPage: (...args: unknown[]) => mockDiscardPageIcon(...args),
}));

const mockQueryFn = vi.fn();
/**
 * The transaction client.
 *
 * Since #1636 the standalone permanent branch is ONE data-modifying statement
 * — `WITH RECURSIVE d AS (…) DELETE FROM pages WHERE id IN (SELECT id FROM d
 * WHERE source = 'standalone' AND created_by_user_id = $2) RETURNING id,
 * visibility` — so there is no separate id SELECT to answer and the ids the
 * cleanup follows are exactly that statement's RETURNING set. The Confluence
 * path's own `DELETE FROM pages WHERE id = $1 RETURNING id` reads only its
 * `rowCount`, and since fixer r1 the icon discard keys off exactly that, so the
 * default has to model the RETURNING rather than hand back an empty set.
 */
const mockTxQueryFn = vi.fn();
/**
 * What the standalone DELETE reports having destroyed: the page itself plus one
 * cascaded sub-article. A single-row answer would make the cascade half of the
 * cleanup contract unobservable.
 */
const TX_DESTROYED_IDS = [42, 43];
/**
 * What a WALK of the same subtree would visit — one row more, standing in for a
 * row the statement's own guards skip (`source = 'standalone'`,
 * `created_by_user_id = $2`) while descending through it.
 *
 * Nothing in the route reads a bare walk any more, so this answers a statement
 * that is not currently sent. It is a deliberate trap rather than dead code: a
 * cleanup driven by the walk instead of by the DELETE's `RETURNING` would
 * `rm -rf` the attachment and icon directories of a row that is still LIVE and
 * holds the only copy of those bytes, and this branch is what makes that
 * regression fail the cases below instead of quietly passing them.
 */
const TX_WALKED_IDS = [42, 43, 44];
function answerTxStatement(sql: unknown, destroyed: number[], params?: unknown[]) {
  const text = typeof sql === 'string' ? sql : '';
  // #1636's ambiguity re-check under the attachment lock. Zero rows means the
  // subtree is safe to act on; a row here rolls the transaction back, which the
  // integration suite drives against real Postgres.
  if (/conflicting_page_id/.test(text)) {
    return Promise.resolve({ rows: [], rowCount: 0 });
  }
  if (/SELECT id FROM d\b/.test(text) && !/DELETE FROM/i.test(text)) {
    return Promise.resolve({
      rows: TX_WALKED_IDS.map((id) => ({ id })),
      rowCount: TX_WALKED_IDS.length,
    });
  }
  if (/DELETE FROM pages\b/i.test(text) && /RETURNING/i.test(text)) {
    // The standalone cascade is the `WITH RECURSIVE` form and reports its whole
    // batch; the Confluence path deletes the one id it bound.
    if (/^\s*WITH RECURSIVE/i.test(text)) {
      return Promise.resolve({
        rows: destroyed.map((id) => ({ id, visibility: 'private' })),
        rowCount: destroyed.length,
      });
    }
    const bound = params?.[0];
    const ids = typeof bound === 'number' ? [bound] : [];
    return Promise.resolve({ rows: ids.map((id) => ({ id })), rowCount: ids.length });
  }
  return Promise.resolve({ rows: [], rowCount: 0 });
}
function resetTxQuery(): void {
  mockTxQueryFn.mockImplementation((sql: unknown, params?: unknown[]) =>
    answerTxStatement(sql, TX_DESTROYED_IDS, params),
  );
}
resetTxQuery();
vi.mock('../../core/db/postgres.js', () => ({
  query: (...args: unknown[]) => mockQueryFn(...args),
  getPool: vi.fn().mockReturnValue({
    connect: () =>
      Promise.resolve({
        query: (...args: unknown[]) => mockTxQueryFn(...args),
        release: vi.fn(),
      }),
  }),
  runMigrations: vi.fn(),
  closePool: vi.fn(),
}));

const TEST_USER = 'user-1';

describe('#1349 standalone hard delete cleans attachment directories', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(sensible);
    app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
      if (error instanceof ZodError) {
        return reply.status(400).send({ error: 'Validation failed', details: error.issues });
      }
      return reply.status(error.statusCode ?? 500).send({ error: error.message });
    });
    app.decorate('authenticate', async (request: { userId: string; username: string; userRole: string }) => {
      request.userId = TEST_USER;
      request.username = 'testuser';
      request.userRole = 'user';
    });
    app.decorate('requireAdmin', async () => undefined);
    app.decorate('redis', {});
    await app.register(pagesCrudRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resetTxQuery();
    mockWithAttachmentMutationLock.mockImplementation(
      async (operation: (client: { query: typeof mockTxQueryFn }) => Promise<unknown>) => {
        mutationLockState.active = true;
        try {
          return await operation({ query: mockTxQueryFn });
        } finally {
          mutationLockState.active = false;
        }
      },
    );
    mockGetUserAccessibleSpaces.mockResolvedValue(['DEV']);
  });

  function stubStandalonePageLoad(): void {
    // SELECT loading the page row for DELETE /pages/:id.
    mockQueryFn.mockResolvedValueOnce({
      rows: [{
        id: 42,
        source: 'standalone',
        created_by_user_id: TEST_USER,
        confluence_id: null,
        space_key: null,
        visibility: 'private',
      }],
    });
    // Everything the route sends on the POOL afterwards. #1636's pre-flight
    // ambiguity check is answered explicitly with ZERO rows: a row there is a
    // 409 and the request never reaches the transaction at all.
    mockQueryFn.mockImplementation((sql: unknown) => {
      if (typeof sql === 'string' && /conflicting_page_id/.test(sql)) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      // pinned_pages sweep, the soft-delete cascade, the Confluence update.
      return Promise.resolve({ rows: [], rowCount: 1 });
    });
  }

  it('hard delete (permanent=true) removes the attachment directories of every id the DELETE destroyed', async () => {
    stubStandalonePageLoad();

    const response = await app.inject({ method: 'DELETE', url: '/api/pages/42?permanent=true' });

    expect(response.statusCode).toBe(200);
    // #1636: EVERY id the DELETE reported gets its directories collected — a
    // cascaded sub-article's bytes leak otherwise, and the daily sweep only
    // converges them much later.
    expect(mockCleanupStandaloneDirs.mock.calls.map(([pageId]) => pageId)).toEqual(
      TX_DESTROYED_IDS,
    );
    expect(mockCleanupStandaloneDirs).toHaveBeenCalledWith(
      43,
      expect.objectContaining({ query: mockTxQueryFn }),
    );
    // The icon directory goes with them, and THIS helper is what carries that
    // guarantee now: `cleanupStandalonePageAttachmentDirs` calls
    // `deletePageIconImage` unconditionally, on the same barrier-owning client
    // (its own behaviour is covered against real files in
    // `core/services/standalone-attachment-cleanup.integration.test.ts`). The
    // route's separate `discardPageIconForDeletedPage` call was therefore
    // removed from this path: a second pass would repeat the work OUTSIDE the
    // barrier the first one was ordered against.
    expect(mockDiscardPageIcon).not.toHaveBeenCalled();
  });

  /**
   * #1636 review hazard: the cleanup must never run for an id the transaction
   * did NOT destroy. The DELETE's own guards (`source = 'standalone'`,
   * `created_by_user_id = $2`) skip rows the walk descends THROUGH, so its
   * `RETURNING` is a subset of the subtree — and every skipped row is still
   * LIVE and still holds the only copy of its bytes.
   */
  it('cleans only the ids the DELETE’s RETURNING reported, never the walked subtree', async () => {
    stubStandalonePageLoad();
    // The walk reaches 42, 43 and 44 (`TX_WALKED_IDS`); only 42 was destroyed.
    mockTxQueryFn.mockImplementation((sql: unknown, params?: unknown[]) =>
      answerTxStatement(sql, [42], params),
    );

    const response = await app.inject({ method: 'DELETE', url: '/api/pages/42?permanent=true' });

    expect(response.statusCode).toBe(200);
    expect(mockCleanupStandaloneDirs.mock.calls.map(([pageId]) => pageId)).toEqual([42]);
    // The two survivors keep their directories — and their icons, which now
    // travel with the same helper.
    expect(mockCleanupStandaloneDirs).toHaveBeenCalledTimes(1);
    expect(mockDiscardPageIcon).not.toHaveBeenCalled();
  });

  it('keeps the shared attachment barrier across the hard-delete SQL and filesystem cleanup', async () => {
    stubStandalonePageLoad();
    mockCleanupStandaloneDirs.mockImplementationOnce(async (_pageId: number, client: unknown) => {
      expect(mutationLockState.active).toBe(true);
      expect(client).toEqual(expect.objectContaining({ query: mockTxQueryFn }));
    });

    const response = await app.inject({ method: 'DELETE', url: '/api/pages/42?permanent=true' });

    expect(response.statusCode).toBe(200);
    expect(mockWithAttachmentMutationLock).toHaveBeenCalledTimes(1);
    expect(mockTxQueryFn.mock.calls.some(([sql]) => /DELETE FROM pages\b/i.test(String(sql)))).toBe(true);
  });

  it('soft delete leaves the directories alone — the page is restorable', async () => {
    stubStandalonePageLoad();

    const response = await app.inject({ method: 'DELETE', url: '/api/pages/42' });

    expect(response.statusCode).toBe(200);
    expect(mockCleanupStandaloneDirs).not.toHaveBeenCalled();
    // …and the icon goes with the page, not with the trash visit.
    expect(mockDiscardPageIcon).not.toHaveBeenCalled();
  });

  /**
   * Review r2. `cleanPageAttachments` is keyed by `confluence_id`; the icon
   * store is keyed by `pages.id` and the #1349 sweep is structurally forbidden
   * to walk it, so a hard-deleted CONFLUENCE page's uploaded mark had nothing
   * that would ever collect it — the standalone path was wired in r1 and its
   * sibling was not. `pages-icon.ts`'s `assertCanEdit` accepts
   * `source === 'confluence'`, so such a mark really can exist.
   */
  describe('a hard-deleted Confluence page takes its icon with it', () => {
    function stubConfluencePageLoad(): void {
      mockQueryFn.mockResolvedValueOnce({
        rows: [{
          id: 77,
          source: 'confluence',
          created_by_user_id: TEST_USER,
          confluence_id: 'c-77',
          space_key: 'DEV',
          visibility: 'shared',
        }],
      });
      // The delete-intent UPDATE and everything after it.
      mockQueryFn.mockResolvedValue({ rows: [{ id: 77 }], rowCount: 1 });
      mockGetClientForUser.mockResolvedValue({ deletePage: vi.fn().mockResolvedValue(undefined) });
    }

    it('removes the icon directory keyed by pages.id', async () => {
      stubConfluencePageLoad();

      const response = await app.inject({ method: 'DELETE', url: '/api/pages/77' });

      expect(response.statusCode).toBe(200);
      expect(mockDiscardPageIcon).toHaveBeenCalledTimes(1);
      // The NUMERIC id, never the confluence_id the cache is keyed by.
      expect(mockDiscardPageIcon).toHaveBeenCalledWith(77);
    });

    /**
     * Fixer r1 — and ONLY when the row really went. The cleanup transaction's
     * catch deliberately does not rethrow (#766: the upstream delete already
     * happened, so the request still succeeds), so before this fix a rolled-back
     * transaction fell straight through into the discard: the row survived,
     * soft-deleted and restorable, while its mark — the only copy of those bytes
     * — was `rm -rf`'d. The same branch against real Postgres, a real BEFORE
     * DELETE trigger and real files is in
     * `pages-crud-delete-atomicity.integration.test.ts`.
     */
    it('keeps the icon when the cleanup transaction rolled back — the row is still there', async () => {
      stubConfluencePageLoad();
      mockTxQueryFn.mockImplementation((sql: unknown) => {
        if (typeof sql === 'string' && /DELETE FROM pages\b/i.test(sql)) {
          return Promise.reject(new Error('simulated post-upstream DB failure'));
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      });

      const response = await app.inject({ method: 'DELETE', url: '/api/pages/77' });

      // The user-visible outcome still succeeds (#766) — but the mark stays.
      expect(response.statusCode).toBe(200);
      expect(mockDiscardPageIcon).not.toHaveBeenCalled();
    });
  });
});
