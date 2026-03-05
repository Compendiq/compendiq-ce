import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '../db/postgres.js';
import { reEncryptPat } from '../utils/crypto.js';
import { getAuditLog, logAuditEvent } from '../services/audit-service.js';
import { listErrors, resolveError, getErrorSummary } from '../services/error-tracker.js';
import { logger } from '../utils/logger.js';

const AuditLogQuerySchema = z.object({
  userId: z.string().optional(),
  action: z.string().optional(),
  resourceType: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(50),
});

const ErrorsQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(50),
  errorType: z.string().optional(),
  resolved: z.enum(['true', 'false']).optional(),
});

const ErrorIdParamSchema = z.object({ id: z.string().min(1) });

const LabelRenameSchema = z.object({
  oldName: z.string().min(1),
  newName: z.string().min(1),
}).refine((d) => d.oldName !== d.newName, { message: 'oldName and newName must differ' });

const LabelNameParamSchema = z.object({ name: z.string().min(1) });

// Rate limit config for admin endpoints (20 requests per minute)
const ADMIN_RATE_LIMIT = { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } };

export async function adminRoutes(fastify: FastifyInstance) {
  // All admin routes require admin role
  fastify.addHook('onRequest', fastify.requireAdmin);

  // POST /api/admin/rotate-encryption-key - re-encrypt all PATs with the latest key
  fastify.post('/admin/rotate-encryption-key', ADMIN_RATE_LIMIT, async (request) => {
    const userId = request.userId;

    logger.info({ userId }, 'Starting encryption key rotation');

    // Fetch all encrypted PATs
    const result = await query<{ user_id: string; confluence_pat: string }>(
      'SELECT user_id, confluence_pat FROM user_settings WHERE confluence_pat IS NOT NULL',
    );

    let rotated = 0;
    let skipped = 0;
    let errors = 0;

    for (const row of result.rows) {
      try {
        const reEncrypted = reEncryptPat(row.confluence_pat);
        if (reEncrypted) {
          await query(
            'UPDATE user_settings SET confluence_pat = $1 WHERE user_id = $2',
            [reEncrypted, row.user_id],
          );
          rotated++;
        } else {
          skipped++; // Already using latest key
        }
      } catch (err) {
        errors++;
        logger.error({ err, userId: row.user_id }, 'Failed to re-encrypt PAT for user');
      }
    }

    await logAuditEvent(
      userId,
      'ENCRYPTION_KEY_ROTATED',
      'system',
      undefined,
      { rotated, skipped, errors, totalPats: result.rows.length },
      request,
    );

    logger.info({ rotated, skipped, errors }, 'Encryption key rotation completed');

    return {
      message: 'Encryption key rotation completed',
      rotated,
      skipped,
      errors,
      total: result.rows.length,
    };
  });

  // GET /api/admin/audit-log - query audit log with pagination/filtering
  fastify.get('/admin/audit-log', ADMIN_RATE_LIMIT, async (request) => {
    const { userId: filterUserId, action, resourceType, startDate, endDate, page, limit } =
      AuditLogQuerySchema.parse(request.query);

    return getAuditLog({
      userId: filterUserId,
      action,
      resourceType,
      startDate: startDate ? new Date(startDate) : undefined,
      endDate: endDate ? new Date(endDate) : undefined,
      page,
      limit,
    });
  });

  // ========================
  // Error monitoring routes
  // ========================

  // GET /api/admin/errors - list errors with pagination and filtering
  fastify.get('/admin/errors', ADMIN_RATE_LIMIT, async (request) => {
    const { page, limit, errorType, resolved } = ErrorsQuerySchema.parse(request.query);

    return listErrors({
      page,
      limit,
      errorType,
      resolved: resolved !== undefined ? resolved === 'true' : undefined,
    });
  });

  // PUT /api/admin/errors/:id/resolve - mark an error as resolved
  fastify.put('/admin/errors/:id/resolve', ADMIN_RATE_LIMIT, async (request) => {
    const { id } = ErrorIdParamSchema.parse(request.params);
    const resolved = await resolveError(id);
    if (!resolved) {
      throw fastify.httpErrors.notFound('Error not found');
    }
    return { message: 'Error marked as resolved' };
  });

  // GET /api/admin/errors/summary - error counts grouped by type and time window
  fastify.get('/admin/errors/summary', ADMIN_RATE_LIMIT, async () => {
    return getErrorSummary();
  });

  // ========================
  // Label management routes
  // ========================

  // GET /api/admin/labels - list all unique labels with usage count
  fastify.get('/admin/labels', ADMIN_RATE_LIMIT, async () => {
    const result = await query<{ label: string; page_count: number }>(
      `SELECT unnest(labels) as label, COUNT(*) as page_count
       FROM cached_pages
       WHERE labels IS NOT NULL AND array_length(labels, 1) > 0
       GROUP BY label
       ORDER BY label ASC`,
    );

    return result.rows.map((r) => ({
      name: r.label,
      pageCount: Number(r.page_count),
    }));
  });

  // PUT /api/admin/labels/rename - rename a label across all pages
  fastify.put('/admin/labels/rename', ADMIN_RATE_LIMIT, async (request) => {
    const { oldName, newName } = LabelRenameSchema.parse(request.body);

    // Replace oldName with newName in the labels array for all pages that have the old label
    const result = await query(
      `UPDATE cached_pages
       SET labels = array_replace(labels, $1, $2)
       WHERE $1 = ANY(labels)`,
      [oldName, newName],
    );

    await logAuditEvent(
      request.userId,
      'ADMIN_ACTION',
      'label',
      undefined,
      { action: 'rename', oldName, newName, affectedPages: result.rowCount },
      request,
    );

    return {
      message: `Label renamed from "${oldName}" to "${newName}"`,
      affectedPages: result.rowCount ?? 0,
    };
  });

  // DELETE /api/admin/labels/:name - remove a label from all pages
  fastify.delete('/admin/labels/:name', ADMIN_RATE_LIMIT, async (request) => {
    const { name } = LabelNameParamSchema.parse(request.params);

    const result = await query(
      `UPDATE cached_pages
       SET labels = array_remove(labels, $1)
       WHERE $1 = ANY(labels)`,
      [name],
    );

    await logAuditEvent(
      request.userId,
      'ADMIN_ACTION',
      'label',
      undefined,
      { action: 'delete', name, affectedPages: result.rowCount },
      request,
    );

    return {
      message: `Label "${name}" removed from all pages`,
      affectedPages: result.rowCount ?? 0,
    };
  });
}
