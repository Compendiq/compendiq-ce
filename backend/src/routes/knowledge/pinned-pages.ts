import { FastifyInstance } from 'fastify';
import { query } from '../../core/db/postgres.js';
import { userCanAccessPage } from '../../core/services/rbac-service.js';
import { z } from 'zod';

const IdParamSchema = z.object({ id: z.string().min(1) });

export async function pinnedPagesRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  // There is deliberately no cap on how many articles a user may pin (#1130).
  // The list is per-user, hand-curated and returned in one query; the dashboard
  // section collapses past a handful rather than the server refusing the pin.

  // GET /api/pages/pinned - list pinned articles for the current user
  // pinned_pages.page_id is INTEGER FK → pages.id (migration 030)
  fastify.get('/pages/pinned', async (request) => {
    const userId = request.userId;

    const result = await query<{
      page_id: number;
      pin_order: number;
      pinned_at: Date;
      space_key: string;
      title: string;
      author: string | null;
      last_modified_at: Date | null;
      body_text: string | null;
    }>(
      // Truncate the excerpt in SQL, not in JS. The row count is unbounded
      // since #1130, and `body_text` is a TOASTed full-article column — a user
      // with 200 pins would make Postgres detoast and ship every article body
      // just so `.slice(0, 200)` could throw all but a fraction of it away.
      // Matches `search.ts`, which does the same for the same reason.
      `SELECT pp.page_id, pp.pin_order, pp.pinned_at,
              cp.space_key, cp.title, cp.author, cp.last_modified_at,
              substring(cp.body_text, 1, 200) AS body_text
       FROM pinned_pages pp
       JOIN pages cp ON cp.id = pp.page_id
       WHERE pp.user_id = $1
         AND cp.deleted_at IS NULL
       ORDER BY pp.pinned_at DESC`,
      [userId],
    );

    return {
      items: result.rows.map((row) => ({
        id: String(row.page_id),
        spaceKey: row.space_key,
        title: row.title,
        author: row.author,
        lastModifiedAt: row.last_modified_at,
        excerpt: row.body_text ? row.body_text.slice(0, 200) : '',
        pinnedAt: row.pinned_at,
        pinOrder: row.pin_order,
      })),
      total: result.rows.length,
    };
  });

  // POST /api/pages/:id/pin - pin an article
  // Frontend sends integer PK as the :id parameter
  fastify.post('/pages/:id/pin', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    const userId = request.userId;

    // Parse as integer PK (frontend sends stringified integer PKs)
    const numericId = parseInt(id, 10);
    if (isNaN(numericId)) {
      throw fastify.httpErrors.badRequest('Invalid page ID');
    }

    // Verify the page exists and the user can access it. userCanAccessPage()
    // handles confluence (RBAC spaces + page-level ACEs), standalone
    // (shared/private visibility), and local-space pages, plus the
    // system-admin bypass, and returns false for missing/soft-deleted pages —
    // matching GET /pages/:id semantics so a restricted or nonexistent page is
    // a 404 in either case.
    if (!(await userCanAccessPage(userId, numericId))) {
      throw fastify.httpErrors.notFound('Page not found');
    }

    const pageId = numericId;

    // If already pinned, return 200 immediately (idempotent)
    const alreadyPinned = await query<{ page_id: number }>(
      'SELECT page_id FROM pinned_pages WHERE user_id = $1 AND page_id = $2',
      [userId, pageId],
    );
    if (alreadyPinned.rows.length > 0) {
      return { message: 'Page pinned', pageId: id };
    }

    // Single-statement insert. The already-pinned check above is a fast path,
    // not a guard: two simultaneous pins of the same page both reach here, so
    // ON CONFLICT is what keeps the second one from raising a unique
    // violation. A rowCount of 0 therefore means "someone else pinned it a
    // moment ago" — the same outcome the caller asked for, so it is a 200.
    await query(
      `INSERT INTO pinned_pages (user_id, page_id, pin_order, pinned_at)
       SELECT $1, $2, COALESCE((SELECT MAX(pin_order) FROM pinned_pages WHERE user_id = $1), 0) + 1, NOW()
       ON CONFLICT (user_id, page_id) DO NOTHING`,
      [userId, pageId],
    );

    return { message: 'Page pinned', pageId: id };
  });

  // DELETE /api/pages/:id/pin - unpin an article
  fastify.delete('/pages/:id/pin', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    const userId = request.userId;

    // Parse as integer PK
    const numericId = parseInt(id, 10);
    if (isNaN(numericId)) {
      throw fastify.httpErrors.badRequest('Invalid page ID');
    }

    const result = await query(
      'DELETE FROM pinned_pages WHERE user_id = $1 AND page_id = $2',
      [userId, numericId],
    );

    if ((result.rowCount ?? 0) === 0) {
      throw fastify.httpErrors.notFound('Pin not found');
    }

    return { message: 'Page unpinned', pageId: id };
  });
}
