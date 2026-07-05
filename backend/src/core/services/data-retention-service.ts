/**
 * Data retention service.
 *
 * Cleans up append-only tables that grow unbounded:
 *   - audit_log       (time-based: default 365 days)
 *   - search_analytics (time-based: default 90 days)
 *   - error_log       (time-based: default 30 days)
 *   - page_versions   (count-based: keep last N per page, default 50)
 *   - audit_log rows where action='ADMIN_ACCESS_DENIED' (#264): targeted
 *       time-based purge with an admin-configurable window (default 90d).
 *       Narrower than the umbrella audit_log sweep; rows that survive the
 *       narrow sweep still fall under the umbrella 365d policy.
 *   - standalone pages in the trash (soft-deleted) for more than 30 days —
 *       the Trash UI promises "purged after 30 days"; Confluence-synced pages
 *       have their own purge in sync-service (upstream re-confirmation).
 *
 * Retention periods are configurable via environment variables:
 *   RETENTION_AUDIT_LOG_DAYS, RETENTION_SEARCH_ANALYTICS_DAYS,
 *   RETENTION_ERROR_LOG_DAYS, RETENTION_VERSIONS_MAX,
 *   RETENTION_ADMIN_ACCESS_DENIED_DAYS (env fallback for the admin-configurable
 *   `admin_access_denied_retention_days` setting — consulted only when the DB
 *   row is absent).
 */

import { getPool } from '../db/postgres.js';
import { logger } from '../utils/logger.js';
import { safeIntOr } from '../utils/safe-int.js';
import {
  getAdminAccessDeniedRetentionDays,
  getPendingSyncVersionsRetentionDays,
} from './admin-settings-service.js';
import { logAuditEvent } from './audit-service.js';

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
    // #828: safeIntOr (not bare parseInt) so a typo'd env value (e.g.
    // RETENTION_AUDIT_LOG_DAYS=foo) falls back to the documented default rather
    // than yielding NaN — a NaN bind makes the DELETE raise every cycle, which
    // silently disables the sweep and lets the table grow unbounded.
    const retentionDays = safeIntOr(process.env[envKey], days, 1);

    try {
      const { rowCount } = await pool.query(
        `DELETE FROM ${table} WHERE created_at < NOW() - INTERVAL '1 day' * $1`,
        [retentionDays],
      );
      results[table] = rowCount ?? 0;
      if (results[table] > 0) {
        logger.info({ table, deleted: results[table], retentionDays }, 'Retention cleanup completed');
      }
      // #307 P0d + review Finding #4: emit RETENTION_PRUNED for EVERY prune
      // cycle, including zero-row ones. Compliance report 6 (Data Retention
      // Attestation) reads this event; without a heartbeat the auditor
      // cannot distinguish "we ran retention in April, nothing matched"
      // from "retention didn't run in April". rows_pruned: 0 is a valid
      // attestation — it proves the cron ran.
      await logAuditEvent(
        null,
        'RETENTION_PRUNED',
        'table',
        table,
        { table, rows_pruned: results[table], retention_days: retentionDays },
      );
    } catch (err) {
      logger.error({ err, table }, 'Retention cleanup failed for table');
      results[table] = 0;
    }
  }

  // Targeted retention for ADMIN_ACCESS_DENIED audit rows (#264).
  // Runs after the umbrella `audit_log: 365 days` sweep above; rows that
  // survived the umbrella AND are older than the (narrower) admin-configured
  // window AND have action='ADMIN_ACCESS_DENIED' are purged here.
  // Scoped by action so the umbrella retention policy for every other audit
  // action remains independently tunable.
  results['audit_log_admin_access_denied'] = await runAdminAccessDeniedRetention();

  // Standalone trash purge (UX review): hard-delete standalone pages whose
  // soft-delete is older than the 30-day window the Trash UI promises.
  results['pages_standalone_trash'] = await purgeExpiredStandalonePages();

  // pending_sync_versions retention (Compendiq/compendiq-ee#118).
  // Drains the conflict-pending queue of rows that nobody resolved and are
  // older than the admin-configured window. Resolution deletes rows
  // synchronously, so this sweep only catches genuinely-abandoned
  // conflicts. The associated `pages.conflict_pending` flag is recomputed
  // after the delete so the conflicts list page no longer surfaces a row
  // whose pending versions have all been pruned.
  results['pending_sync_versions'] = await runPendingSyncVersionsRetention();

  // Count-based retention for page_versions
  // #828: safeIntOr guards against a non-numeric RETENTION_VERSIONS_MAX (NaN
  // would break the `WHERE rn > $1` bind and disable page_versions pruning).
  const maxVersions = safeIntOr(process.env.RETENTION_VERSIONS_MAX, 50, 1);
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
    // #307 Finding #4: always emit (heartbeat) — see umbrella loop above.
    await logAuditEvent(
      null,
      'RETENTION_PRUNED',
      'table',
      'page_versions',
      { table: 'page_versions', rows_pruned: results.page_versions, max_versions: maxVersions },
    );
  } catch (err) {
    logger.error({ err }, 'Page versions retention cleanup failed');
    results.page_versions = 0;
  }

  return results;
}

/**
 * Purge `audit_log` rows with `action = 'ADMIN_ACCESS_DENIED'` that are older
 * than the admin-configured retention window (days).
 *
 * Issue #264. Batched (LIMIT 10_000) to avoid long DELETE locks on large audit
 * tables — ~10 req/s of brute-forced admin attempts produces ~860k rows/day,
 * so an unbatched DELETE of months of data could hold the table for minutes.
 * Parameterised SQL only.
 *
 * Intentionally scoped to a single `action` — does NOT touch rows with other
 * action values, preserving whatever umbrella policy governs them (the
 * `audit_log: 365 days` entry in `RETENTION_DEFAULTS` continues to apply to
 * every audit action separately).
 *
 * Returns the total number of rows deleted across all batches. Never throws
 * (errors are logged and the promise resolves).
 */
const ADMIN_ACCESS_DENIED_PURGE_BATCH_SIZE = 10_000;

async function runAdminAccessDeniedRetention(): Promise<number> {
  let days: number;
  try {
    days = await getAdminAccessDeniedRetentionDays();
  } catch (err) {
    logger.error({ err }, 'Failed to resolve admin_access_denied_retention_days; skipping purge');
    return 0;
  }

  const pool = getPool();
  let totalDeleted = 0;

  try {
    for (;;) {
      const { rowCount } = await pool.query(
        `DELETE FROM audit_log
           WHERE id IN (
             SELECT id FROM audit_log
              WHERE action = 'ADMIN_ACCESS_DENIED'
                AND created_at < NOW() - INTERVAL '1 day' * $1
              LIMIT $2
           )`,
        [days, ADMIN_ACCESS_DENIED_PURGE_BATCH_SIZE],
      );
      const n = rowCount ?? 0;
      totalDeleted += n;
      if (n > 0) {
        logger.debug(
          { batch: n, totalSoFar: totalDeleted, retentionDays: days },
          'ADMIN_ACCESS_DENIED retention batch deleted',
        );
      }
      // A short batch signals drained — break out rather than loop again on
      // a guaranteed-empty DELETE.
      if (n < ADMIN_ACCESS_DENIED_PURGE_BATCH_SIZE) break;
    }
    if (totalDeleted > 0) {
      logger.info(
        { deleted: totalDeleted, retentionDays: days },
        'ADMIN_ACCESS_DENIED retention cleanup completed',
      );
    }
    // #307 Finding #4: always emit (heartbeat) — compliance needs proof the
    // targeted sweep ran, even in months where it purged nothing.
    await logAuditEvent(
      null,
      'RETENTION_PRUNED',
      'table',
      'audit_log_admin_access_denied',
      {
        table: 'audit_log',
        action_scope: 'ADMIN_ACCESS_DENIED',
        rows_pruned: totalDeleted,
        retention_days: days,
      },
    );
  } catch (err) {
    logger.error({ err, retentionDays: days }, 'ADMIN_ACCESS_DENIED retention cleanup failed');
  }
  return totalDeleted;
}

/**
 * Days a soft-deleted standalone page survives in the trash before the
 * maintenance job hard-deletes it. The Trash UI's `autoPurgeAt` field
 * (GET /api/pages/trash) is computed from the same constant so the promise
 * shown to the user and the actual purge can never drift apart.
 */
export const STANDALONE_TRASH_RETENTION_DAYS = 30;

/**
 * Rows per DELETE batch — same backstop as the ADMIN_ACCESS_DENIED purge:
 * keeps lock time and WAL volume bounded if a huge backlog ever accumulates
 * (e.g. the maintenance job was disabled for months).
 */
const STANDALONE_TRASH_PURGE_BATCH_SIZE = 10_000;

/**
 * Hard-delete standalone pages whose soft-delete (`pages.deleted_at`) is older
 * than the 30-day trash window (UX review: the Trash UI promised "purged after
 * 30 days" but nothing ever purged standalone pages — the only purge was
 * Confluence-sync-scoped in sync-service's `purgeDeletedPages`, which this
 * deliberately does NOT touch: it stays `source = 'standalone'`-scoped, so
 * Confluence rows keep their upstream re-confirmation flow).
 *
 * Dependent rows (pinned_pages, page_embeddings, page_versions, comments,
 * local_attachments, page_relationships, …) are removed via their
 * `ON DELETE CASCADE` FKs on pages(id) — same contract the Confluence purge
 * relies on (migrations 030/033/034/036/064/069).
 *
 * Returns the number of pages deleted this run. Never throws (errors are
 * logged and the promise resolves with the count so far).
 */
export async function purgeExpiredStandalonePages(): Promise<number> {
  const pool = getPool();
  let deleted = 0;

  try {
    for (;;) {
      const { rowCount } = await pool.query(
        // Explicit `deleted_at IS NOT NULL` guard instead of relying on SQL
        // NULL-comparison semantics to protect live pages — matches the
        // Confluence purge in sync-service.
        `DELETE FROM pages
          WHERE id IN (
            SELECT id FROM pages
             WHERE source = 'standalone'
               AND deleted_at IS NOT NULL
               AND deleted_at < NOW() - INTERVAL '1 day' * $1
             LIMIT $2
          )`,
        [STANDALONE_TRASH_RETENTION_DAYS, STANDALONE_TRASH_PURGE_BATCH_SIZE],
      );
      const n = rowCount ?? 0;
      deleted += n;
      // A short batch signals drained — break out rather than loop again on
      // a guaranteed-empty DELETE.
      if (n < STANDALONE_TRASH_PURGE_BATCH_SIZE) break;
    }
    if (deleted > 0) {
      logger.info(
        { deleted, retentionDays: STANDALONE_TRASH_RETENTION_DAYS },
        'Standalone trash purge completed',
      );
    }
    // Heartbeat audit row, including zero-row sweeps — see the umbrella loop
    // in runRetentionCleanup() for the compliance rationale (#307 Finding #4).
    await logAuditEvent(
      null,
      'RETENTION_PRUNED',
      'table',
      'pages_standalone_trash',
      {
        table: 'pages',
        source_scope: 'standalone',
        rows_pruned: deleted,
        retention_days: STANDALONE_TRASH_RETENTION_DAYS,
      },
    );
  } catch (err) {
    logger.error(
      { err, retentionDays: STANDALONE_TRASH_RETENTION_DAYS },
      'Standalone trash purge failed',
    );
  }

  return deleted;
}

/**
 * Prune `pending_sync_versions` rows older than the configured retention
 * window AND recompute `pages.conflict_pending` for any page whose queue
 * was just drained (Compendiq/compendiq-ee#118).
 *
 * The two-step "delete then recompute" approach mirrors how resolution
 * works at the EE service layer (delete the row, then `UPDATE pages SET
 * conflict_pending = EXISTS(...)`). We do it here too so an admin who
 * abandons a conflict doesn't see a stale `conflict_pending = TRUE` flag
 * on the conflicts list after the row was retention-pruned.
 *
 * Emits a single `RETENTION_PRUNED` audit row with the count, including
 * zero-row sweeps (compliance heartbeat — see Finding #4 in the umbrella
 * loop). Never throws.
 */
async function runPendingSyncVersionsRetention(): Promise<number> {
  let days: number;
  try {
    days = await getPendingSyncVersionsRetentionDays();
  } catch (err) {
    logger.error(
      { err },
      'Failed to resolve pending_sync_versions_retention_days; skipping prune',
    );
    return 0;
  }

  const pool = getPool();
  let deleted = 0;

  try {
    // Capture the affected page_ids in the same statement so the followup
    // recompute targets only the rows we actually changed (no full-table
    // scan of `pages`). The CTE delete + RETURNING keeps both halves in
    // one round-trip.
    //
    // #744: the outer SELECT must NOT use DISTINCT — for a CTE query,
    // `rowCount` reflects the outer SELECT's command tag, so a DISTINCT
    // would report the number of distinct PAGES as the deleted-row count
    // (wrong compliance attestation). Return every deleted row and dedupe
    // page ids in JS instead.
    const result = await pool.query<{ page_id: number }>(
      `WITH deleted AS (
         DELETE FROM pending_sync_versions
          WHERE detected_at < NOW() - INTERVAL '1 day' * $1
          RETURNING page_id
       )
       SELECT page_id FROM deleted`,
      [days],
    );

    deleted = result.rows.length;
    const affectedPageIds = [...new Set(result.rows.map((r) => r.page_id))];

    // Recompute `pages.conflict_pending` for any page whose queue was
    // just drained. We can't unconditionally set FALSE — a page may have
    // multiple pending versions and we may have only removed the oldest
    // one (rare but possible if conflicts pile up faster than the admin
    // resolves them).
    if (affectedPageIds.length > 0) {
      await pool.query(
        `UPDATE pages
            SET conflict_pending = EXISTS (
                  SELECT 1 FROM pending_sync_versions
                   WHERE pending_sync_versions.page_id = pages.id
                ),
                conflict_detected_at = CASE
                  WHEN EXISTS (
                    SELECT 1 FROM pending_sync_versions
                     WHERE pending_sync_versions.page_id = pages.id
                  ) THEN conflict_detected_at
                  ELSE NULL
                END
          WHERE id = ANY($1::int[])`,
        [affectedPageIds],
      );
    }

    if (deleted > 0) {
      logger.info(
        { deleted, retentionDays: days, pages: affectedPageIds.length },
        'pending_sync_versions retention cleanup completed',
      );
    }

    // Heartbeat audit row — see umbrella loop comments for rationale.
    await logAuditEvent(
      null,
      'RETENTION_PRUNED',
      'table',
      'pending_sync_versions',
      {
        table: 'pending_sync_versions',
        rows_pruned: deleted,
        retention_days: days,
      },
    );
  } catch (err) {
    logger.error(
      { err, retentionDays: days },
      'pending_sync_versions retention cleanup failed',
    );
  }

  return deleted;
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
