/**
 * Application-defined PostgreSQL advisory-lock keys.
 *
 * Keys must stay unique among advisory-lock users of this database (the
 * migrations runner uses 745_001). Taken with `pg_advisory_xact_lock`, i.e.
 * transaction-scoped: released automatically at COMMIT/ROLLBACK, so an error
 * path can never leak one.
 */

/**
 * Global mutex for every operation that re-points `pages.parent_id` or changes
 * a page's identity: `PUT /api/pages/:id/move` (#891) and
 * `POST /api/pages/:id/relocate` (#1123).
 *
 * The two must serialize against each other, not just against themselves. A
 * move re-parents a page using the identifier flavour its parent has *now*,
 * and a relocate changes exactly that flavour — interleaved, one can write a
 * `parent_id` the other has just invalidated. One global lock is acceptable
 * because both operations are rare, and it is far simpler than row-level lock
 * ordering across a subtree.
 *
 * Lives in `core/db` rather than beside either route so the knowledge-domain
 * relocate service can take it without importing a route module (the ESLint
 * boundary forbids domain → routes).
 */
export const PAGE_MOVE_ADVISORY_LOCK_ID = 891_001;

/**
 * Two-key `pg_advisory_xact_lock(COLLAB_INIT_LOCK_KEY, pageId)` taken when a
 * collab room is first created for a page. Distinct from page-move (891_001)
 * and migrations (745_001). BYTEA init in a later PR uses the same key.
 */
export const COLLAB_INIT_LOCK_KEY = 1_411_001;
