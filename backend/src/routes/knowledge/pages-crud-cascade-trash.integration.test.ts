/**
 * #1636 — trashing a standalone article cascades to its whole subtree.
 *
 * Before this, `DELETE /api/pages/:id` soft-deleted exactly one row. Its live
 * descendants kept `parent_id` pointing at the trashed row, so `GET
 * /api/pages/tree`'s `LEFT JOIN pages parent_page ON (…) AND
 * parent_page.deleted_at IS NULL` answered `parentId: null` for them and
 * `SidebarTreeView` rendered them as roots. `GET /api/pages/:id` could not see
 * the children at all (`has_children` matched `parent_id = confluence_id` only,
 * and standalone rows have no `confluence_id`), so no dialog could warn.
 *
 * These tests drive the real routes against a REAL PostgreSQL. Only
 * infrastructure side-channels (Redis cache, audit log, webhook hook, collab
 * tombstones) are stubbed, so the cascade, the tree query, `hasChildren` and
 * the restore batch are all the production SQL.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  setupTestDb,
  truncateAllTables,
  teardownTestDb,
  isDbAvailable,
} from '../../test-db-helper.js';
import { query } from '../../core/db/postgres.js';
import { subtreeIds } from '../../core/services/page-subtree.js';
import {
  insertUser,
  insertLocalSpace,
  insertStandalonePage,
  insertConfluencePage,
  buildKnowledgeTestApp,
} from './pages.test-helpers.js';

// --- Boundary mocks (everything else is real) ---

const mockCacheInvalidate = vi.fn();
const mockCacheInvalidateAcrossUsers = vi.fn();
vi.mock('../../core/services/redis-cache.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/services/redis-cache.js')>()),
  RedisCache: class MockRedisCache {
    get = vi.fn().mockResolvedValue(null);
    set = vi.fn().mockResolvedValue(undefined);
    invalidate = (...args: unknown[]) => mockCacheInvalidate(...args);
    invalidateAcrossUsers = (...args: unknown[]) => mockCacheInvalidateAcrossUsers(...args);
  },
}));

const mockLogAuditEvent = vi.fn().mockResolvedValue(undefined);
vi.mock('../../core/services/audit-service.js', () => ({
  logAuditEvent: (...args: unknown[]) => mockLogAuditEvent(...args),
}));

const mockEmitWebhookEvent = vi.fn();
vi.mock('../../core/services/webhook-emit-hook.js', () => ({
  emitWebhookEvent: (...args: unknown[]) => mockEmitWebhookEvent(...args),
}));

// The collab tombstone publishes over Redis (absent in tests) and is not this
// issue's subject — assert its CALL SITES, not its transport (#1444 owns it).
const mockTombstone = vi.fn().mockResolvedValue(undefined);
vi.mock('../../core/services/collab-tombstone.js', () => ({
  tombstoneCollabRoomAfterCommit: (...args: unknown[]) => mockTombstone(...args),
}));

const mockGetUserAccessibleSpaces = vi.fn();
vi.mock('../../core/services/rbac-service.js', () => ({
  getUserAccessibleSpaces: (...args: unknown[]) => mockGetUserAccessibleSpaces(...args),
  invalidateRbacCache: vi.fn().mockResolvedValue(undefined),
}));

const dbAvailable = await isDbAvailable();

/** The trios every case builds: fixture order is root → child → grandchild. */
interface Tree {
  root: number;
  child: number;
  grandchild: number;
}

async function seedStandaloneTree(owner: string, visibility: 'private' | 'shared' = 'private'): Promise<Tree> {
  const root = await insertStandalonePage('Root', visibility, owner, 'NOTES');
  const child = await insertStandalonePage('Child', visibility, owner, 'NOTES', { parentId: String(root) });
  const grandchild = await insertStandalonePage('Grandchild', visibility, owner, 'NOTES', {
    parentId: String(child),
  });
  return { root, child, grandchild };
}

/**
 * The batch key is `deleted_at` EQUALITY, so assert it in SQL:
 * `COUNT(DISTINCT deleted_at)` is exact at microsecond precision, which a JS
 * `Date` (millisecond) round-trip is not.
 */
async function distinctDeleteStamps(ids: number[]): Promise<number> {
  const res = await query<{ n: string }>(
    'SELECT COUNT(DISTINCT deleted_at)::text AS n FROM pages WHERE id = ANY($1::int[])',
    [ids],
  );
  return parseInt(res.rows[0]!.n, 10);
}

async function liveIds(ids: number[]): Promise<number[]> {
  const res = await query<{ id: number }>(
    'SELECT id FROM pages WHERE id = ANY($1::int[]) AND deleted_at IS NULL',
    [ids],
  );
  return res.rows.map((row) => row.id);
}

async function existingIds(ids: number[]): Promise<number[]> {
  const res = await query<{ id: number }>(
    'SELECT id FROM pages WHERE id = ANY($1::int[]) ORDER BY id',
    [ids],
  );
  return res.rows.map((row) => row.id);
}

async function treeItems(): Promise<Array<{ id: string; parentId: string | null }>> {
  const res = await app.inject({ method: 'GET', url: '/api/pages/tree' });
  expect(res.statusCode).toBe(200);
  return res.json().items as Array<{ id: string; parentId: string | null }>;
}

function deletedPayloads(): Array<{ pageId: number; isHardDelete: boolean }> {
  return mockEmitWebhookEvent.mock.calls
    .filter((call) => (call[0] as { eventType: string }).eventType === 'page.deleted')
    .map((call) => (call[0] as { payload: { pageId: number; isHardDelete: boolean } }).payload)
    .sort((a, b) => a.pageId - b.pageId);
}

async function auditCalls(action: string): Promise<unknown[][]> {
  return mockLogAuditEvent.mock.calls.filter((call) => call[1] === action);
}

let app: FastifyInstance;
let userA: string;
let userB: string;
let currentUserId: string;

describe.skipIf(!dbAvailable)('cascading standalone trash (#1636) — real PostgreSQL', () => {
  beforeAll(async () => {
    await setupTestDb();
    app = await buildKnowledgeTestApp(() => currentUserId, async (instance) => {
      const { pagesCrudRoutes } = await import('./pages-crud.js');
      await instance.register(pagesCrudRoutes, { prefix: '/api' });
    });
  });

  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    await truncateAllTables();
    userA = await insertUser('cascade_a');
    userB = await insertUser('cascade_b');
    currentUserId = userA;
    await insertLocalSpace('NOTES', userA);
    mockGetUserAccessibleSpaces.mockResolvedValue(['NOTES']);
  });

  // ── GET /api/pages/:id — hasChildren + descendantCount ────────────────────

  describe('GET /api/pages/:id', () => {
    it('reports hasChildren and descendantCount for a standalone parent with live sub-articles', async () => {
      const tree = await seedStandaloneTree(userA);

      const response = await app.inject({ method: 'GET', url: `/api/pages/${tree.root}` });
      expect(response.statusCode).toBe(200);

      const body = response.json() as { hasChildren: boolean; descendantCount: number };
      expect(body.hasChildren).toBe(true);
      expect(body.descendantCount).toBe(2);
    });

    it('counts only live descendants and agrees with hasChildren after a child is trashed on its own', async () => {
      const root = await insertStandalonePage('Root', 'private', userA, 'NOTES');
      await insertStandalonePage('Live child', 'private', userA, 'NOTES', { parentId: String(root) });
      await insertStandalonePage('Trashed child', 'private', userA, 'NOTES', {
        parentId: String(root),
        deletedAt: new Date(),
      });

      const response = await app.inject({ method: 'GET', url: `/api/pages/${root}` });
      const body = response.json() as { hasChildren: boolean; descendantCount: number };
      expect(body.hasChildren).toBe(true);
      expect(body.descendantCount).toBe(1);
    });

    it('reports hasChildren false and descendantCount 0 when every child is trashed', async () => {
      const root = await insertStandalonePage('Root', 'private', userA, 'NOTES');
      await insertStandalonePage('Trashed child', 'private', userA, 'NOTES', {
        parentId: String(root),
        deletedAt: new Date(),
      });

      const response = await app.inject({ method: 'GET', url: `/api/pages/${root}` });
      const body = response.json() as { hasChildren: boolean; descendantCount: number };
      expect(body.hasChildren).toBe(false);
      expect(body.descendantCount).toBe(0);
    });

    /**
     * The predicate must be the tree's dual-identifier join: a synced child's
     * `parent_id` holds its parent's `confluence_id`, not the parent's PK.
     */
    it('reports hasChildren for a synced child linked by confluence_id', async () => {
      const parent = await insertConfluencePage('conf-parent', 'Synced parent', 'NOTES');
      await insertConfluencePage('conf-child', 'Synced child', 'NOTES', { parentId: 'conf-parent' });

      const response = await app.inject({ method: 'GET', url: `/api/pages/${parent}` });
      const body = response.json() as { hasChildren: boolean; descendantCount: number };
      expect(body.hasChildren).toBe(true);
      expect(body.descendantCount).toBe(1);
    });

    /**
     * The walk `descendantCount` counts and the cascade trashes must be the
     * same set the Children macro renders — two separate CTEs, one tree.
     */
    it('walks the same subtree GET /pages/:id/children renders', async () => {
      const tree = await seedStandaloneTree(userA);
      await insertStandalonePage('Trashed child', 'private', userA, 'NOTES', {
        parentId: String(tree.root),
        deletedAt: new Date(),
      });

      const response = await app.inject({
        method: 'GET',
        url: `/api/pages/${tree.root}/children?depth=3`,
      });
      expect(response.statusCode).toBe(200);

      const rendered: number[] = [];
      const collect = (nodes: Array<{ id: number; children?: unknown[] }>): void => {
        for (const node of nodes) {
          rendered.push(node.id);
          collect((node.children ?? []) as Array<{ id: number; children?: unknown[] }>);
        }
      };
      collect(response.json().children as Array<{ id: number; children?: unknown[] }>);

      const walked = await subtreeIds(tree.root, { activeOnly: true });
      expect(rendered.sort()).toEqual(walked.filter((id) => id !== tree.root).sort());
    });

    it('keeps the deprecated has-children route in agreement with the field', async () => {
      const tree = await seedStandaloneTree(userA);

      const response = await app.inject({ method: 'GET', url: `/api/pages/${tree.root}/has-children` });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ hasChildren: true });

      // Same numeric normalisation as its sibling routes: a zero-padded id
      // resolves the page it denotes, it does not compare literally.
      const padded = await app.inject({
        method: 'GET',
        url: `/api/pages/00${tree.root}/has-children`,
      });
      expect(padded.statusCode).toBe(200);
      expect(padded.json()).toEqual({ hasChildren: true });
    });
  });

  // ── soft delete ───────────────────────────────────────────────────────────

  describe('DELETE /api/pages/:id (soft)', () => {
    it('trashes the whole standalone subtree under one delete stamp and hides it from the tree', async () => {
      const tree = await seedStandaloneTree(userA);
      const unrelatedParent = await insertConfluencePage('conf-other', 'Unrelated', 'NOTES');
      const unrelatedChild = await insertConfluencePage('conf-other-child', 'Unrelated child', 'NOTES', {
        parentId: 'conf-other',
      });

      const response = await app.inject({ method: 'DELETE', url: `/api/pages/${tree.root}` });
      expect(response.statusCode).toBe(200);

      const ids = [tree.root, tree.child, tree.grandchild];
      expect(await liveIds(ids)).toEqual([]);
      // ONE UPDATE → every row shares one `deleted_at`, which is the restore
      // batch key. Two statements would produce two stamps and break it.
      expect(await distinctDeleteStamps(ids)).toBe(1);

      const items = await treeItems();
      const treeIds = items.map((item) => item.id);
      expect(treeIds).not.toContain(String(tree.root));
      expect(treeIds).not.toContain(String(tree.child));
      expect(treeIds).not.toContain(String(tree.grandchild));

      // …and the Library, which is a different query with the same rule.
      const library = await app.inject({ method: 'GET', url: '/api/pages' });
      expect(library.statusCode).toBe(200);
      const libraryIds = (library.json().items as Array<{ id: string }>).map((item) => item.id);
      expect(libraryIds).not.toContain(String(tree.root));
      expect(libraryIds).not.toContain(String(tree.grandchild));

      // A Confluence subtree that shares the space is untouched, and its child
      // still resolves its parent — the cascade walks only the roots' subtree.
      expect(treeIds).toContain(String(unrelatedParent));
      expect(items.find((item) => item.id === String(unrelatedChild))?.parentId).toBe(
        String(unrelatedParent),
      );
    });

    it('trashes live grandchildren that sit under an already-trashed intermediate', async () => {
      const root = await insertStandalonePage('Root', 'private', userA, 'NOTES');
      const child = await insertStandalonePage('Child', 'private', userA, 'NOTES', {
        parentId: String(root),
        deletedAt: new Date('2020-01-01T00:00:00Z'),
      });
      const grandchild = await insertStandalonePage('Grandchild', 'private', userA, 'NOTES', {
        parentId: String(child),
      });

      const response = await app.inject({ method: 'DELETE', url: `/api/pages/${root}` });
      expect(response.statusCode).toBe(200);

      // The grandchild is exactly the orphan the stale walk would leave behind…
      expect(await liveIds([grandchild])).toEqual([]);
      // …and the already-trashed intermediate keeps ITS stamp, so the two rows
      // remain two batches (restore must not resurrect the child with the root).
      const stamps = await query<{ id: number; deleted_at: Date }>(
        'SELECT id, deleted_at FROM pages WHERE id = ANY($1::int[])',
        [[root, child]],
      );
      const byId = new Map(stamps.rows.map((row) => [row.id, row.deleted_at.getTime()]));
      expect(byId.get(child)).toBe(new Date('2020-01-01T00:00:00Z').getTime());
      expect(byId.get(root)).not.toBe(byId.get(child));
    });

    it('terminates when parent_id holds a cycle instead of hanging the request', async () => {
      const a = await insertStandalonePage('Cycle A', 'private', userA, 'NOTES');
      const b = await insertStandalonePage('Cycle B', 'private', userA, 'NOTES', { parentId: String(a) });
      await query('UPDATE pages SET parent_id = $1 WHERE id = $2', [String(b), a]);

      const response = await app.inject({ method: 'DELETE', url: `/api/pages/${a}` });

      expect(response.statusCode).toBe(200);
      expect(await liveIds([a, b])).toEqual([]);
    });

    it('emits one page.deleted webhook, one collab tombstone and one bounded audit row per request', async () => {
      const tree = await seedStandaloneTree(userA);

      await app.inject({ method: 'DELETE', url: `/api/pages/${tree.root}` });

      expect(deletedPayloads()).toEqual([
        { pageId: tree.root, isHardDelete: false },
        { pageId: tree.child, isHardDelete: false },
        { pageId: tree.grandchild, isHardDelete: false },
      ]);
      expect(mockTombstone.mock.calls.map((call) => call[0]).sort()).toEqual(
        [tree.root, tree.child, tree.grandchild].sort(),
      );

      // ONE audit row for the ROOT: audit rows are read by humans and must stay
      // bounded, so the payload carries a count, never a list of ids.
      const audits = await auditCalls('PAGE_DELETED');
      expect(audits).toHaveLength(1);
      expect(audits[0]![3]).toBe(String(tree.root));
      expect(audits[0]![4]).toMatchObject({ source: 'standalone', permanent: false, cascadedCount: 2 });
    });

    it('invalidates the pages cache exactly once — across users for a shared root, per-user for a private one', async () => {
      const shared = await seedStandaloneTree(userA, 'shared');
      await app.inject({ method: 'DELETE', url: `/api/pages/${shared.root}` });

      expect(mockCacheInvalidateAcrossUsers).toHaveBeenCalledTimes(1);
      expect(mockCacheInvalidateAcrossUsers).toHaveBeenCalledWith('pages');
      expect(mockCacheInvalidate).not.toHaveBeenCalled();

      vi.clearAllMocks();
      const priv = await seedStandaloneTree(userA);
      await app.inject({ method: 'DELETE', url: `/api/pages/${priv.root}` });

      expect(mockCacheInvalidate).toHaveBeenCalledTimes(1);
      expect(mockCacheInvalidate).toHaveBeenCalledWith(userA, 'pages');
      expect(mockCacheInvalidateAcrossUsers).not.toHaveBeenCalled();
    });

    it('clears the deleter’s pins across the cascade and leaves another user’s pin alone', async () => {
      const tree = await seedStandaloneTree(userA);
      await query('INSERT INTO pinned_pages (user_id, page_id) VALUES ($1, $2), ($1, $3)', [
        userA,
        tree.child,
        tree.grandchild,
      ]);
      await query('INSERT INTO pinned_pages (user_id, page_id) VALUES ($1, $2)', [userB, tree.child]);

      await app.inject({ method: 'DELETE', url: `/api/pages/${tree.root}` });

      const mine = await query('SELECT page_id FROM pinned_pages WHERE user_id = $1', [userA]);
      expect(mine.rows).toEqual([]);
      const theirs = await query('SELECT page_id FROM pinned_pages WHERE user_id = $1', [userB]);
      expect(theirs.rows).toEqual([{ page_id: tree.child }]);
    });

    it('reports the same descendant count the cascade actually trashes', async () => {
      const tree = await seedStandaloneTree(userA);

      const detail = await app.inject({ method: 'GET', url: `/api/pages/${tree.root}` });
      const promised = (detail.json() as { descendantCount: number }).descendantCount;

      await app.inject({ method: 'DELETE', url: `/api/pages/${tree.root}` });

      const trashed = await query<{ id: number }>(
        'SELECT id FROM pages WHERE deleted_at IS NOT NULL AND id <> $1',
        [tree.root],
      );
      expect(trashed.rows.map((row) => row.id)).toHaveLength(promised);
    });

    it('refuses to trash a page the caller does not own', async () => {
      const root = await insertStandalonePage('Root', 'private', userB, 'NOTES');
      currentUserId = userA;

      const response = await app.inject({ method: 'DELETE', url: `/api/pages/${root}` });

      expect(response.statusCode).toBe(403);
      expect(await liveIds([root])).toEqual([root]);
    });
  });

  // ── bulk delete ───────────────────────────────────────────────────────────

  /**
   * #1636 shares the same walk with the bulk path — leaving the orphan bug
   * installed in the second delete path is exactly what the issue's review
   * would have found. The RESPONSE CONTRACT is unchanged: `succeeded` counts
   * the SELECTION (that is what the `expectedCount` drift check is about),
   * while the EFFECT covers each selected page's live descendants.
   */
  describe('POST /api/pages/bulk/delete', () => {
    it('trashes the selection’s live descendants and still counts the selection', async () => {
      const tree = await seedStandaloneTree(userA);
      const solo = await insertStandalonePage('Solo', 'private', userA, 'NOTES');

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/bulk/delete',
        payload: { ids: [String(tree.root), String(solo)] },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json() as { succeeded: number; failed: number };
      expect(body.succeeded).toBe(2);
      expect(body.failed).toBe(0);

      expect(await liveIds([tree.root, tree.child, tree.grandchild, solo])).toEqual([]);
      // One statement → one batch stamp for the whole cascade.
      expect(await distinctDeleteStamps([tree.root, tree.child, tree.grandchild])).toBe(1);
      expect(deletedPayloads().map((payload) => payload.pageId).sort()).toEqual(
        [tree.root, tree.child, tree.grandchild, solo].sort(),
      );
    });
  });

  // ── hard delete ───────────────────────────────────────────────────────────

  describe('DELETE /api/pages/:id?permanent=true', () => {
    it('removes the whole subtree and emits one page.deleted per id', async () => {
      const tree = await seedStandaloneTree(userA);
      const unrelated = await insertStandalonePage('Unrelated', 'private', userA, 'NOTES');

      const response = await app.inject({
        method: 'DELETE',
        url: `/api/pages/${tree.root}?permanent=true`,
      });
      expect(response.statusCode).toBe(200);

      expect(await existingIds([tree.root, tree.child, tree.grandchild])).toEqual([]);
      expect(await existingIds([unrelated])).toEqual([unrelated]);
      expect(deletedPayloads()).toEqual([
        { pageId: tree.root, isHardDelete: true },
        { pageId: tree.child, isHardDelete: true },
        { pageId: tree.grandchild, isHardDelete: true },
      ]);
      const audits = await auditCalls('PAGE_DELETED');
      expect(audits).toHaveLength(1);
      expect(audits[0]![4]).toMatchObject({ source: 'standalone', permanent: true, cascadedCount: 2 });
    });

    it('sees a trashed subtree too — the row and its descendants are gone for good', async () => {
      const tree = await seedStandaloneTree(userA);
      await app.inject({ method: 'DELETE', url: `/api/pages/${tree.root}` });

      const response = await app.inject({
        method: 'DELETE',
        url: `/api/pages/${tree.root}?permanent=true`,
      });

      expect(response.statusCode).toBe(200);
      expect(await existingIds([tree.root, tree.child, tree.grandchild])).toEqual([]);
    });
  });

  // ── restore ───────────────────────────────────────────────────────────────

  describe('POST /api/pages/:id/restore', () => {
    it('restores the page and every descendant trashed with it', async () => {
      const tree = await seedStandaloneTree(userA);
      await app.inject({ method: 'DELETE', url: `/api/pages/${tree.root}` });

      const response = await app.inject({ method: 'POST', url: `/api/pages/${tree.root}/restore` });
      expect(response.statusCode).toBe(200);

      expect((await liveIds([tree.root, tree.child, tree.grandchild])).sort()).toEqual(
        [tree.root, tree.child, tree.grandchild].sort(),
      );
      const items = await treeItems();
      // The subtree is back UNDER its parent, not flattened to the root.
      expect(items.find((item) => item.id === String(tree.grandchild))?.parentId).toBe(String(tree.child));

      const audits = await auditCalls('PAGE_RESTORED');
      expect(audits).toHaveLength(1);
      expect(audits[0]![3]).toBe(String(tree.root));
      expect(audits[0]![4]).toMatchObject({ source: 'standalone', restoredCount: 3 });
    });

    it('leaves a descendant that was trashed separately in the trash', async () => {
      const root = await insertStandalonePage('Root', 'private', userA, 'NOTES');
      const frozen = await insertStandalonePage('Trashed long ago', 'private', userA, 'NOTES', {
        parentId: String(root),
        deletedAt: new Date('2020-01-01T00:00:00Z'),
      });
      const child = await insertStandalonePage('Child', 'private', userA, 'NOTES', {
        parentId: String(root),
      });

      await app.inject({ method: 'DELETE', url: `/api/pages/${root}` });
      const response = await app.inject({ method: 'POST', url: `/api/pages/${root}/restore` });

      expect(response.statusCode).toBe(200);
      expect((await liveIds([root, child])).sort()).toEqual([root, child].sort());
      // Different stamp → different batch. A person who trashed it earlier did
      // not ask for it back.
      expect(await liveIds([frozen])).toEqual([]);
    });

    it('answers 409 naming the ancestor when the ancestor chain is still trashed', async () => {
      const parent = await insertStandalonePage('Parent article', 'private', userA, 'NOTES');
      const child = await insertStandalonePage('Child article', 'private', userA, 'NOTES', {
        parentId: String(parent),
      });

      // The child is trashed on its own, then the parent is trashed — two
      // batches. Restoring the child alone would put it back at the root.
      await app.inject({ method: 'DELETE', url: `/api/pages/${child}` });
      await app.inject({ method: 'DELETE', url: `/api/pages/${parent}` });

      const response = await app.inject({ method: 'POST', url: `/api/pages/${child}/restore` });

      expect(response.statusCode).toBe(409);
      const body = response.json() as { error?: string; message?: string };
      expect(`${body.message ?? ''}${body.error ?? ''}`).toContain('Parent article');
      expect(await liveIds([child])).toEqual([]);
    });

    it('is idempotent for a page the caller already restored', async () => {
      const tree = await seedStandaloneTree(userA);
      await app.inject({ method: 'DELETE', url: `/api/pages/${tree.root}` });
      await app.inject({ method: 'POST', url: `/api/pages/${tree.root}/restore` });

      // A bulk restore fires one request per selected row and the first one
      // restores the whole batch — the sibling request must not report failure.
      const again = await app.inject({ method: 'POST', url: `/api/pages/${tree.child}/restore` });

      expect(again.statusCode).toBe(200);
      expect(await liveIds([tree.root, tree.child, tree.grandchild])).toHaveLength(3);
    });

    it('still refuses a page the caller does not own', async () => {
      const root = await insertStandalonePage('Root', 'private', userB, 'NOTES', {
        deletedAt: new Date(),
      });
      currentUserId = userA;

      const response = await app.inject({ method: 'POST', url: `/api/pages/${root}/restore` });

      expect(response.statusCode).toBe(403);
      expect(await liveIds([root])).toEqual([]);
    });
  });
});
