/**
 * Data retention service.
 *
 * Cleans up append-only tables that grow unbounded:
 *   - audit_log       (time-based: default 365 days)
 *   - search_analytics (time-based: default 90 days)
 *   - error_log       (time-based: default 30 days)
 *   - page_versions   (count-based: keep last N per page, default 50)
 *
 * Retention periods are configurable via environment variables:
 *   RETENTION_AUDIT_LOG_DAYS, RETENTION_SEARCH_ANALYTICS_DAYS,
 *   RETENTION_ERROR_LOG_DAYS, RETENTION_VERSIONS_MAX
 */

import { getPool } from '../db/postgres.js';
import { logger } from '../utils/logger.js';

export const RETENTION_DEFAULTS: Record<string, number> = {
  audit_log: 365,          // days
  search_analytics: 90,    // days
  error_log: 30,           // days
  page_versions: 50,       // keep last N per page
};

/**
 * Run retention cleanup across all configured tables.
 * Returns a map of table name to number of deleted rows.
 */
export async function runRetentionCleanup(): Promise<Record<string, number>> {
  const pool = getPool();
  const results: Record<string, number> = {};

  // Time-based retention for audit_log, search_analytics, error_log
  for (const [table, days] of Object.entries(RETENTION_DEFAULTS)) {
    if (table === 'page_versions') continue;

    const envKey = `RETENTION_${table.toUpperCase()}_DAYS`;
    const retentionDays = parseInt(process.env[envKey] ?? String(days), 10);

    try {
      const { rowCount } = await pool.query(
        `DELETE FROM ${table} WHERE created_at < NOW() - INTERVAL '1 day' * $1`,
        [retentionDays],
      );
      results[table] = rowCount ?? 0;
      if (results[table] > 0) {
        logger.info({ table, deleted: results[table], retentionDays }, 'Retention cleanup completed');
      }
    } catch (err) {
      logger.error({ err, table }, 'Retention cleanup failed for table');
      results[table] = 0;
    }
  }

  // Count-based retention for page_versions
  const maxVersions = parseInt(process.env.RETENTION_VERSIONS_MAX ?? '50', 10);
  try {
    const { rowCount } = await pool.query(`
      DELETE FROM page_versions WHERE id IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (PARTITION BY page_id ORDER BY version_number DESC) AS rn
          FROM page_versions
        ) ranked WHERE rn > $1
      )
    `, [maxVersions]);
    results.page_versions = rowCount ?? 0;
    if (results.page_versions > 0) {
      logger.info({ deleted: results.page_versions, maxVersions }, 'Page versions retention cleanup completed');
    }
  } catch (err) {
    logger.error({ err }, 'Page versions retention cleanup failed');
    results.page_versions = 0;
  }

  return results;
}

// ── Scheduler ────────────────────────────────────────────────────────────────

let retentionIntervalHandle: ReturnType<typeof setInterval> | null = null;

/**
 * Start the daily retention cleanup scheduler.
 * Default interval: 24 hours.
 */
export function startRetentionWorker(intervalHours = 24): void {
  if (retentionIntervalHandle) return;

  const intervalMs = intervalHours * 60 * 60 * 1000;

  retentionIntervalHandle = setInterval(async () => {
    try {
      const results = await runRetentionCleanup();
      const totalDeleted = Object.values(results).reduce((a, b) => a + b, 0);
      if (totalDeleted > 0) {
        logger.info({ results }, 'Scheduled retention cleanup completed');
      }
    } catch (err) {
      logger.error({ err }, 'Scheduled retention cleanup error');
    }
  }, intervalMs);

  logger.info({ intervalHours }, 'Data retention worker started');
}

/**
 * Stop the retention cleanup scheduler.
 */
export function stopRetentionWorker(): void {
  if (retentionIntervalHandle) {
    clearInterval(retentionIntervalHandle);
    retentionIntervalHandle = null;
    logger.info('Data retention worker stopped');
  }
}
