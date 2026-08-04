import { FastifyInstance } from 'fastify';
import { query, getPool } from '../../core/db/postgres.js';
import { RedisCache } from '../../core/services/redis-cache.js';
import { logAuditEvent } from '../../core/services/audit-service.js';
import { userCanAccessPage, getUserAccessibleSpaces } from '../../core/services/rbac-service.js';
// #1166: `/move` and `POST /pages/:id/relocate` are the two writers of
// `pages.parent_id`; they must agree both on which identifier flavour a child
// stores and on what makes an identifier too ambiguous to store, so both
// derive those from these helpers rather than re-deriving them.
import {
  parentKeyFor,
  assertIdentifierUnambiguous,
  RelocateError,
} from '../../domains/knowledge/services/page-relocate-service.js';
import { z } from 'zod';

const CreateLocalSpaceSchema = z.object({
  key: z.string().min(1).max(50).regex(/^[A-Z0-9_]+$/, 'Space key must be uppercase alphanumeric with underscores'),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  icon: z.string().max(100).optional(),
});

const UpdateLocalSpaceSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  icon: z.string().max(100).optional(),
});

const KeyParamSchema = z.object({ key: z.string().min(1) });

/** Largest value `pages.id` can hold — the column is SERIAL, i.e. int4. */
const MAX_PAGE_ID = 2147483647;

/**
 * `:id` for the three routes below is the moved/reordered page's own
 * `pages.id`, and every one of them spends it on a bare `WHERE id = $1`.
 *
 * Postgres casts the text parameter to int4 there, so an identifier that is
 * not a valid int4 aborts the statement rather than failing to match: `abc`
 * raises `22P02 invalid_text_representation` and a Confluence content id above
 * 2^31 raises `22003 numeric_value_out_of_range`. Both surfaced as a 500 —
 * `PUT /api/pages/CONF-1/move` and `PUT /api/pages/3000000000/reorder` were
 * "Internal Server Error" for what is simply not a page id this route accepts.
 *
 * Guarded at the schema rather than at each call site so a fourth route added
 * to this file cannot reintroduce it. The bound is what makes it total: a
 * digits-only check alone still overflows.
 *
 * This is deliberately NOT the dual-arm `confluence_id = $1 OR id::text = $1`
 * resolution that `GET /pages/:id/children` and the *parent* lookup in `/move`
 * use (#1167). Those accept either identifier by design; these three address a
 * local row by its primary key, the frontend sends exactly that, and widening
 * them would change which pages they can reach rather than fix an error.
 */
const IdParamSchema = z.object({
  id: z
    .string()
    .min(1)
    .refine((v) => /^\d+$/.test(v) && Number(v) <= MAX_PAGE_ID, 'Invalid page ID'),
});

const MovePageSchema = z.object({
  parentId: z.union([z.string(), z.number()]).nullable(),
  spaceKey: z.string().min(1).optional(),
});

const ReorderPageSchema = z.object({
  sortOrder: z.number().int().min(0),
});

/**
 * Global mutex for PUT /pages/:id/move (#891 review follow-up). Defined in
 * `core/db/advisory-locks` since #1123 so `POST /api/pages/:id/relocate` can
 * take the same lock without a domain → routes import; re-exported here
 * because the integration test that proves moves serialize on it imports the
 * constant from this module.
 */
export { PAGE_MOVE_ADVISORY_LOCK_ID } from '../../core/db/advisory-locks.js';
import { PAGE_MOVE_ADVISORY_LOCK_ID } from '../../core/db/advisory-locks.js';

/**
 * Compute the materialized path for a page given its parent's path and its own id.
 */
function computePath(parentPath: string | null, pageId: number): string {
  if (!parentPath) return `/${pageId}`;
  return `${parentPath}/${pageId}`;
}

/**
 * Compute depth from a path string.
 */
function computeDepth(path: string): number {
  // Path format: /1/2/3 => depth = count of segments - 1 (root = 0)
  return path.split('/').filter(Boolean).length - 1;
}

export async function localSpacesRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);
  const cache = new RedisCache(fastify.redis);

  // GET /api/spaces/local - list local spaces
  fastify.get('/spaces/local', async (request) => {
    const userId = request.userId;

    const cacheKey = 'local-spaces:list';
    const cached = await cache.get<unknown[]>(userId, 'spaces', cacheKey);
    if (cached) return cached;

    // #352: surface `custom_home_page_id` (and the resolved wire-format
    // `homepageId`) so the frontend "Show home content" toggle works for
    // local spaces too — same shape as routes/confluence/spaces.ts. Local
    // spaces have no Confluence-derived `homepage_id`, so the resolution
    // collapses to "custom_home_page_id or null".
    const result = await query<{
      space_key: string;
      space_name: string;
      description: string | null;
      icon: string | null;
      created_by: string | null;
      created_at: Date | null;
      custom_home_page_id: number | null;
    }>(
      `SELECT cs.space_key, cs.space_name, cs.description, cs.icon, cs.created_by,
              cs.last_synced AS created_at,
              cs.custom_home_page_id
       FROM spaces cs
       WHERE cs.source = 'local'
       ORDER BY cs.space_name`,
    );

    // Get page counts per local space
    const countsResult = await query<{ space_key: string; count: string }>(
      `SELECT space_key, COUNT(*) as count
       FROM pages
       WHERE space_key IN (SELECT space_key FROM spaces WHERE source = 'local')
         AND deleted_at IS NULL
       GROUP BY space_key`,
    );
    const counts = new Map(countsResult.rows.map((r) => [r.space_key, parseInt(r.count, 10)]));

    const spaces = result.rows.map((row) => ({
      key: row.space_key,
      name: row.space_name,
      description: row.description,
      icon: row.icon,
      createdBy: row.created_by,
      createdAt: row.created_at,
      pageCount: counts.get(row.space_key) ?? 0,
      source: 'local' as const,
      // #352: matches the wire format used by GET /api/spaces (Confluence
      // route). Frontend reads `homepageId` for the "Show home content"
      // toggle in PagesPage.tsx; `customHomePageId` is exposed for the
      // admin/space-owner override UI.
      homepageId:
        row.custom_home_page_id != null ? String(row.custom_home_page_id) : null,
      customHomePageId: row.custom_home_page_id,
    }));

    await cache.set(userId, 'spaces', cacheKey, spaces);
    return spaces;
  });

  // POST /api/spaces/local - create a local space
  fastify.post('/spaces/local', async (request) => {
    const userId = request.userId;
    const body = CreateLocalSpaceSchema.parse(request.body);

    // Check for duplicate key
    const existing = await query(
      'SELECT 1 FROM spaces WHERE space_key = $1',
      [body.key],
    );
    if (existing.rows.length > 0) {
      throw fastify.httpErrors.conflict('A space with this key already exists');
    }

    await query(
      `INSERT INTO spaces (space_key, space_name, description, icon, source, created_by, last_synced)
       VALUES ($1, $2, $3, $4, 'local', $5, NOW())`,
      [body.key, body.name, body.description ?? null, body.icon ?? null, userId],
    );

    await cache.invalidate(userId, 'spaces');
    await logAuditEvent(userId, 'LOCAL_SPACE_CREATED', 'space', body.key,
      { name: body.name }, request);

    return { key: body.key, name: body.name, source: 'local' };
  });

  // PUT /api/spaces/local/:key - update local space metadata
  fastify.put('/spaces/local/:key', async (request) => {
    const userId = request.userId;
    const { key } = KeyParamSchema.parse(request.params);
    const body = UpdateLocalSpaceSchema.parse(request.body);

    // Verify it's a local space
    const existing = await query<{ source: string; created_by: string | null }>(
      'SELECT source, created_by FROM spaces WHERE space_key = $1',
      [key],
    );
    if (existing.rows.length === 0) {
      throw fastify.httpErrors.notFound('Space not found');
    }
    if (existing.rows[0]!.source !== 'local') {
      throw fastify.httpErrors.badRequest('Cannot modify a Confluence-synced space');
    }

    const setClauses: string[] = [];
    const values: unknown[] = [];
    let paramIdx = 1;

    if (body.name !== undefined) {
      setClauses.push(`space_name = $${paramIdx++}`);
      values.push(body.name);
    }
    if (body.description !== undefined) {
      setClauses.push(`description = $${paramIdx++}`);
      values.push(body.description);
    }
    if (body.icon !== undefined) {
      setClauses.push(`icon = $${paramIdx++}`);
      values.push(body.icon);
    }

    if (setClauses.length === 0) {
      throw fastify.httpErrors.badRequest('No fields to update');
    }

    values.push(key);
    await query(
      `UPDATE spaces SET ${setClauses.join(', ')} WHERE space_key = $${paramIdx}`,
      values,
    );

    await cache.invalidate(userId, 'spaces');
    await logAuditEvent(userId, 'LOCAL_SPACE_UPDATED', 'space', key, body, request);

    return { key, updated: true };
  });

  // DELETE /api/spaces/local/:key - delete a local space
  fastify.delete('/spaces/local/:key', async (request) => {
    const userId = request.userId;
    const { key } = KeyParamSchema.parse(request.params);

    const existing = await query<{ source: string }>(
      'SELECT source FROM spaces WHERE space_key = $1',
      [key],
    );
    if (existing.rows.length === 0) {
      throw fastify.httpErrors.notFound('Space not found');
    }
    if (existing.rows[0]!.source !== 'local') {
      throw fastify.httpErrors.badRequest('Cannot delete a Confluence-synced space');
    }

    // Check if space has pages — require cascade or empty
    const pageCount = await query<{ count: string }>(
      'SELECT COUNT(*) as count FROM pages WHERE space_key = $1 AND deleted_at IS NULL',
      [key],
    );
    const pageCountRow = pageCount.rows[0];
    if (!pageCountRow) throw new Error('Expected a row from COUNT query');
    if (parseInt(pageCountRow.count, 10) > 0) {
      throw fastify.httpErrors.conflict(
        'Space still has pages. Delete or move all pages first.',
      );
    }

    await query('DELETE FROM spaces WHERE space_key = $1', [key]);

    await cache.invalidate(userId, 'spaces');
    await logAuditEvent(userId, 'LOCAL_SPACE_DELETED', 'space', key, {}, request);

    return { key, deleted: true };
  });

  // GET /api/spaces/:key/tree - get full page tree for a space
  fastify.get('/spaces/:key/tree', async (request) => {
    const userId = request.userId;
    const { key } = KeyParamSchema.parse(request.params);

    // #817: gate cross-space access BEFORE reading the cache so a revoked user
    // cannot replay their own per-user cached tree during the TTL window.
    // Verify the space exists and resolve its source for the RBAC gate.
    const spaceCheck = await query<{ source: string }>(
      'SELECT source FROM spaces WHERE space_key = $1',
      [key],
    );
    if (spaceCheck.rows.length === 0) {
      throw fastify.httpErrors.notFound('Space not found');
    }
    // Confluence-synced spaces require an RBAC space assignment; local spaces
    // are accessible to all authenticated users (same model as the move handler
    // and GET /api/pages/tree). 404 (not 403) so a restricted space is
    // indistinguishable from a nonexistent one (no existence oracle).
    if (spaceCheck.rows[0]!.source !== 'local') {
      const accessibleSpaces = await getUserAccessibleSpaces(userId);
      if (!accessibleSpaces.includes(key)) {
        throw fastify.httpErrors.notFound('Space not found');
      }
    }

    const cacheKey = `space-tree:${key}`;
    const cached = await cache.get(userId, 'spaces', cacheKey);
    if (cached) return cached;

    const result = await query<{
      id: number;
      title: string;
      page_type: string;
      parent_numeric_id: number | null;
      depth: number;
      sort_order: number;
      source: string;
      confluence_id: string | null;
    }>(
      `SELECT p.id, p.title, p.page_type, parent_page.id as parent_numeric_id,
              p.depth, p.sort_order, p.source, p.confluence_id
       FROM pages p
       LEFT JOIN pages parent_page ON (
         parent_page.confluence_id = p.parent_id
         OR CAST(parent_page.id AS TEXT) = p.parent_id
       ) AND parent_page.deleted_at IS NULL
       WHERE p.space_key = $1 AND p.deleted_at IS NULL
       ORDER BY p.sort_order, p.title`,
      [key],
    );

    const items = result.rows.map((row) => ({
      id: row.id,
      title: row.title,
      pageType: row.page_type ?? 'page',
      parentId: row.parent_numeric_id ? String(row.parent_numeric_id) : null,
      depth: row.depth,
      sortOrder: row.sort_order,
      source: row.source,
      confluenceId: row.confluence_id,
    }));

    const response = { spaceKey: key, items, total: items.length };
    await cache.set(userId, 'spaces', cacheKey, response, 300);
    return response;
  });

  // PUT /api/pages/:id/move - move page to different parent/space
  fastify.put('/pages/:id/move', async (request) => {
    const userId = request.userId;
    const { id } = IdParamSchema.parse(request.params);
    const body = MovePageSchema.parse(request.body);

    // Look up the page. Only `id` and `space_key` are needed here: the
    // parent/path state the move actually writes from is re-read under the
    // advisory lock below, and the `parent_id` flavour depends on the *target
    // parent's* source, not this page's (#1166).
    const existing = await query<{
      id: number;
      space_key: string | null;
    }>(
      'SELECT id, space_key FROM pages WHERE id = $1 AND deleted_at IS NULL',
      [id],
    );
    if (existing.rows.length === 0) {
      throw fastify.httpErrors.notFound('Page not found');
    }

    const page = existing.rows[0]!;

    // #733: the caller must be able to access the page being moved. 404 (not
    // 403) so restricted pages are indistinguishable from nonexistent ones.
    if (!(await userCanAccessPage(userId, page.id))) {
      throw fastify.httpErrors.notFound('Page not found');
    }

    const newSpaceKey = body.spaceKey ?? page.space_key;

    // #733: when the move changes the page's space, the target space must
    // exist and be writable by the caller. Confluence-synced spaces require
    // an RBAC space assignment; local spaces are accessible to all
    // authenticated users (same model as POST /api/pages and the page tree).
    if (newSpaceKey !== null && newSpaceKey !== page.space_key) {
      const targetSpace = await query<{ source: string }>(
        'SELECT source FROM spaces WHERE space_key = $1',
        [newSpaceKey],
      );
      if (targetSpace.rows.length === 0) {
        throw fastify.httpErrors.badRequest('Target space not found');
      }
      if (targetSpace.rows[0]!.source !== 'local') {
        const accessibleSpaces = await getUserAccessibleSpaces(userId);
        if (!accessibleSpaces.includes(newSpaceKey)) {
          throw fastify.httpErrors.forbidden('You do not have access to the target space');
        }
      }
    }

    // #891 review follow-up: the cycle check and the UPDATEs below must run
    // atomically AND serialized across requests. Without serialization, two
    // concurrent moves (A under B, and B under A) can each pass the ancestor
    // walk against the pre-move state and both commit, creating a mutual
    // parent_id cycle. Concurrent moves queue on the advisory lock, so each
    // waiter re-runs its cycle check against the previous winner's committed
    // state. Must use a dedicated client — pool.query() draws a random
    // connection per call, so BEGIN/COMMIT would run on different connections
    // (non-atomic) and the xact-scoped lock would bind to the wrong session.
    let moved: {
      id: number;
      /** The key actually written to `pages.parent_id` — see #1166. */
      parentId: string | null;
      spaceKey: string | null;
      path: string;
      depth: number;
    };
    const txClient = await getPool().connect();
    try {
      await txClient.query('BEGIN');
      await txClient.query('SELECT pg_advisory_xact_lock($1)', [PAGE_MOVE_ADVISORY_LOCK_ID]);

      // Re-read the page under the lock: a queued concurrent move may have
      // changed its parent/path/space between the pre-checks above and now,
      // and the descendant rewrite below must use the committed old path.
      const fresh = await txClient.query<{
        parent_id: string | null;
        space_key: string | null;
        path: string | null;
      }>(
        'SELECT parent_id, space_key, path FROM pages WHERE id = $1 AND deleted_at IS NULL',
        [page.id],
      );
      if (fresh.rows.length === 0) {
        throw fastify.httpErrors.notFound('Page not found');
      }
      const current = fresh.rows[0]!;
      // `MovePageSchema.parentId` is `.nullable()` but not `.optional()`, so
      // the fallback is unreachable today — every move states its parent. It
      // stays as the defined behaviour for a space-only body, and the parent
      // lookup below is dual-arm partly so that `current.parent_id` (already a
      // stored key, i.e. a Confluence id under a Confluence parent) resolves
      // if the schema is ever widened.
      const moveParentId = body.parentId !== undefined ? body.parentId : current.parent_id;
      const moveSpaceKey = body.spaceKey ?? current.space_key;

      // If new parent is specified, verify it exists (and take its path for
      // the materialized-path computation below, plus the identifier its
      // children must store).
      let parentPath: string | null = null;
      let parentKey: string | null = null;
      if (moveParentId !== null) {
        // #1166: resolve the parent against BOTH arms of the dual-identifier
        // scheme, exactly as `GET /pages/:id/children` does. The incoming
        // `parentId` may be a numeric `pages.id`, a Confluence page id, or —
        // on a space-only move, where it falls back to the stored
        // `current.parent_id` — whichever flavour the column already holds.
        // Resolving against `pages.id` alone made a Confluence-parented page
        // unmovable: `WHERE id = 'CONF-1'` is a `22P02`, and a numeric
        // Confluence id above 2^31 a `22003`, both aborting the statement as a
        // 500. Compare `id::text = $1` and never cast the parameter to int
        // (same hazard as #1167 — note this covers the *parent* identifier
        // only; the moved page's own `:id` is resolved separately above).
        //
        // Confluence DC ids are numeric strings, so one value can match a
        // `pages.id` AND some other row's `confluence_id`. Ambiguity is
        // refused outright below rather than resolved by preferring one arm:
        // see `assertIdentifierUnambiguous`.
        const requestedKey = String(moveParentId);
        const parentCheck = await txClient.query<{
          id: number;
          path: string | null;
          source: string;
          confluence_id: string | null;
        }>(
          `SELECT id, path, source, confluence_id FROM pages
           WHERE (confluence_id = $1 OR id::text = $1) AND deleted_at IS NULL
           ORDER BY (confluence_id IS NOT DISTINCT FROM $1) DESC, id
           LIMIT 1`,
          [requestedKey],
        );
        const parent = parentCheck.rows[0];
        if (!parent) {
          throw fastify.httpErrors.badRequest('Parent page not found');
        }
        parentPath = parent.path;
        // #1166: `parent_id` is a TEXT column whose meaning depends on the
        // parent's source — the parent's `confluence_id` when it is
        // Confluence-sourced, its numeric id as text otherwise. Same rule
        // relocate applies, from the same helper, so the two writers of this
        // column cannot drift.
        //
        // There is no flavour that satisfies every reader: `embedding-service`
        // joins `parent.confluence_id = child.parent_id` while
        // `pages-embeddings` joins `p.parent_id = a.id::text`, which are
        // contradictory single arms. Writing the parent's own key wins
        // `subpage-context` and `embedding-service` and loses
        // `pages-embeddings` clustering. That loss is *alignment*, not damage:
        // a natively synced Confluence child is absent from those clusters
        // too, so a moved child now behaves exactly like its synced siblings
        // instead of like a standalone page that happens to sit under one.
        parentKey = parentKeyFor(parent.source, parent.id, parent.confluence_id);

        // #1166 review: refuse an ambiguous identifier instead of picking a
        // winner. Resolving to one row settles `parentPath` and `parentKey`,
        // but the value actually STORED stays ambiguous, and every reader
        // resolves it against both arms — so the cycle guard below would
        // validate the one row `LIMIT 1` picked while readers follow the
        // other. That reopened #891: with a decoy whose `confluence_id` equals
        // the moved page's own id, a page became its own parent (the tree CTE
        // then returns it as its own descendant, to the recursion cap).
        //
        // Both identifiers are checked, because they differ when a Confluence
        // parent is addressed by its numeric id: `requestedKey` decides which
        // row we resolved, `parentKey` is what children will resolve against.
        // Delegated to relocate's guard so the two writers of this column
        // agree on what "ambiguous" means — including its deliberate counting
        // of soft-deleted rows, which still own their `confluence_id` and can
        // be restored back into contention.
        try {
          await assertIdentifierUnambiguous(requestedKey, parent.id, 'parent', txClient, 'move');
          if (parentKey !== requestedKey) {
            await assertIdentifierUnambiguous(parentKey, parent.id, 'stored parent', txClient, 'move');
          }
        } catch (err) {
          if (err instanceof RelocateError) throw fastify.httpErrors.conflict(err.message);
          throw err;
        }

        // Prevent circular reference (#891): reject moving a page under itself or
        // under any of its own descendants. Walk the ancestor chain of the target
        // parent (resolving parent_id against both confluence_id and numeric id,
        // the same dual key used by the tree queries). If the page being moved
        // appears anywhere in that chain, the move would create a cycle. UNION
        // (not UNION ALL) dedupes so a pre-existing cycle in the data cannot loop.
        // This also covers Confluence-synced pages whose materialized `path` is
        // NULL, where the old path-substring check was a silent no-op.
        //
        // The anchor takes the *resolved* `parent.id` (#1166): a genuine
        // `pages.id`, so it needs no dual arm of its own and cannot overflow
        // int4 the way the raw request identifier could.
        const cycleCheck = await txClient.query(
          `WITH RECURSIVE ancestors AS (
             SELECT id, parent_id FROM pages WHERE id = $1 AND deleted_at IS NULL
             UNION
             SELECT p.id, p.parent_id FROM pages p
             JOIN ancestors a
               ON (p.confluence_id = a.parent_id OR CAST(p.id AS TEXT) = a.parent_id)
             WHERE p.deleted_at IS NULL
           )
           SELECT 1 FROM ancestors WHERE id = $2 LIMIT 1`,
          [parent.id, page.id],
        );
        if (cycleCheck.rows.length > 0) {
          throw fastify.httpErrors.badRequest('Cannot move a page under itself or its own descendant');
        }
      }

      const newPath = computePath(parentPath, page.id);
      const newDepth = computeDepth(newPath);
      const oldPath = current.path;

      // Update the page itself
      await txClient.query(
        `UPDATE pages SET parent_id = $1, space_key = $2, path = $3, depth = $4
         WHERE id = $5`,
        [parentKey, moveSpaceKey, newPath, newDepth, page.id],
      );

      // Update all descendants: replace old path prefix with new path prefix.
      // $2 must be cast to int: node-postgres sends parameters untyped, and
      // without the cast PostgreSQL resolves `substring(text FROM unknown)` to
      // the POSIX-REGEX overload `substring(text FROM text)` — which treated
      // the numeric offset as a regex and corrupted (or NULLed) every
      // descendant path on move. Caught by the real-Postgres integration test.
      if (oldPath) {
        await txClient.query(
          `UPDATE pages
           SET path = $1 || substring(path FROM $2::int),
               depth = depth + $3,
               space_key = COALESCE($4, space_key)
           WHERE path LIKE $5 AND id != $6 AND deleted_at IS NULL`,
          [
            newPath,
            oldPath.length + 1, // skip old prefix
            newDepth - computeDepth(oldPath), // depth adjustment
            moveSpaceKey !== current.space_key ? moveSpaceKey : null,
            `${oldPath}/%`,
            page.id,
          ],
        );
      }

      await txClient.query('COMMIT');
      // #1166: the response (and the PAGE_MOVED audit metadata built from it)
      // echoes the key that was STORED, not the identifier the caller sent —
      // the two differ whenever the parent is Confluence-sourced, and echoing
      // the input reported a link the readers cannot resolve.
      moved = { id: page.id, parentId: parentKey, spaceKey: moveSpaceKey, path: newPath, depth: newDepth };
    } catch (err) {
      await txClient.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      txClient.release();
    }

    await cache.invalidate(userId, 'pages');
    await cache.invalidate(userId, 'spaces');
    await logAuditEvent(userId, 'PAGE_MOVED', 'page', String(id),
      { parentId: moved.parentId, spaceKey: moved.spaceKey }, request);

    return moved;
  });

  // PUT /api/pages/:id/reorder - reorder page within siblings
  fastify.put('/pages/:id/reorder', async (request) => {
    const userId = request.userId;
    const { id } = IdParamSchema.parse(request.params);
    const body = ReorderPageSchema.parse(request.body);

    const existing = await query<{ id: number }>(
      'SELECT id FROM pages WHERE id = $1 AND deleted_at IS NULL',
      [id],
    );
    if (existing.rows.length === 0) {
      throw fastify.httpErrors.notFound('Page not found');
    }

    // #733: the caller must be able to access the page being reordered.
    if (!(await userCanAccessPage(userId, existing.rows[0]!.id))) {
      throw fastify.httpErrors.notFound('Page not found');
    }

    // #959 review follow-up: writing sort_order only for the dragged page left
    // every untouched sibling at its original value (typically 0), so the drop
    // index was not honoured within a multi-sibling group — a page dropped at
    // the top still sorted after siblings that shared its sort_order. Renumber
    // the ENTIRE sibling group to a dense 0..N-1 sequence reflecting the new
    // order: read siblings in the tree's own order (sort_order ASC, title ASC),
    // splice the dragged id in at the requested drop index, then persist each
    // row's new position. Runs on a dedicated client inside a transaction so
    // the multi-row renumber commits atomically.
    const pageId = parseInt(String(id), 10);
    let newIndex = body.sortOrder;
    const txClient = await getPool().connect();
    try {
      await txClient.query('BEGIN');

      // Resolve the dragged page's sibling group. `parent_id` may hold the
      // parent's confluence_id or its numeric id as text (the dual key the tree
      // queries use), so resolve it to the parent's numeric id. A NULL parent
      // means a space-root group, grouped by space_key instead.
      const groupRes = await txClient.query<{ space_key: string | null; parent_num: number | null }>(
        `SELECT p.space_key,
                (SELECT tp.id FROM pages tp
                 WHERE (tp.confluence_id = p.parent_id OR CAST(tp.id AS TEXT) = p.parent_id)
                   AND tp.deleted_at IS NULL
                 LIMIT 1) AS parent_num
         FROM pages p
         WHERE p.id = $1 AND p.deleted_at IS NULL`,
        [pageId],
      );
      const group = groupRes.rows[0]!;

      const siblingsRes =
        group.parent_num !== null
          ? await txClient.query<{ id: number }>(
              `SELECT s.id FROM pages s
               WHERE s.deleted_at IS NULL
                 AND EXISTS (
                   SELECT 1 FROM pages sp
                   WHERE (sp.confluence_id = s.parent_id OR CAST(sp.id AS TEXT) = s.parent_id)
                     AND sp.deleted_at IS NULL AND sp.id = $1
                 )
               ORDER BY s.sort_order ASC, s.title ASC`,
              [group.parent_num],
            )
          : await txClient.query<{ id: number }>(
              `SELECT s.id FROM pages s
               WHERE s.deleted_at IS NULL AND s.parent_id IS NULL
                 AND s.space_key IS NOT DISTINCT FROM $1
               ORDER BY s.sort_order ASC, s.title ASC`,
              [group.space_key],
            );

      const orderedIds = siblingsRes.rows.map((r) => Number(r.id)).filter((sid) => sid !== pageId);
      newIndex = Math.max(0, Math.min(body.sortOrder, orderedIds.length));
      orderedIds.splice(newIndex, 0, pageId);

      for (let i = 0; i < orderedIds.length; i++) {
        await txClient.query('UPDATE pages SET sort_order = $1 WHERE id = $2', [i, orderedIds[i]]);
      }

      await txClient.query('COMMIT');
    } catch (err) {
      await txClient.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      txClient.release();
    }

    await cache.invalidate(userId, 'pages');
    await logAuditEvent(userId, 'PAGE_REORDERED', 'page', String(id),
      { sortOrder: newIndex }, request);

    return { id: pageId, sortOrder: newIndex };
  });

  // GET /api/pages/:id/breadcrumb - get parent chain for breadcrumb display
  fastify.get('/pages/:id/breadcrumb', async (request) => {
    const userId = request.userId;
    const { id } = IdParamSchema.parse(request.params);

    const page = await query<{
      id: number;
      title: string;
      parent_id: string | null;
      space_key: string | null;
      path: string | null;
    }>(
      'SELECT id, title, parent_id, space_key, path FROM pages WHERE id = $1 AND deleted_at IS NULL',
      [id],
    );

    if (page.rows.length === 0) {
      throw fastify.httpErrors.notFound('Page not found');
    }

    // #733: the breadcrumb leaks titles/structure of the page and all its
    // ancestors — require page access; 404 to avoid an existence oracle.
    if (!(await userCanAccessPage(userId, page.rows[0]!.id))) {
      throw fastify.httpErrors.notFound('Page not found');
    }

    // Fetch all ancestors in a single query using the materialized path column.
    // The path format is /id1/id2/id3 -- we extract the ancestor IDs, exclude
    // the current page, and fetch them all at once (eliminates N+1 queries).
    const currentPage = page.rows[0]!;
    const crumbs: { id: number; title: string }[] = [];

    if (currentPage.path) {
      const pathIds = currentPage.path
        .split('/')
        .filter(Boolean)
        .map(Number)
        .filter((pid) => pid !== currentPage.id);

      if (pathIds.length > 0) {
        const ancestors = await query<{ id: number; title: string }>(
          `SELECT id, title FROM pages
           WHERE id = ANY($1::int[]) AND deleted_at IS NULL`,
          [pathIds],
        );

        // Order ancestors according to their position in the path
        const ancestorMap = new Map(ancestors.rows.map((r) => [r.id, r]));
        for (const pid of pathIds) {
          const ancestor = ancestorMap.get(pid);
          if (ancestor) crumbs.push({ id: ancestor.id, title: ancestor.title });
        }
      }
    } else if (currentPage.parent_id !== null) {
      // Fallback for pages without materialized path: walk the parent chain
      let currentParentId: string | null = currentPage.parent_id;
      const maxDepth = 20;
      let depth = 0;

      while (currentParentId !== null && depth < maxDepth) {
        const parentResult: { rows: { id: number; title: string; parent_id: string | null }[] } =
          await query<{ id: number; title: string; parent_id: string | null }>(
            'SELECT id, title, parent_id FROM pages WHERE id = $1 AND deleted_at IS NULL',
            [currentParentId],
          );

        if (parentResult.rows.length === 0) break;
        crumbs.unshift({ id: parentResult.rows[0]!.id, title: parentResult.rows[0]!.title });
        currentParentId = parentResult.rows[0]!.parent_id;
        depth++;
      }
    }

    // Get space name and source in one query
    let spaceName: string | null = null;
    let spaceSource: 'confluence' | 'local' = 'confluence';
    const spaceKey = currentPage.space_key;
    if (spaceKey) {
      const spaceResult = await query<{ space_name: string; source: string }>(
        'SELECT space_name, source FROM spaces WHERE space_key = $1',
        [spaceKey],
      );
      if (spaceResult.rows.length > 0) {
        spaceName = spaceResult.rows[0]!.space_name;
        spaceSource = spaceResult.rows[0]!.source as 'confluence' | 'local';
      }
    }

    return {
      spaceKey,
      spaceName,
      source: spaceSource,
      ancestors: crumbs,
      current: { id: currentPage.id, title: currentPage.title },
    };
  });
}
