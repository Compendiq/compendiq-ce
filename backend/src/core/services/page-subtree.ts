/**
 * #1636 — ONE definition of "the subtree under a page".
 *
 * Trashing a standalone article must trash its whole subtree, and everything
 * that talks about that subtree must agree: the cascade in
 * `DELETE /api/pages/:id`, the batch `POST /api/pages/:id/restore` puts back,
 * the `descendantCount` the confirm dialog quotes, and the bulk delete's
 * expanded id set. Four copies of a recursive CTE would drift the first time
 * one of them was touched, so the walk lives here and is read from all four.
 *
 * Four properties are load-bearing and each has a shape that looks
 * "simplifiable" in isolation:
 *
 * 1. **The recursive arm has no `deleted_at` filter.** A walk that stops at a
 *    trashed intermediate leaves its LIVE grandchildren behind — exactly the
 *    bug this module exists to close, one level down (a re-trashed subtree, or
 *    a child trashed on its own before its parent's cascade). The walk
 *    traverses everything; the callers' own guards filter what is RETURNED,
 *    never what is visited. That asymmetry is also what keeps an
 *    already-trashed descendant's ORIGINAL stamp intact, which `trashBatchIds`
 *    depends on.
 *
 * 2. **`UNION`, never `UNION ALL`.** `pages.parent_id` is plain TEXT with no
 *    constraint tying it to a live row, so a cycle (reachable through the
 *    relocate path) is only prevented from hanging the request by the
 *    deduplication. `UNION` also makes the walk at most one visit per page.
 *
 * 3. **The join key is source-aware**, `PARENT_KEY_SQL` below — the same rule
 *    `parentKeyFor` applies in `domains/knowledge/services/page-relocate-service.ts`,
 *    restated rather than imported because `core` may not import a domain. The
 *    two MUST stay in step: one writes `parent_id`, this one reads it. The `id`
 *    arm is compared as TEXT because `pages.id` is int4, so casting the value
 *    would overflow on a Confluence content id above 2^31 (#1167).
 *
 * 4. **An ambiguous key is refused, never resolved.** `parent_id` is read
 *    against *either* `confluence_id` *or* `id::text`, and Confluence DC ids
 *    are numeric strings, so a standalone page with `id = 98304` and a synced
 *    page with `confluence_id = '98304'` are indistinguishable to every reader
 *    — and `pages.id` is a serial that grows into that space. A walk that
 *    followed such a key would cross into an unrelated tree, and on a delete
 *    path that destroys rows nobody named. `findSubtreeKeyAmbiguity` detects it
 *    and the callers refuse, which is the rule `PUT /pages/:id/move`,
 *    `/relocate` (`assertIdentifierUnambiguous`, #1166) and
 *    `POST /pages/bulk/delete` (`bulk-page-selection.ts`, #1167) already
 *    follow. Picking a winner is not an option: the stored key stays ambiguous,
 *    so one reader would follow one candidate and the next reader the other.
 *
 * Every id-set helper here is **owner-scoped**. A cascade may only touch rows
 * belonging to the user who asked for it: `POST /pages` validates `parentId`
 * for existence and space but not for ownership, so another user's article can
 * legitimately sit inside this one's subtree, and a request that trashed or
 * destroyed it would be acting far outside what its caller was authorised to
 * do — irreversibly, in the `?permanent=true` case. The residual cost is
 * stated where the cascade runs: such a row stays live under a trashed parent,
 * the same shape the `source = 'standalone'` guard already leaves behind.
 *
 * Lives in `core` (which may query `pages`, cf. `data-retention-service.ts` and
 * `page-icon-store.ts`) because it is shared infrastructure for the page
 * routes, and `core` may not import a domain. Note that the 30-day purge in
 * `data-retention-service.ts` does NOT read this module: it deletes expired
 * rows one by one and is deliberately not subtree-aware, because by then every
 * row in a batch has passed its own retention deadline.
 */
import type { PoolClient } from 'pg';
import { query } from '../db/postgres.js';

/**
 * The identifier a child stores in `parent_id` for the row aliased `alias`:
 * its `confluence_id` when Confluence-sourced, its PK as text otherwise.
 *
 * This is `parentKeyFor`'s rule in SQL. It is deliberately NOT
 * `COALESCE(confluence_id, id::text)`, the form migration 082 used: the two
 * differ for a `source = 'standalone'` row that still carries a
 * `confluence_id`, and there the COALESCE form reads a key no writer ever
 * stores for it.
 */
function parentKeySql(alias: string): string {
  return `CASE WHEN ${alias}.source = 'confluence' AND ${alias}.confluence_id IS NOT NULL
               THEN ${alias}.confluence_id ELSE ${alias}.id::text END`;
}

/**
 * The walk as a CTE body, WITHOUT the leading `WITH RECURSIVE`, so it can be
 * embedded in a read (`SELECT … FROM d`) or in a data-modifying statement
 * (`WITH RECURSIVE d AS (…) UPDATE pages …`). The seed predicate is the only
 * difference between the single-root and multi-root forms; it is a compile-time
 * literal from a closed union, never caller input.
 */
function subtreeCte(seed: 'single-root' | 'many-roots'): string {
  const seedPredicate = seed === 'single-root' ? 'p.id = $1' : 'p.id = ANY($1::int[])';
  return `WITH RECURSIVE d AS (
      SELECT p.id, p.confluence_id, p.source, p.deleted_at, p.created_by_user_id
        FROM pages p
       WHERE ${seedPredicate}
      UNION
      SELECT p.id, p.confluence_id, p.source, p.deleted_at, p.created_by_user_id
        FROM pages p
        JOIN d ON p.parent_id = ${parentKeySql('d')}
    )`;
}

/** Walk rooted at the single page bound to `$1`. */
export const PAGE_SUBTREE_CTE = subtreeCte('single-root');

/** Walk rooted at every page in the id array bound to `$1::int[]`. */
export const PAGE_SUBTREE_CTE_MANY_ROOTS = subtreeCte('many-roots');

async function selectIds(sql: string, values: unknown[], client?: PoolClient): Promise<number[]> {
  const result = client
    ? await client.query<{ id: number }>(sql, values)
    : await query<{ id: number }>(sql, values);
  return result.rows.map((row) => row.id);
}

/** One page in the walk whose parent key names a second page as well. */
export interface SubtreeKeyAmbiguity {
  /** The page inside the subtree whose key is not unique. */
  pageId: number;
  /** The key itself — what a child of `pageId` would store in `parent_id`. */
  key: string;
  /** The unrelated page that answers to the same key. */
  conflictingPageId: number;
  conflictingTitle: string;
}

/**
 * The first page in the walk rooted at `roots` whose parent key is also some
 * other page's identifier AND is actually stored by at least one child, or
 * `null` when the subtree is safe to act on.
 *
 * Callers on a delete or restore path MUST check this before acting: see
 * property 4 in the module doc.
 *
 * Both extra conditions are load-bearing. Trashed rows are in scope on the
 * conflicting side — a trashed row keeps its `confluence_id`
 * (`pages_confluence_id_unique`, migration 029, is partial on
 * `confluence_id IS NOT NULL` and does not exclude `deleted_at`) and can be
 * restored back into contention, the same reason `assertIdentifierUnambiguous`
 * counts them. But a key no child stores is NOT a hazard: the walk's join finds
 * nothing through it, so nothing can be pulled in from the other candidate's
 * tree, and refusing there would block a page from deleting itself over a
 * collision that can never be read. The hazard is precisely "a child stores a
 * key that names two parents", because then no reader can tell whose child it
 * is.
 */
export async function findSubtreeKeyAmbiguity(
  roots: number | number[],
  client?: PoolClient,
): Promise<SubtreeKeyAmbiguity | null> {
  const many = Array.isArray(roots);
  const sql = `${many ? PAGE_SUBTREE_CTE_MANY_ROOTS : PAGE_SUBTREE_CTE}
     SELECT d.id AS page_id,
            ${parentKeySql('d')} AS key,
            other.id AS conflicting_page_id,
            other.title AS conflicting_title
       FROM d
       JOIN pages other
         ON other.id <> d.id
        AND (other.confluence_id = ${parentKeySql('d')} OR other.id::text = ${parentKeySql('d')})
      WHERE EXISTS (SELECT 1 FROM pages child WHERE child.parent_id = ${parentKeySql('d')})
      ORDER BY d.id, other.id
      LIMIT 1`;
  const values = [roots];
  const result = client
    ? await client.query<{
        page_id: number;
        key: string;
        conflicting_page_id: number;
        conflicting_title: string;
      }>(sql, values)
    : await query<{
        page_id: number;
        key: string;
        conflicting_page_id: number;
        conflicting_title: string;
      }>(sql, values);
  const row = result.rows[0];
  if (!row) return null;
  return {
    pageId: row.page_id,
    key: row.key,
    conflictingPageId: row.conflicting_page_id,
    conflictingTitle: row.conflicting_title,
  };
}

/**
 * Live descendants of `rootId` that the cascade will actually trash — the
 * number `GET /api/pages/:id` publishes as `descendantCount`, and the number
 * the confirm dialog quotes.
 *
 * It carries the cascade's OWN guards, not refinements of them, because a count
 * that names rows the request leaves alone is the over-promise this field
 * exists to prevent:
 *
 * - `source = 'standalone'`, because Confluence owns a synced row's lifecycle
 *   and its sync upsert would resurrect anything trashed locally. A subtree is
 *   not source-pure: `PUT /pages/:id/move` re-parents a synced page under a
 *   standalone parent and keeps its source, and `POST /pages` never checks the
 *   parent's source.
 * - `created_by_user_id = $2`, because the cascade may not touch another user's
 *   article (module doc). This also keeps the field from disclosing how many
 *   private sub-articles other users keep under a shared page.
 *
 * The walk still VISITS the skipped rows: this user's standalone descendants
 * below them are trashed with the rest.
 */
export async function activeDescendantCount(
  rootId: number,
  ownerUserId: string,
): Promise<number> {
  const result = await query<{ count: string }>(
    `${PAGE_SUBTREE_CTE}
     SELECT COUNT(*)::text AS count FROM d
      WHERE deleted_at IS NULL AND source = 'standalone'
        AND created_by_user_id = $2 AND id <> $1`,
    [rootId, ownerUserId],
  );
  return parseInt(result.rows[0]!.count, 10);
}

/**
 * The delete batch a page belongs to: the page plus every descendant of
 * `ownerUserId`'s carrying the SAME `deleted_at`.
 *
 * A cascade is one `UPDATE`, and one `UPDATE` stamps transaction time for every
 * row it touches, so the batch is exactly the set one delete action produced —
 * which is why the comparison happens in SQL. `deleted_at` is `timestamptz`
 * (microseconds); a JS `Date` round-trip truncates to milliseconds, so a
 * parameterised equality would silently match nothing.
 *
 * A page with no `deleted_at` has no batch, and answers `[]` (the NULL
 * comparison is never true). The owner filter is belt-and-braces now that the
 * cascade is owner-scoped, and it is what keeps a restore from resurrecting
 * another user's row out of a batch stamped before that scoping existed.
 */
export async function trashBatchIds(rootId: number, ownerUserId: string): Promise<number[]> {
  return selectIds(
    `${PAGE_SUBTREE_CTE}
     SELECT d.id
       FROM d
       JOIN pages root ON root.id = $1
      WHERE d.deleted_at IS NOT NULL AND d.deleted_at = root.deleted_at
        AND d.created_by_user_id = $2`,
    [rootId, ownerUserId],
  );
}

/** The parent row a restore has to reason about. */
export interface ParentPage {
  id: number;
  title: string;
  source: string;
  visibility: string;
  createdByUserId: string | null;
  deletedAt: Date | null;
}

/**
 * What `page.parent_id` resolves to.
 *
 * `ambiguous` is a distinct answer rather than a silent pick: resolving it
 * either way would make the caller act on a page it did not name (module doc,
 * property 4).
 */
export type ParentResolution =
  | { kind: 'none' }
  | { kind: 'resolved'; parent: ParentPage }
  | { kind: 'ambiguous'; key: string; candidateIds: number[] };

/**
 * Resolve a page's DIRECT parent from the `parent_id` it stores.
 *
 * Deliberately one level, not a walk up the chain. The invariant a restore has
 * to protect is "do not put a row back under a hidden parent", and that is a
 * statement about `parent_id` alone: if the direct parent is live, the restored
 * page reappears beneath it and orphans nothing, whatever is happening further
 * up. Refusing on a *distant* trashed ancestor instead — the shape this
 * function replaced — refused restores that were safe, and permanently blocked
 * a page whose distant ancestor belonged to someone else.
 *
 * Both identifier arms are read and a double match is reported as `ambiguous`,
 * which is also why this cannot be a recursive CTE plus a JS chain walk: that
 * shape keyed candidate parents into a `Map` by one identifier, so a collision
 * silently kept whichever row the unordered scan yielded last and a key that
 * missed the map read as "no parent at all" — the guard failing OPEN, which
 * re-created the very orphan it exists to prevent.
 */
export async function resolveParentOf(parentId: string | null): Promise<ParentResolution> {
  if (!parentId) return { kind: 'none' };

  const result = await query<{
    id: number;
    title: string;
    source: string;
    visibility: string;
    created_by_user_id: string | null;
    deleted_at: Date | null;
  }>(
    `SELECT id, title, source, visibility, created_by_user_id, deleted_at
       FROM pages
      WHERE confluence_id = $1 OR id::text = $1
      ORDER BY id`,
    [parentId],
  );

  if (result.rows.length === 0) return { kind: 'none' };
  if (result.rows.length > 1) {
    return {
      kind: 'ambiguous',
      key: parentId,
      candidateIds: result.rows.map((row) => row.id),
    };
  }

  const row = result.rows[0]!;
  return {
    kind: 'resolved',
    parent: {
      id: row.id,
      title: row.title,
      source: row.source,
      visibility: row.visibility,
      createdByUserId: row.created_by_user_id,
      deletedAt: row.deleted_at,
    },
  };
}
