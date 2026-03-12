import { FastifyInstance } from 'fastify';
import { query } from '../../core/db/postgres.js';
import { z } from 'zod';

const IdParamSchema = z.object({ id: z.string().min(1) });

export async function pinnedPagesRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  const MAX_PINS = 8;

  // GET /api/pages/pinned - list pinned articles for the current user
  fastify.get('/pages/pinned', async (request) => {
    const userId = request.userId;

    const result = await query<{
      page_id: string;
      pin_order: number;
      pinned_at: Date;
      confluence_id: string;
      space_key: string;
      title: string;
      author: string | null;
      last_modified_at: Date | null;
      body_text: string | null;
    }>(
      `SELECT pp.page_id, pp.pin_order, pp.pinned_at,
              cp.confluence_id, cp.space_key, cp.title, cp.author, cp.last_modified_at, cp.body_text
       FROM pinned_pages pp
       JOIN cached_pages cp ON cp.confluence_id = pp.page_id
       WHERE pp.user_id = $1
       ORDER BY pp.pinned_at DESC`,
      [userId],
    );

    return {
      items: result.rows.map((row) => ({
        id: row.confluence_id,
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
  fastify.post('/pages/:id/pin', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    const userId = request.userId;

    // Verify the page exists for this user
    const pageResult = await query<{ confluence_id: string }>(
      `SELECT cp.confluence_id FROM cached_pages cp
       JOIN user_space_selections uss ON cp.space_key = uss.space_key AND uss.user_id = $1
       WHERE cp.confluence_id = $2`,
      [userId, id],
    );
    if (pageResult.rows.length === 0) {
      throw fastify.httpErrors.notFound('Page not found');
    }

    // If already pinned, return 200 immediately (idempotent)
    const alreadyPinned = await query<{ page_id: string }>(
      'SELECT page_id FROM pinned_pages WHERE user_id = $1 AND page_id = $2',
      [userId, id],
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
      [userId, id, MAX_PINS],
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

    const result = await query(
      'DELETE FROM pinned_pages WHERE user_id = $1 AND page_id = $2',
      [userId, id],
    );

    if ((result.rowCount ?? 0) === 0) {
      throw fastify.httpErrors.notFound('Pin not found');
    }

    return { message: 'Page unpinned', pageId: id };
  });
}
