/**
 * Application-defined PostgreSQL advisory-lock keys.
 *
 * Keys must stay unique among advisory-lock users of this database. Each key
 * documents whether its callers use transaction- or session-scoped locks.
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

/**
 * Session advisory lock shared by authoritative local-attachment mutations
 * and held exclusively while backup exports capture database and file state.
 */
export const ATTACHMENT_SNAPSHOT_LOCK_ID = 1_420_001;

/**
 * First key of the session advisory lock serializing imports of one normalized
 * Notion page ID. The SHA-256-derived signed second key lives with the import
 * service.
 */
export const NOTION_IMPORT_LOCK_KEY = 1_420_002;

/** Transaction mutex shared by deterministic and embedding relationship materializers. */
export const RELATIONSHIP_ADVISORY_LOCK_ID = 1_314_001;

/**
 * First key of the two-key transaction advisory lock that serializes every
 * protected page mutation, writable room admission, freeze, and thaw.
 *
 * Callers acquire `pg_advisory_xact_lock(PAGE_LIFECYCLE_LOCK_KEY, pageId)` in
 * ascending page-id order before collaboration-init, page-move, attachment,
 * or row locks.  It is never taken from a trigger.
 */
export const PAGE_LIFECYCLE_LOCK_KEY = 279_001;

/**
 * First key of the two-key transaction advisory fence for one space's durable
 * page-governance policy. `hashtext(spaceKey)` supplies the second key; a hash
 * collision can only serialize unrelated spaces.
 *
 * Final freeze transactions already hold their sorted page-lifecycle and
 * page-row locks before taking this fence in shared mode. Policy writers take
 * it exclusively and never acquire page lifecycle/row locks, so there is no
 * reverse acquisition path. Keep that order when adding a governed decision:
 *
 *   runtime epoch -> page lifecycle -> page row -> governance policy fence
 *
 * Both modes are transaction-scoped. The fence, marker read, final decision,
 * and lifecycle/policy write must therefore run in the same explicit
 * transaction; the advisory key also protects the absent-marker-row case.
 */
export const PAGE_GOVERNANCE_POLICY_LOCK_KEY = 279_002;

/**
 * Global transaction mutex for durable page-write cache invalidation delivery.
 * It serializes Redis scans across pods so a later committed write's pending
 * flag is always delivered after an earlier scan.
 */
export const PAGE_WRITE_INVALIDATION_LOCK_ID = 279_003;
