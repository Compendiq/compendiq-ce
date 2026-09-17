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

// Only `POST /api/pages` needs this boundary, and only to make the mixed-source
// counterexample reachable through the real route (see the source-guard cases).
const mockConfluenceClient = vi.hoisted(() => ({ createPage: vi.fn() }));
vi.mock('../../domains/confluence/services/sync-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../domains/confluence/services/sync-service.js')>()),
  getClientForUser: vi.fn(async () => mockConfluenceClient),
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
      // …but a Confluence subtree is Confluence's lifecycle, and the trash
      // takes none of it: `hasChildren` is the tree's question, the count is
      // the cascade's, and the cascade moves `source = 'standalone'` rows only.
      expect(body.descendantCount).toBe(0);
    });

    /**
     * The count and the cascade are the same set, so a Confluence-sourced row
     * inside a standalone subtree must not be counted: the DELETE leaves it
     * live (its own guard — see the mixed-source delete case below). This shape
     * is reachable: `PUT /pages/:id/move` re-parents a synced page under a
     * standalone parent without touching its `source`, and `POST /pages` stores
     * one the same way, so the subtree is not source-pure in practice.
     */
    it('counts only the standalone descendants the cascade will actually trash', async () => {
      const root = await insertStandalonePage('Root', 'private', userA, 'NOTES');
      await insertConfluencePage('conf-in-tree', 'Synced child', 'NOTES', { parentId: String(root) });
      await insertStandalonePage('Local grandchild', 'private', userA, 'NOTES', {
        parentId: 'conf-in-tree',
      });

      const response = await app.inject({ method: 'GET', url: `/api/pages/${root}` });
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

    /**
     * The deprecated route resolves a page row, so it answers an existence
     * question — and must refuse the same callers its siblings refuse. Before
     * #1636 the handler could never 404 (`SELECT COUNT(*)` always returned a
     * row), so a 404 here is a NEW discriminator: without the access check it
     * becomes an existence oracle for a page `GET /api/pages/:id` will not
     * show, and it leaks `hasChildren` alongside it.
     */
    it('refuses a page the caller cannot read, exactly as its sibling routes do', async () => {
      const priv = await insertStandalonePage('Private', 'private', userA, 'NOTES');
      await insertStandalonePage('Child', 'private', userA, 'NOTES', { parentId: String(priv) });

      currentUserId = userB;
      for (const url of [
        `/api/pages/${priv}`,
        `/api/pages/${priv}/children`,
        `/api/pages/${priv}/has-children`,
      ]) {
        const response = await app.inject({ method: 'GET', url });
        expect(response.statusCode, url).toBe(404);
      }

      // …and a page the caller CAN read still answers, agreeing with the field.
      const shared = await insertStandalonePage('Shared', 'shared', userA, 'NOTES');
      await insertStandalonePage('Shared child', 'shared', userA, 'NOTES', { parentId: String(shared) });

      const answer = await app.inject({ method: 'GET', url: `/api/pages/${shared}/has-children` });
      expect(answer.statusCode).toBe(200);
      expect(answer.json()).toEqual({ hasChildren: true });

      const detail = await app.inject({ method: 'GET', url: `/api/pages/${shared}` });
      expect((detail.json() as { hasChildren: boolean }).hasChildren).toBe(true);
    });

    /**
     * The other source, and the same rule: a Confluence page is scoped by the
     * caller's space access, and a row with no `space_key` fails CLOSED — there
     * is nothing to check membership against.
     */
    it('scopes a Confluence page by the caller’s space access', async () => {
      const synced = await insertConfluencePage('conf-scoped', 'Synced', 'NOTES');
      await insertConfluencePage('conf-scoped-child', 'Synced child', 'NOTES', {
        parentId: 'conf-scoped',
      });
      const spaceless = await insertConfluencePage('conf-spaceless', 'No space', 'NOTES');
      await query('UPDATE pages SET space_key = NULL WHERE id = $1', [spaceless]);

      currentUserId = userB;
      mockGetUserAccessibleSpaces.mockResolvedValue(['OTHER']);
      expect(
        (await app.inject({ method: 'GET', url: `/api/pages/${synced}/has-children` })).statusCode,
      ).toBe(404);

      mockGetUserAccessibleSpaces.mockResolvedValue(['NOTES']);
      expect(
        (await app.inject({ method: 'GET', url: `/api/pages/${spaceless}/has-children` })).statusCode,
      ).toBe(404);

      const allowed = await app.inject({ method: 'GET', url: `/api/pages/${synced}/has-children` });
      expect(allowed.statusCode).toBe(200);
      expect(allowed.json()).toEqual({ hasChildren: true });
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

    /**
     * `source = 'standalone'` on the cascade's UPDATE is not decoration, and
     * the subtree it protects is not source-pure: a Confluence-sourced page can
     * sit inside a standalone one (`PUT /pages/:id/move` re-parents a synced
     * page under a standalone parent and keeps its source; `POST /pages` never
     * checks the parent's source either). Confluence owns that row's lifecycle
     * and its sync upsert would resurrect it, so the cascade walks THROUGH it —
     * the standalone grandchild below it must still be trashed — while leaving
     * the row itself alone.
     */
    it('walks through a Confluence-sourced row but leaves it live (the source guard)', async () => {
      const root = await insertStandalonePage('Root', 'private', userA, 'NOTES');
      const synced = await insertConfluencePage('conf-in-tree', 'Synced child', 'NOTES', {
        parentId: String(root),
      });
      const local = await insertStandalonePage('Local grandchild', 'private', userA, 'NOTES', {
        parentId: 'conf-in-tree',
      });

      const response = await app.inject({ method: 'DELETE', url: `/api/pages/${root}` });
      expect(response.statusCode).toBe(200);

      // The standalone row below the synced one went with the cascade…
      expect(await liveIds([root, local])).toEqual([]);
      // …and the Confluence-sourced row did not: the walk visited it, the
      // UPDATE's guard skipped it.
      expect(await liveIds([synced])).toEqual([synced]);
    });

    /**
     * The same shape created the way a person reaches it: `POST /api/pages`
     * with a Confluence-sourced body under a standalone parent never checks the
     * parent's source, and stores `parent_id = <parent PK>` with
     * `source = 'confluence'` (`PUT /pages/:id/move` re-parents identically).
     *
     * Two consequences, both STATED LIMITATIONS of this PR rather than bugs to
     * fix here — a bigger blast radius than #1636 (a synced subtree belongs to
     * Confluence, and its sync upsert resurrects anything trashed locally):
     *
     *   1. the guarded row survives the cascade with a `parent_id` pointing at
     *      a trashed parent, so `GET /api/pages/tree` renders it at the ROOT —
     *      the issue's orphan symptom, for mixed-source subtrees only;
     *   2. the confirm dialog warns about none of it, because
     *      `descendantCount` counts only the rows the cascade will take.
     *
     * Pinned so the documented limitation cannot drift from the wire behaviour.
     */
    it('leaves a Confluence-sourced child created under a standalone parent behind (stated limitation)', async () => {
      const root = await insertStandalonePage('Root', 'private', userA, 'NOTES');
      mockConfluenceClient.createPage.mockResolvedValue({
        id: '987654321',
        title: 'Synced child',
        version: { number: 1 },
        body: { storage: { value: '<p>x</p>' } },
      });

      const created = await app.inject({
        method: 'POST',
        url: '/api/pages',
        payload: {
          title: 'Synced child',
          bodyHtml: '<p>x</p>',
          spaceKey: 'NOTES',
          source: 'confluence',
          parentId: String(root),
        },
      });
      expect(created.statusCode).toBe(200);

      const syncedRows = await query<{ id: number; source: string; parent_id: string | null }>(
        'SELECT id, source, parent_id FROM pages WHERE confluence_id = $1',
        ['987654321'],
      );
      const synced = syncedRows.rows[0]!;
      expect(synced).toMatchObject({ source: 'confluence', parent_id: String(root) });

      // The detail route sees the child (the tree join is dual-identifier) and
      // still reports nothing for the trash to take.
      const detail = await app.inject({ method: 'GET', url: `/api/pages/${root}` });
      const detailBody = detail.json() as { hasChildren: boolean; descendantCount: number };
      expect(detailBody.hasChildren).toBe(true);
      expect(detailBody.descendantCount).toBe(0);

      const response = await app.inject({ method: 'DELETE', url: `/api/pages/${root}` });
      expect(response.statusCode).toBe(200);
      expect(await liveIds([synced.id])).toEqual([synced.id]);
      const items = await treeItems();
      expect(items.find((item) => item.id === String(synced.id))?.parentId).toBeNull();
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

    /**
     * The permanent path's guard is the second half of the same rule as the
     * soft cascade's: a Confluence-sourced row inside a standalone subtree is
     * destroyed by neither. Its standalone descendants still go with the
     * subtree — the walk visits the synced row, the DELETE's `source` guard
     * skips it.
     */
    it('destroys the standalone rows below a Confluence-sourced one, and only those', async () => {
      const root = await insertStandalonePage('Root', 'private', userA, 'NOTES');
      const synced = await insertConfluencePage('conf-in-tree', 'Synced child', 'NOTES', {
        parentId: String(root),
      });
      const local = await insertStandalonePage('Local grandchild', 'private', userA, 'NOTES', {
        parentId: 'conf-in-tree',
      });

      const response = await app.inject({
        method: 'DELETE',
        url: `/api/pages/${root}?permanent=true`,
      });
      expect(response.statusCode).toBe(200);

      expect(await existingIds([root, local])).toEqual([]);
      expect(await existingIds([synced])).toEqual([synced]);
      expect(deletedPayloads().map((payload) => payload.pageId).sort()).toEqual([root, local].sort());
    });

    /**
     * The pin sweep is scoped to what the DELETE actually removed, never to the
     * walked subtree: the walk visits the Confluence-sourced row the `source`
     * guard skips, and sweeping the walked set would destroy the deleter's own
     * pin on a page that is still live. A pin is visible in the UI
     * (`pinned-pages.ts` filters `deleted_at IS NULL`) and never comes back, so
     * that is unrelated user data — and the soft path, which keys off the
     * UPDATE's `RETURNING`, keeps it. The two delete paths must not disagree.
     */
    it('keeps the deleter’s pin on a Confluence-sourced descendant the hard delete leaves live', async () => {
      const root = await insertStandalonePage('Root', 'private', userA, 'NOTES');
      const synced = await insertConfluencePage('conf-in-tree', 'Synced child', 'NOTES', {
        parentId: String(root),
      });
      const local = await insertStandalonePage('Local grandchild', 'private', userA, 'NOTES', {
        parentId: 'conf-in-tree',
      });
      await query('INSERT INTO pinned_pages (user_id, page_id) VALUES ($1, $2), ($1, $3)', [
        userA,
        synced,
        local,
      ]);

      const response = await app.inject({
        method: 'DELETE',
        url: `/api/pages/${root}?permanent=true`,
      });
      expect(response.statusCode).toBe(200);

      // The synced row survived the delete, so its pin must survive it too —
      // the pin rows of the destroyed pages go with them.
      expect(await existingIds([synced])).toEqual([synced]);
      const mine = await query<{ page_id: number }>(
        'SELECT page_id FROM pinned_pages WHERE user_id = $1 ORDER BY page_id',
        [userA],
      );
      expect(mine.rows).toEqual([{ page_id: synced }]);
      expect(await existingIds([root, local])).toEqual([]);
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
      const body = response.json() as { error?: string; message?: string; reason?: string };
      expect(`${body.message ?? ''}${body.error ?? ''}`).toContain('Parent article');
      // The client branches on the reason, not on the prose: 409 is also the
      // answer to a permanent refusal (a live import of the same page).
      expect(body.reason).toBe('restore_ancestor_trashed');
      expect(await liveIds([child])).toEqual([]);
    });

    /**
     * The title is the ANCESTOR's, and the ancestor is not necessarily the
     * caller's page: `POST /pages` happily hangs a page under someone else's
     * (a cascade still trashes the whole subtree, which is #1636's point). The
     * refusal must not turn that into an existence/name oracle for a page the
     * caller cannot read — the same 404 rule `GET /api/pages/:id` applies.
     */
    it('refuses without naming an ancestor the caller cannot read', async () => {
      const aliceRoot = await insertStandalonePage('ALICE SECRET LEDGER', 'private', userA, 'NOTES');
      const bobChild = await insertStandalonePage('Bob draft', 'private', userB, 'NOTES', {
        parentId: String(aliceRoot),
      });

      // Alice trashes her private page; the cascade takes Bob's page with it.
      currentUserId = userA;
      await app.inject({ method: 'DELETE', url: `/api/pages/${aliceRoot}` });
      expect(await liveIds([bobChild])).toEqual([]);

      currentUserId = userB;
      const response = await app.inject({ method: 'POST', url: `/api/pages/${bobChild}/restore` });

      expect(response.statusCode).toBe(409);
      const body = response.json() as { message?: string; reason?: string };
      expect(body.message ?? '').not.toContain('ALICE SECRET LEDGER');
      expect(body.message).toMatch(/parent page/i);
      expect(body.reason).toBe('restore_ancestor_trashed');
      expect(await liveIds([bobChild])).toEqual([]);
    });

    /**
     * The reader rule for a Confluence-sourced ancestor is the space scope
     * `GET /api/pages/:id` applies to one — and it must fail closed: a
     * Confluence row with no space is a title the caller cannot be given.
     * (The row is TRASHED, so `userCanAccessPage`, which resolves pages with
     * `deleted_at IS NULL`, cannot answer this.)
     */
    it('scopes a Confluence-sourced ancestor by the caller’s space access', async () => {
      const synced = await insertConfluencePage('conf-ancestor', 'Synced ancestor', 'NOTES', {
        deletedAt: new Date(),
      });
      const child = await insertStandalonePage('Child article', 'private', userA, 'NOTES', {
        parentId: 'conf-ancestor',
        deletedAt: new Date(),
      });

      const readable = await app.inject({ method: 'POST', url: `/api/pages/${child}/restore` });
      expect(readable.statusCode).toBe(409);
      // `inject().json()` is untyped; only the refusal's prose is read here.
      const readableBody = readable.json() as { message?: string };
      expect(readableBody.message).toContain('Synced ancestor');

      mockGetUserAccessibleSpaces.mockResolvedValue(['OTHER']);
      const unreadable = await app.inject({ method: 'POST', url: `/api/pages/${child}/restore` });
      expect(unreadable.statusCode).toBe(409);
      const unreadableBody = unreadable.json() as { message?: string };
      expect(unreadableBody.message).not.toContain('Synced ancestor');
      expect(unreadableBody.message).toMatch(/parent page/i);
      expect(await existingIds([synced, child])).toHaveLength(2);
    });

    /**
     * The other half of the same rule: a caller who CAN read the ancestor still
     * gets its title, and shared visibility is one way to be able to read it
     * (`GET /api/pages/:id`'s standalone rule is owner-or-shared). Degrading
     * this case would leave the Trash's "restore the parent first" refusal
     * naming nothing the person could act on.
     */
    it('still names the ancestor for a caller who can read it', async () => {
      const shared = await insertStandalonePage('Shared roadmap', 'shared', userA, 'NOTES');
      const bobChild = await insertStandalonePage('Bob draft', 'private', userB, 'NOTES', {
        parentId: String(shared),
      });

      currentUserId = userA;
      await app.inject({ method: 'DELETE', url: `/api/pages/${shared}` });

      currentUserId = userB;
      const response = await app.inject({ method: 'POST', url: `/api/pages/${bobChild}/restore` });

      expect(response.statusCode).toBe(409);
      const body = response.json() as { message?: string; reason?: string };
      expect(body.message).toContain('Shared roadmap');
      expect(body.reason).toBe('restore_ancestor_trashed');
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
