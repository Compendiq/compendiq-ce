import { query } from '../db/postgres.js';
import { logger } from '../utils/logger.js';

export interface ErrorContext {
  userId?: string;
  requestPath?: string;
  correlationId?: string;
  [key: string]: unknown;
}

export interface ErrorLogEntry {
  id: string;
  errorType: string;
  message: string;
  stack: string | null;
  context: Record<string, unknown>;
  userId: string | null;
  requestPath: string | null;
  correlationId: string | null;
  resolved: boolean;
  createdAt: string;
}

export interface ErrorSummary {
  errorType: string;
  count: number;
  lastOccurrence: string;
}

export interface ErrorSummaryResponse {
  last24h: ErrorSummary[];
  last7d: ErrorSummary[];
  last30d: ErrorSummary[];
  unresolvedCount: number;
}

/**
 * Track an error in the database error_log table.
 * This is designed to never throw -- logging failures are swallowed
 * to avoid cascading errors in the error handler itself.
 */
export async function trackError(
  error: Error | string,
  context: ErrorContext = {},
): Promise<void> {
  try {
    const errorObj = typeof error === 'string' ? new Error(error) : error;
    const errorType = errorObj.name || 'Error';
    const message = errorObj.message || String(error);
    const stack = errorObj.stack ?? null;

    const { userId, requestPath, correlationId, ...extra } = context;

    await query(
      `INSERT INTO error_log (error_type, message, stack, context, user_id, request_path, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        errorType,
        message,
        stack,
        JSON.stringify(extra),
        userId ?? null,
        requestPath ?? null,
        correlationId ?? null,
      ],
    );
  } catch (err) {
    // Never throw from error tracker -- just log to console as last resort
    logger.error({ err, originalError: error }, 'Failed to track error in database');
  }
}

/**
 * List errors with pagination and optional filtering.
 */
export async function listErrors(options: {
  page?: number;
  limit?: number;
  errorType?: string;
  resolved?: boolean;
}): Promise<{ items: ErrorLogEntry[]; total: number; page: number; limit: number }> {
  const { page = 1, limit = 50, errorType, resolved } = options;
  const offset = (page - 1) * limit;

  let whereClauses = '';
  const values: unknown[] = [];
  let paramIdx = 1;

  if (errorType !== undefined) {
    whereClauses += `${whereClauses ? ' AND' : ' WHERE'} error_type = $${paramIdx++}`;
    values.push(errorType);
  }

  if (resolved !== undefined) {
    whereClauses += `${whereClauses ? ' AND' : ' WHERE'} resolved = $${paramIdx++}`;
    values.push(resolved);
  }

  const countResult = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM error_log${whereClauses}`,
    values,
  );
  const countRow = countResult.rows[0];
  if (!countRow) throw new Error('Expected a row from COUNT query');
  const total = parseInt(countRow.count, 10);

  const dataValues = [...values, limit, offset];
  const result = await query<{
    id: string;
    error_type: string;
    message: string;
    stack: string | null;
    context: Record<string, unknown>;
    user_id: string | null;
    request_path: string | null;
    correlation_id: string | null;
    resolved: boolean;
    created_at: Date;
  }>(
    `SELECT id, error_type, message, stack, context, user_id, request_path,
            correlation_id, resolved, created_at
     FROM error_log${whereClauses}
     ORDER BY created_at DESC
     LIMIT $${paramIdx++} OFFSET $${paramIdx}`,
    dataValues,
  );

  return {
    items: result.rows.map((row) => ({
      id: row.id,
      errorType: row.error_type,
      message: row.message,
      stack: row.stack,
      context: row.context,
      userId: row.user_id,
      requestPath: row.request_path,
      correlationId: row.correlation_id,
      resolved: row.resolved,
      createdAt: row.created_at.toISOString(),
    })),
    total,
    page,
    limit,
  };
}

/**
 * Mark an error as resolved.
 */
export async function resolveError(errorId: string): Promise<boolean> {
  const result = await query(
    'UPDATE error_log SET resolved = TRUE WHERE id = $1',
    [errorId],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Get error summary grouped by type for different time windows.
 */
export async function getErrorSummary(): Promise<ErrorSummaryResponse> {
  const summaryQuery = (interval: string) =>
    query<{ error_type: string; count: string; last_occurrence: Date }>(
      `SELECT error_type, COUNT(*) as count, MAX(created_at) as last_occurrence
       FROM error_log
       WHERE created_at > NOW() - $1::interval
       GROUP BY error_type
       ORDER BY count DESC`,
      [interval],
    );

  const [last24h, last7d, last30d, unresolvedResult] = await Promise.all([
    summaryQuery('24 hours'),
    summaryQuery('7 days'),
    summaryQuery('30 days'),
    query<{ count: string }>(
      'SELECT COUNT(*) as count FROM error_log WHERE resolved = FALSE',
    ),
  ]);

  const mapSummary = (rows: { error_type: string; count: string; last_occurrence: Date }[]) =>
    rows.map((r) => ({
      errorType: r.error_type,
      count: parseInt(r.count, 10),
      lastOccurrence: r.last_occurrence.toISOString(),
    }));

  const unresolvedRow = unresolvedResult.rows[0];
  if (!unresolvedRow) throw new Error('Expected a row from COUNT query');

  return {
    last24h: mapSummary(last24h.rows),
    last7d: mapSummary(last7d.rows),
    last30d: mapSummary(last30d.rows),
    unresolvedCount: parseInt(unresolvedRow.count, 10),
  };
}
