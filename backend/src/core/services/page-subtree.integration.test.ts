/**
 * #1636 — the shared page-subtree walk against a REAL PostgreSQL.
 *
 * `page-subtree.ts` is the one definition of "the subtree under a page": the
 * delete cascade, the restore batch, `descendantCount` and the restore's parent
 * guard all read it, so drift between them is impossible by construction. Four
 * of its properties cannot be pinned with a mocked `query`:
 *
 *   1. the walk must TRAVERSE a trashed intermediate (a cascade that stops
 *      there leaves the live grandchildren it was supposed to trash orphaned
 *      at the tree root — the issue's bug, one level down), while only ever
 *      RETURNING the members the caller asked for;
 *   2. `UNION` is the cycle guard — a `parent_id` cycle (reachable through the
 *      relocate path) must terminate instead of hanging the request;
 *   3. the join key is SOURCE-AWARE (`CASE WHEN source = 'confluence' AND
 *      confluence_id IS NOT NULL THEN confluence_id ELSE id::text END`), not
 *      `COALESCE(confluence_id, id::text)`: the two disagree for a standalone
 *      row that still carries a `confluence_id`, and only real rows can show
 *      which key a child's `parent_id` is actually matched against;
 *   4. `parent_id` is read against EITHER identifier arm, so a key can name two
 *      pages. Both readers here have to answer that case explicitly —
 *      `findSubtreeKeyAmbiguity` by reporting it, `resolveParentOf` by a
 *      distinct `ambiguous` result — and a JS-side chain walk keyed by one
 *      identifier is exactly how that guard used to fail OPEN.
 *
 * Every id-set helper is owner-scoped, which is also asserted from both sides:
 * an assertion that only ever passes the owning user cannot tell a real filter
 * from a no-op.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  setupTestDb,
  truncateAllTables,
  teardownTestDb,
  isDbAvailable,
} from '../../test-db-helper.js';
import { query } from '../db/postgres.js';
import {
  PAGE_SUBTREE_CTE,
  PAGE_SUBTREE_CTE_MANY_ROOTS,
  activeDescendantCount,
  findSubtreeKeyAmbiguity,
  resolveParentOf,
  trashBatchIds,
} from './page-subtree.js';

const dbAvailable = await isDbAvailable();

let owner: string;
let other: string;

async function insertPage(
  title: string,
  opts: {
    parentId?: string | null;
    deletedAt?: Date | null;
    source?: 'standalone' | 'confluence';
    confluenceId?: string | null;
    ownerId?: string;
    visibility?: 'private' | 'shared';
  } = {},
): Promise<number> {
  const res = await query<{ id: number }>(
    `INSERT INTO pages (title, body_text, body_html, version, source, confluence_id,
                        visibility, created_by_user_id, embedding_dirty, embedding_status,
                        deleted_at, parent_id)
     VALUES ($1, 'x', '<p>x</p>', 1, $2, $3, $7, $4, FALSE, 'not_embedded', $5, $6)
     RETURNING id`,
    [
      title,
      opts.source ?? 'standalone',
      opts.confluenceId ?? null,
      opts.ownerId ?? owner,
      opts.deletedAt ?? null,
      opts.parentId ?? null,
      opts.visibility ?? 'private',
    ],
  );
  return res.rows[0]!.id;
}

/**
 * The raw membership of the walk, through the exported CTE — the only way to
 * observe "what the walk VISITED" now that no helper returns a bare id set
 * (each one applies its caller's guards on the way out).
 *
 * Sorted, because a recursive CTE's output order is the scan's, not the
 * insertion order: comparing it unsorted would pin whichever plan Postgres
 * happened to pick. Every assertion below sorts both sides for that reason.
 */
async function walkIds(root: number): Promise<number[]> {
  const res = await query<{ id: number }>(`${PAGE_SUBTREE_CTE} SELECT id FROM d`, [root]);
  return res.rows.map((row) => row.id).sort((a, b) => a - b);
}

/** Same, for the many-roots seed the bulk delete binds. */
async function walkIdsMany(roots: number[]): Promise<number[]> {
  const res = await query<{ id: number }>(`${PAGE_SUBTREE_CTE_MANY_ROOTS} SELECT id FROM d`, [
    roots,
  ]);
  return res.rows.map((row) => row.id).sort((a, b) => a - b);
}

const ascending = (ids: number[]): number[] => [...ids].sort((a, b) => a - b);

describe.skipIf(!dbAvailable)('page-subtree — real PostgreSQL (#1636)', () => {
  beforeAll(async () => {
    await setupTestDb();
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  beforeEach(async () => {
    await truncateAllTables();
    const res = await query<{ id: string }>(
      `INSERT INTO users (username, email, password_hash, role)
       VALUES ('subtree_owner', 'subtree@test', 'x', 'user'),
              ('subtree_other', 'subtree-other@test', 'x', 'user')
       RETURNING id`,
    );
    owner = res.rows[0]!.id;
    other = res.rows[1]!.id;
  });

  it('walks through a trashed intermediate to the live grandchild', async () => {
    const root = await insertPage('Root');
    const trashed = await insertPage('Trashed child', {
      parentId: String(root),
      deletedAt: new Date('2020-01-01T00:00:00Z'),
    });
    const live = await insertPage('Live grandchild', { parentId: String(trashed) });

    expect(await walkIds(root)).toEqual(ascending([root, trashed, live]));
    // …and the count the cascade publishes sees the grandchild THROUGH the
    // trashed row: a recursive arm that filtered `deleted_at` would answer 0
    // here and leave the grandchild live under a trashed parent, which is
    // exactly the orphan this module exists to close.
    expect(await activeDescendantCount(root, owner)).toBe(1);
  });

  it('counts only the asking user’s live standalone descendants, and never the page itself', async () => {
    const root = await insertPage('Root');
    const child = await insertPage('Child', { parentId: String(root) });
    await insertPage('Trashed child', { parentId: String(root), deletedAt: new Date() });
    await insertPage('Grandchild', { parentId: String(child) });
    const foreign = await insertPage('Another user’s child', {
      parentId: String(root),
      ownerId: other,
    });
    const synced = await insertPage('Synced child', {
      parentId: String(root),
      source: 'confluence',
      confluenceId: 'conf-counted',
    });
    const leaf = await insertPage('Leaf');

    // The count carries the cascade's OWN guards, so it promises exactly the
    // rows the delete will move: this user's live standalone descendants.
    expect(await activeDescendantCount(root, owner)).toBe(2);
    expect(await activeDescendantCount(leaf, owner)).toBe(0);
    // Asked as the OTHER user, the same tree answers with THEIR one row — the
    // owner filter is a real predicate, not a clause that happens to admit
    // everything the fixture has.
    expect(await activeDescendantCount(root, other)).toBe(1);
    // Both skipped rows were still VISITED: the walk descends through them, so
    // this user's rows below them are reached (previous case).
    expect(await walkIds(root)).toContain(foreign);
    expect(await walkIds(root)).toContain(synced);
  });

  it('follows a synced child’s confluence_id link rather than its numeric parent', async () => {
    const parent = await insertPage('Synced parent', { source: 'confluence', confluenceId: 'conf-9' });
    const child = await insertPage('Synced child', {
      source: 'confluence',
      confluenceId: 'conf-10',
      parentId: 'conf-9',
    });

    expect(await walkIds(parent)).toEqual(ascending([parent, child]));
  });

  /**
   * The join key is `CASE WHEN source = 'confluence' AND confluence_id IS NOT
   * NULL THEN confluence_id ELSE id::text END`, restating `parentKeyFor`'s rule
   * (the writer in `page-relocate-service.ts`) rather than migration 082's
   * `COALESCE(confluence_id, id::text)`. The two differ for exactly one row
   * shape — a `source = 'standalone'` row that still carries a `confluence_id`,
   * which an unlinked import leaves behind — and under the COALESCE form the
   * walk reads a key no writer ever stores for such a row: its real children,
   * parked on its PK, drop out of the subtree, while anything parked on the
   * stale `confluence_id` is pulled in.
   */
  it('keys a standalone row by its PK even when it still carries a confluence_id', async () => {
    const parent = await insertPage('Unlinked import', { confluenceId: 'conf-stale' });
    const realChild = await insertPage('Child by PK', { parentId: String(parent) });
    const strayChild = await insertPage('Child by stale confluence_id', { parentId: 'conf-stale' });

    expect(await walkIds(parent)).toEqual(ascending([parent, realChild]));
    expect(await walkIds(parent)).not.toContain(strayChild);
    expect(await activeDescendantCount(parent, owner)).toBe(1);
  });

  it('terminates on a parent_id cycle', async () => {
    const a = await insertPage('Cycle A');
    const b = await insertPage('Cycle B', { parentId: String(a) });
    await query('UPDATE pages SET parent_id = $1 WHERE id = $2', [String(b), a]);

    expect(await walkIds(a)).toEqual(ascending([a, b]));
  });

  it('seeds the many-roots form from every root it is given', async () => {
    const first = await insertPage('First root');
    const firstChild = await insertPage('First child', { parentId: String(first) });
    const second = await insertPage('Second root');
    const secondChild = await insertPage('Second child', { parentId: String(second) });
    const unselected = await insertPage('Unselected root');

    expect(await walkIdsMany([first, second])).toEqual(
      ascending([first, firstChild, second, secondChild]),
    );
    expect(await walkIdsMany([first, second])).not.toContain(unselected);
  });

  it('returns the page plus the descendants sharing its delete stamp as one batch', async () => {
    const stamp = new Date('2021-05-05T05:05:05Z');
    const root = await insertPage('Root', { deletedAt: stamp });
    const withRoot = await insertPage('Trashed with root', { parentId: String(root), deletedAt: stamp });
    const separately = await insertPage('Trashed separately', {
      parentId: String(root),
      deletedAt: new Date('2021-01-01T00:00:00Z'),
    });
    // A row of another user's carrying the SAME stamp — the shape a cascade
    // stamped before the owner scoping existed left behind. A restore may not
    // resurrect it: it is not this caller's row to put back.
    const foreign = await insertPage('Another user’s row', {
      parentId: String(root),
      deletedAt: stamp,
      ownerId: other,
    });

    expect(ascending(await trashBatchIds(root, owner))).toEqual(ascending([root, withRoot]));
    expect(await trashBatchIds(root, owner)).not.toContain(foreign);
    expect(await trashBatchIds(separately, owner)).toEqual([separately]);
    // A live page has no batch at all: the NULL comparison is never true.
    const live = await insertPage('Live');
    expect(await trashBatchIds(live, owner)).toEqual([]);
  });

  // ── findSubtreeKeyAmbiguity ────────────────────────────────────────────────

  describe('findSubtreeKeyAmbiguity', () => {
    it('answers null for a subtree whose keys each name one page', async () => {
      const root = await insertPage('Root');
      const child = await insertPage('Child', { parentId: String(root) });
      await insertPage('Grandchild', { parentId: String(child) });

      expect(await findSubtreeKeyAmbiguity(root)).toBeNull();
    });

    /**
     * The hazard is precisely "a child stores a key that names two parents", so
     * the function carries BOTH conditions and this case walks the fixture
     * through each of them in turn.
     *
     * A bare collision is not enough: with no child parked on the shared key
     * the walk's join finds nothing through it, nothing can be pulled in from
     * the other candidate's tree, and refusing there would block a page from
     * deleting ITSELF over a collision no reader can ever follow. The moment a
     * child stores that key, no reader can tell whose child it is, and every
     * delete/restore path must refuse instead of guessing.
     */
    it('reports the collision only once a child actually stores the shared key', async () => {
      const parent = await insertPage('Standalone parent');
      // `pages.id` is a serial growing into Confluence's numeric id space, so a
      // synced page really can answer to a standalone page's PK (#1167).
      const decoy = await insertPage('Decoy', {
        source: 'confluence',
        confluenceId: String(parent),
      });

      expect(await findSubtreeKeyAmbiguity(parent)).toBeNull();

      await insertPage('Child on the shared key', { parentId: String(parent) });

      expect(await findSubtreeKeyAmbiguity(parent)).toEqual({
        pageId: parent,
        key: String(parent),
        conflictingPageId: decoy,
        conflictingTitle: 'Decoy',
      });
    });

    /**
     * A TRASHED row stays in contention on the conflicting side: the partial
     * unique index on `confluence_id` (migration 029) does not exclude
     * `deleted_at`, so the row keeps its identifier and a restore puts it back
     * — the same reason `assertIdentifierUnambiguous` counts trashed rows.
     */
    it('counts a trashed page on the conflicting side', async () => {
      const parent = await insertPage('Standalone parent');
      const decoy = await insertPage('Trashed decoy', {
        source: 'confluence',
        confluenceId: String(parent),
        deletedAt: new Date(),
      });
      await insertPage('Child on the shared key', { parentId: String(parent) });

      expect(await findSubtreeKeyAmbiguity(parent)).toMatchObject({
        pageId: parent,
        conflictingPageId: decoy,
      });
    });

    it('finds an ambiguity that sits deeper in the subtree, and in any of the many roots', async () => {
      const root = await insertPage('Root');
      const middle = await insertPage('Middle', { parentId: String(root) });
      const decoy = await insertPage('Decoy', {
        source: 'confluence',
        confluenceId: String(middle),
      });
      await insertPage('Leaf on the shared key', { parentId: String(middle) });
      const cleanRoot = await insertPage('Clean root');
      await insertPage('Clean child', { parentId: String(cleanRoot) });

      // Reached by descending, not just at the seed.
      expect(await findSubtreeKeyAmbiguity(root)).toMatchObject({
        pageId: middle,
        conflictingPageId: decoy,
      });
      // The bulk path binds an id ARRAY, and one bad root spoils the batch:
      // its cascade is one statement over the union of the walks.
      expect(await findSubtreeKeyAmbiguity([cleanRoot])).toBeNull();
      expect(await findSubtreeKeyAmbiguity([cleanRoot, root])).toMatchObject({
        pageId: middle,
        conflictingPageId: decoy,
      });
    });
  });

  // ── resolveParentOf ───────────────────────────────────────────────────────

  describe('resolveParentOf', () => {
    it('answers none for a root page and for a key that names nothing', async () => {
      expect(await resolveParentOf(null)).toEqual({ kind: 'none' });
      // A dangling `parent_id` — `pages.parent_id` is plain TEXT with no
      // constraint tying it to a live row.
      expect(await resolveParentOf('does-not-exist')).toEqual({ kind: 'none' });
    });

    /**
     * The fields the restore refusal decides on travel with the row: it refuses
     * only for a parent that is trashed AND standalone AND the caller's own,
     * because that is the only parent the caller can actually restore first.
     */
    it('carries the trashed parent’s source, owner and stamp', async () => {
      const parent = await insertPage('Parent article', {
        deletedAt: new Date('2022-02-02T02:02:02Z'),
        visibility: 'shared',
      });
      await insertPage('Child', { parentId: String(parent) });

      const resolution = await resolveParentOf(String(parent));
      expect(resolution.kind).toBe('resolved');
      expect(resolution).toMatchObject({
        kind: 'resolved',
        parent: {
          id: parent,
          title: 'Parent article',
          source: 'standalone',
          visibility: 'shared',
          createdByUserId: owner,
        },
      });
      expect(
        (resolution as { parent: { deletedAt: Date | null } }).parent.deletedAt?.getTime(),
      ).toBe(new Date('2022-02-02T02:02:02Z').getTime());
    });

    /**
     * Both identifier arms are read, so a parent addressed by its PK resolves
     * even when it also carries a `confluence_id` (an unlinked import). A
     * lookup that consulted one key per row — the `Map`-keyed chain walk this
     * function replaced — reads such a parent as "no parent at all", which is
     * the guard failing OPEN: the restore proceeds and re-creates the orphan.
     */
    it('resolves a parent addressed by its PK while it also carries a confluence_id', async () => {
      const parent = await insertPage('Unlinked import', {
        confluenceId: 'conf-stale',
        deletedAt: new Date(),
      });
      await insertPage('Child', { parentId: String(parent) });

      expect(await resolveParentOf(String(parent))).toMatchObject({
        kind: 'resolved',
        parent: { id: parent, title: 'Unlinked import' },
      });
      // …and the other arm still answers for a synced parent addressed by its
      // Confluence id, which is what a synced child stores.
      const synced = await insertPage('Synced parent', {
        source: 'confluence',
        confluenceId: 'conf-live',
      });
      expect(await resolveParentOf('conf-live')).toMatchObject({
        kind: 'resolved',
        parent: { id: synced, source: 'confluence' },
      });
    });

    /**
     * The failing-open bug this function exists to close: `parent_id` names a
     * trashed real parent AND a live decoy at once. Picking either would make
     * the caller act on a page it never named, and reading only one arm made
     * the restore succeed and drop the row at the tree root. Both candidates
     * are reported so the route can refuse with `restore_parent_ambiguous`.
     */
    it('reports both candidates when the key names two pages', async () => {
      const realParent = await insertPage('Real parent', { deletedAt: new Date() });
      const decoy = await insertPage('Live decoy', {
        source: 'confluence',
        confluenceId: String(realParent),
      });
      await insertPage('Child', { parentId: String(realParent), deletedAt: new Date() });

      expect(await resolveParentOf(String(realParent))).toEqual({
        kind: 'ambiguous',
        key: String(realParent),
        candidateIds: ascending([realParent, decoy]),
      });
    });
  });
});
