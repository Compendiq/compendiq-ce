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
 * Three properties are load-bearing and each has a shape that looks
 * "simplifiable" in isolation:
 *
 * 1. **The recursive arm has no `deleted_at` filter.** A walk that stops at a
 *    trashed intermediate leaves its LIVE grandchildren behind — exactly the
 *    bug this module exists to close, one level down (a re-trashed subtree, or
 *    a child trashed on its own before its parent's cascade). The walk
 *    traverses everything; `activeOnly` filters what is RETURNED, never what is
 *    visited. That asymmetry is also what keeps an already-trashed descendant's
 *    ORIGINAL stamp intact, which `trashBatchIds` depends on.
 *
 * 2. **`UNION`, never `UNION ALL`.** `pages.parent_id` is plain TEXT with no
 *    constraint tying it to a live row, so a cycle (reachable through the
 *    relocate path) is only prevented from hanging the request by the
 *    deduplication. `UNION` also makes the walk at most one visit per page.
 *
 * 3. **The join is the dual-identifier join** `p.parent_id =
 *    COALESCE(d.confluence_id, d.id::text)` — the canonical form from migration
 *    082 and `GET /pages/:id/children`. A standalone child's `parent_id` holds
 *    its parent's PK, a synced child's holds its parent's `confluence_id`, and
 *    the moment a synced row sits in a subtree the two arms disagree. The `id`
 *    arm is also compared as TEXT: `pages.id` is int4, so casting the parameter
 *    would overflow on a Confluence content id above 2^31 (#1167).
 *
 * Lives in `core` (which may query `pages`, cf. `data-retention-service.ts` and
 * `page-icon-store.ts`) because `data-retention-service.ts` and
 * `routes/knowledge` both need it — core may not import a domain.
 */
import type { PoolClient } from 'pg';
import { query } from '../db/postgres.js';

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
      SELECT p.id, p.confluence_id, p.source, p.deleted_at
        FROM pages p
       WHERE ${seedPredicate}
      UNION
      SELECT p.id, p.confluence_id, p.source, p.deleted_at
        FROM pages p
        JOIN d ON p.parent_id = COALESCE(d.confluence_id, d.id::text)
    )`;
}

/** Walk rooted at the single page bound to `$1`. */
export const PAGE_SUBTREE_CTE = subtreeCte('single-root');

/** Walk rooted at every page in the id array bound to `$1::int[]`. */
export const PAGE_SUBTREE_CTE_MANY_ROOTS = subtreeCte('many-roots');

/**
 * The JS mirror of the walk's join key: what a child's `parent_id` holds for
 * this page. Used to follow the ancestor chain in application code (a CTE
 * cannot order an upward walk without a depth column, and adding one would
 * break its `UNION` dedup).
 */
export function subtreeKeyOf(page: { id: number; confluence_id: string | null }): string {
  return page.confluence_id ?? String(page.id);
}

async function selectIds(sql: string, values: unknown[], client?: PoolClient): Promise<number[]> {
  const result = client
    ? await client.query<{ id: number }>(sql, values)
    : await query<{ id: number }>(sql, values);
  return result.rows.map((row) => row.id);
}

/**
 * Every id reachable from `rootId`, the root included. `activeOnly` narrows the
 * RESULT to live rows (`deleted_at IS NULL`) — the set a cascade would change
 * right now — without narrowing the walk.
 *
 * Pass `client` to run inside a transaction whose other statements must see the
 * same snapshot (the hard-delete path walks and deletes under one lock).
 */
export async function subtreeIds(
  rootId: number,
  options: { activeOnly?: boolean; client?: PoolClient } = {},
): Promise<number[]> {
  const sql = options.activeOnly
    ? `${PAGE_SUBTREE_CTE} SELECT id FROM d WHERE deleted_at IS NULL`
    : `${PAGE_SUBTREE_CTE} SELECT id FROM d`;
  return selectIds(sql, [rootId], options.client);
}

/**
 * Live descendants of `rootId`, the page itself excluded — the number
 * `GET /api/pages/:id` publishes as `descendantCount`, and exactly the set the
 * cascade will trash.
 *
 * `source = 'standalone'` is the cascade's OWN guard, not a refinement: the
 * delete's UPDATE arm moves `deleted_at IS NULL AND source = 'standalone'` rows
 * only, because Confluence owns a synced row's lifecycle and its sync upsert
 * would resurrect anything trashed locally. A subtree is not source-pure — a
 * Confluence-sourced page can sit inside a standalone one (`PUT
 * /pages/:id/move` re-parents a synced page under a standalone parent and keeps
 * its source; `POST /pages` never checks the parent's source) — so a count
 * without this arm would name rows the request does not touch, which is the
 * over-promise `descendantCount` exists to prevent. The walk still VISITS those
 * rows: the standalone descendants below them are trashed with the rest.
 */
export async function activeDescendantCount(rootId: number): Promise<number> {
  const result = await query<{ count: string }>(
    `${PAGE_SUBTREE_CTE}
     SELECT COUNT(*)::text AS count FROM d
      WHERE deleted_at IS NULL AND source = 'standalone' AND id <> $1`,
    [rootId],
  );
  return parseInt(result.rows[0]!.count, 10);
}

/**
 * The delete batch a page belongs to: the page plus every descendant carrying
 * the SAME `deleted_at`.
 *
 * A cascade is one `UPDATE`, and one `UPDATE` stamps transaction time for every
 * row it touches, so the batch is exactly the set one delete action produced —
 * which is why the comparison happens in SQL. `deleted_at` is `timestamptz`
 * (microseconds); a JS `Date` round-trip truncates to milliseconds, so a
 * parameterised equality would silently match nothing.
 *
 * A page with no `deleted_at` has no batch, and answers `[]` (the NULL
 * comparison is never true).
 */
export async function trashBatchIds(rootId: number): Promise<number[]> {
  return selectIds(
    `${PAGE_SUBTREE_CTE}
     SELECT d.id
       FROM d
       JOIN pages root ON root.id = $1
      WHERE d.deleted_at IS NOT NULL AND d.deleted_at = root.deleted_at`,
    [rootId],
  );
}

interface AncestorRow {
  id: number;
  confluence_id: string | null;
  parent_id: string | null;
  title: string;
  source: string;
  space_key: string | null;
  visibility: string;
  created_by_user_id: string | null;
  deleted_at: Date | null;
}

/**
 * A trashed ancestor, with the fields a caller needs to decide whether it may
 * be NAMED in the refusal.
 *
 * The title belongs to a page the restoring user does not necessarily own (a
 * page can be created under another user's — that is how a cascade reaches a
 * page it was never asked to trash), so the reader rule is not the restore
 * route's business to guess: it travels with the row.
 */
export interface TrashedAncestor {
  id: number;
  title: string;
  source: string;
  spaceKey: string | null;
  visibility: string;
  createdByUserId: string | null;
}

/**
 * The NEAREST trashed ancestor of `pageId`, or `null` when every ancestor is
 * live.
 *
 * Restoring a page whose parent is still trashed would put it back with a
 * `parent_id` pointing at a hidden row, and `GET /api/pages/tree` renders that
 * as a top-level page — the issue's orphan, inside Trash. The restore route
 * refuses in that case and names this page.
 *
 * The nearest ancestor is the actionable one: it is the first row the caller
 * can actually restore, and its own restore re-runs this guard one level up.
 * Reading it needs the CHAIN order (the SQL is unordered by construction —
 * see `subtreeKeyOf`), so the CTE collects the ancestor set and the chain is
 * followed here, bounded by the visited set: `UNION` deduplicates, so a
 * `parent_id` cycle terminates instead of looping.
 */
export async function trashedAncestorOf(pageId: number): Promise<TrashedAncestor | null> {
  const result = await query<AncestorRow>(
    `WITH RECURSIVE ancestors AS (
       SELECT p.id, p.confluence_id, p.parent_id, p.title, p.source, p.space_key,
              p.visibility, p.created_by_user_id, p.deleted_at
         FROM pages p
        WHERE p.id = $1
       UNION
       SELECT p.id, p.confluence_id, p.parent_id, p.title, p.source, p.space_key,
              p.visibility, p.created_by_user_id, p.deleted_at
         FROM pages p
         JOIN ancestors a ON a.parent_id IS NOT NULL
              AND (p.confluence_id = a.parent_id OR CAST(p.id AS TEXT) = a.parent_id)
     )
     SELECT id, confluence_id, parent_id, title, source, space_key, visibility,
            created_by_user_id, deleted_at
       FROM ancestors`,
    [pageId],
  );

  const byKey = new Map(result.rows.map((row) => [subtreeKeyOf(row), row]));
  const seen = new Set<number>([pageId]);
  let cursor = result.rows.find((row) => row.id === pageId);
  while (cursor?.parent_id) {
    const parent = byKey.get(cursor.parent_id);
    if (!parent || seen.has(parent.id)) return null;
    if (parent.deleted_at) {
      return {
        id: parent.id,
        title: parent.title,
        source: parent.source,
        spaceKey: parent.space_key,
        visibility: parent.visibility,
        createdByUserId: parent.created_by_user_id,
      };
    }
    seen.add(parent.id);
    cursor = parent;
  }
  return null;
}
