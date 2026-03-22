import { FastifyRequest } from 'fastify';
import { query } from '../db/postgres.js';
import { logger } from '../utils/logger.js';

/**
 * Defined audit event types for structured logging.
 */
export type AuditAction =
  | 'LOGIN'
  | 'LOGOUT'
  | 'LOGIN_FAILED'
  | 'REGISTER'
  | 'TOKEN_REFRESH'
  | 'TOKEN_FAMILY_REVOKED'
  | 'SETTINGS_CHANGED'
  | 'PAT_UPDATED'
  | 'PAGE_CREATED'
  | 'PAGE_UPDATED'
  | 'PAGE_DELETED'
  | 'PAGE_RESTORED'
  | 'ADMIN_ACTION'
  | 'SYNC_STARTED'
  | 'SYNC_COMPLETED'
  | 'ENCRYPTION_KEY_ROTATED'
  | 'PROMPT_INJECTION_DETECTED'
  | 'SUMMARY_RESCAN'
  | 'PDF_EXTRACTED'
  | 'DRAFT_PUBLISHED'
  | 'LOCAL_SPACE_CREATED'
  | 'LOCAL_SPACE_UPDATED'
  | 'LOCAL_SPACE_DELETED'
  | 'PAGE_MOVED'
  | 'PAGE_REORDERED'
  | 'OIDC_LOGIN'
  | 'OIDC_LOGIN_FAILED'
  | 'QUALITY_RUN_NOW'
  | 'SUMMARY_RUN_NOW'
  | 'EMBEDDING_RUN_NOW'
  | 'EMBEDDING_RESCAN'
  | 'EMBEDDING_RESET_FAILED';

export interface AuditLogEntry {
  id: string;
  userId: string | null;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  metadata: Record<string, unknown>;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: Date;
}

/**
 * Logs an audit event to the database.
 * This function never throws - audit failures are logged but do not block operations.
 */
export async function logAuditEvent(
  userId: string | null,
  action: AuditAction,
  resourceType?: string,
  resourceId?: string,
  metadata?: Record<string, unknown>,
  request?: FastifyRequest,
): Promise<void> {
  try {
    const ipAddress = request?.ip ?? null;
    const userAgent = request?.headers['user-agent'] ?? null;

    await query(
      `INSERT INTO audit_log (user_id, action, resource_type, resource_id, metadata, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        userId,
        action,
        resourceType ?? null,
        resourceId ?? null,
        JSON.stringify(metadata ?? {}),
        ipAddress,
        userAgent,
      ],
    );
  } catch (err) {
    // Audit logging must never block the main operation
    logger.error({ err, action, userId }, 'Failed to write audit log');
  }
}

export interface AuditLogFilter {
  userId?: string;
  action?: string;
  resourceType?: string;
  startDate?: Date;
  endDate?: Date;
  page?: number;
  limit?: number;
}

/**
 * Queries the audit log with pagination and filtering.
 */
export async function getAuditLog(filter: AuditLogFilter): Promise<{
  items: AuditLogEntry[];
  total: number;
  page: number;
  limit: number;
}> {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let paramIdx = 1;

  if (filter.userId) {
    conditions.push(`user_id = $${paramIdx++}`);
    values.push(filter.userId);
  }

  if (filter.action) {
    conditions.push(`action = $${paramIdx++}`);
    values.push(filter.action);
  }

  if (filter.resourceType) {
    conditions.push(`resource_type = $${paramIdx++}`);
    values.push(filter.resourceType);
  }

  if (filter.startDate) {
    conditions.push(`created_at >= $${paramIdx++}`);
    values.push(filter.startDate);
  }

  if (filter.endDate) {
    conditions.push(`created_at <= $${paramIdx++}`);
    values.push(filter.endDate);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // Count total
  const countResult = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM audit_log ${whereClause}`,
    values,
  );
  const total = parseInt(countResult.rows[0].count, 10);

  // Paginate
  const page = filter.page ?? 1;
  const limit = filter.limit ?? 50;
  const offset = (page - 1) * limit;

  const result = await query<{
    id: string;
    user_id: string | null;
    action: string;
    resource_type: string | null;
    resource_id: string | null;
    metadata: Record<string, unknown>;
    ip_address: string | null;
    user_agent: string | null;
    created_at: Date;
  }>(
    `SELECT id, user_id, action, resource_type, resource_id, metadata, ip_address, user_agent, created_at
     FROM audit_log ${whereClause}
     ORDER BY created_at DESC
     LIMIT $${paramIdx++} OFFSET $${paramIdx}`,
    [...values, limit, offset],
  );

  return {
    items: result.rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      action: row.action,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      metadata: row.metadata,
      ipAddress: row.ip_address,
      userAgent: row.user_agent,
      createdAt: row.created_at,
    })),
    total,
    page,
    limit,
  };
}
