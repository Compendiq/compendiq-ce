import { FastifyInstance } from 'fastify';
import { query } from '../../core/db/postgres.js';
import { getUserAccessibleSpaces } from '../../core/services/rbac-service.js';
import { z } from 'zod';

const IdParamSchema = z.object({ id: z.string().min(1) });

export async function pinnedPagesRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  const MAX_PINS = 8;

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
      `SELECT pp.page_id, pp.pin_order, pp.pinned_at,
              cp.space_key, cp.title, cp.author, cp.last_modified_at, cp.body_text
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

    // Verify the page exists and user has access via RBAC
    const pinSpaces = await getUserAccessibleSpaces(userId);
    const pageResult = await query<{ id: number }>(
      `SELECT cp.id FROM pages cp
       WHERE cp.space_key = ANY($1::text[])
         AND cp.id = $2
         AND cp.deleted_at IS NULL`,
      [pinSpaces, numericId],
    );
    if (pageResult.rows.length === 0) {
      throw fastify.httpErrors.notFound('Page not found');
    }

    const pageId = pageResult.rows[0]!.id;

    // If already pinned, return 200 immediately (idempotent)
    const alreadyPinned = await query<{ page_id: number }>(
      'SELECT page_id FROM pinned_pages WHERE user_id = $1 AND page_id = $2',
      [userId, pageId],
    );
    if (alreadyPinned.rows.length > 0) {
      return { message: 'Page pinned', pageId: id };
    }

    // Atomic insert with count check to prevent race conditions
    const insertResult = await query(
      `INSERT INTO pinned_pages (user_id, page_id, pin_order, pinned_at)
       SELECT $1, $2, COALESCE((SELECT MAX(pin_order) FROM pinned_pages WHERE user_id = $1), 0) + 1, NOW()
       WHERE (SELECT COUNT(*) FROM pinned_pages WHERE user_id = $1) < $3
       ON CONFLICT (user_id, page_id) DO NOTHING`,
      [userId, pageId, MAX_PINS],
    );

    if ((insertResult.rowCount ?? 0) === 0) {
      throw fastify.httpErrors.badRequest(`Maximum of ${MAX_PINS} pinned articles allowed`);
    }

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
