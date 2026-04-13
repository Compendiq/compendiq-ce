import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '../../core/db/postgres.js';
import { getUserAccessibleSpaces } from '../../core/services/rbac-service.js';
import { logger } from '../../core/utils/logger.js';

const IdParamSchema = z.object({ id: z.string().min(1) });

const OwnerBodySchema = z.object({
  ownerId: z.string().uuid(),
});

const ReviewIntervalBodySchema = z.object({
  days: z.number().int().min(1).max(365),
});

export async function verificationRoutes(fastify: FastifyInstance) {
  // All verification routes require authentication
  fastify.addHook('onRequest', fastify.authenticate);

  /** Check that a page exists and the user has access to it. Accepts integer id or confluence_id string. */
  async function assertPageAccess(pageId: string, userId: string): Promise<number> {
    const isNumeric = /^\d+$/.test(pageId);
    const verifySpaces = await getUserAccessibleSpaces(userId);
    const check = await query<{ id: number }>(
      `SELECT p.id FROM pages p
       WHERE ${isNumeric ? 'p.id = $2' : 'p.confluence_id = $2'}
         AND p.deleted_at IS NULL
         AND (
           (p.source = 'confluence' AND p.space_key = ANY($1::text[]))
           OR (p.source = 'standalone' AND p.visibility = 'shared')
           OR (p.source = 'standalone' AND p.visibility = 'private' AND p.created_by_user_id = $3)
         )`,
      [verifySpaces, isNumeric ? parseInt(pageId, 10) : pageId, userId],
    );
    if (check.rows.length === 0) {
      throw fastify.httpErrors.notFound('Page not found');
    }
    return check.rows[0]!.id;
  }

  // POST /api/pages/:id/verify — One-click re-verify
  fastify.post('/pages/:id/verify', async (request, reply) => {
    const { id } = IdParamSchema.parse(request.params);
    const userId = request.userId;

    const pageId = await assertPageAccess(id, userId);

    const result = await query(
      `UPDATE pages SET
        verified_by = $1,
        verified_at = NOW(),
        next_review_at = NOW() + (review_interval_days || ' days')::INTERVAL
       WHERE id = $2
       RETURNING id`,
      [userId, pageId],
    );

    if (result.rowCount === 0) {
      throw fastify.httpErrors.notFound('Page not found');
    }

    logger.info({ pageId: id, userId }, 'Page verified');

    reply.status(200);
    return { success: true };
  });

  // PUT /api/pages/:id/owner — Assign owner
  fastify.put('/pages/:id/owner', async (request, reply) => {
    const { id } = IdParamSchema.parse(request.params);
    const userId = request.userId;
    const { ownerId } = OwnerBodySchema.parse(request.body);

    const pageId = await assertPageAccess(id, userId);

    // Verify the owner user exists
    const userCheck = await query('SELECT id FROM users WHERE id = $1', [ownerId]);
    if (userCheck.rows.length === 0) {
      throw fastify.httpErrors.badRequest('Owner user not found');
    }

    const result = await query(
      'UPDATE pages SET owner_id = $1 WHERE id = $2 RETURNING id',
      [ownerId, pageId],
    );

    if (result.rowCount === 0) {
      throw fastify.httpErrors.notFound('Page not found');
    }

    logger.info({ pageId: id, ownerId }, 'Page owner assigned');

    reply.status(200);
    return { success: true };
  });

  // PUT /api/pages/:id/review-interval — Set review interval
  fastify.put('/pages/:id/review-interval', async (request, reply) => {
    const { id } = IdParamSchema.parse(request.params);
    const userId = request.userId;
    const { days } = ReviewIntervalBodySchema.parse(request.body);

    const pageId = await assertPageAccess(id, userId);

    // Update interval and recalculate next_review_at if page was previously verified
    const result = await query(
      `UPDATE pages SET
        review_interval_days = $1,
        next_review_at = CASE
          WHEN verified_at IS NOT NULL THEN verified_at + ($1 || ' days')::INTERVAL
          ELSE next_review_at
        END
       WHERE id = $2
       RETURNING id`,
      [days, pageId],
    );

    if (result.rowCount === 0) {
      throw fastify.httpErrors.notFound('Page not found');
    }

    logger.info({ pageId: id, reviewIntervalDays: days }, 'Review interval updated');

    reply.status(200);
    return { success: true };
  });

  // GET /api/analytics/verification-health — Dashboard stats
  fastify.get('/analytics/verification-health', async () => {
    const result = await query<{
      fresh: string;
      aging: string;
      overdue: string;
      unverified: string;
      total: string;
    }>(
      `SELECT
        COUNT(*) FILTER (WHERE next_review_at > NOW() + INTERVAL '14 days') AS fresh,
        COUNT(*) FILTER (WHERE next_review_at BETWEEN NOW() AND NOW() + INTERVAL '14 days') AS aging,
        COUNT(*) FILTER (WHERE next_review_at < NOW()) AS overdue,
        COUNT(*) FILTER (WHERE next_review_at IS NULL) AS unverified,
        COUNT(*) AS total
       FROM pages`,
    );

    const row = result.rows[0];
    if (!row) throw new Error('Expected a row from verification stats query');
    return {
      fresh: parseInt(row.fresh, 10),
      aging: parseInt(row.aging, 10),
      overdue: parseInt(row.overdue, 10),
      unverified: parseInt(row.unverified, 10),
      total: parseInt(row.total, 10),
    };
  });
}
