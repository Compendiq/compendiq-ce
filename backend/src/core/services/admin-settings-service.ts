import { query } from '../db/postgres.js';

/**
 * Returns the embedding vector dimension used by the shared `page_embeddings`
 * column. Falls back to `EMBEDDING_DIMENSIONS` env (1024 default) when the
 * `embedding_dimensions` row is unset.
 *
 * LLM provider configuration previously lived in this file (getSharedLlmSettings,
 * upsertUsecaseLlmAssignments, etc.) but now lives in the `llm_providers` +
 * `llm_usecase_assignments` tables. See `domains/llm/services/llm-provider-resolver.ts`.
 */
export async function getEmbeddingDimensions(): Promise<number> {
  const r = await query<{ setting_value: string }>(
    `SELECT setting_value FROM admin_settings WHERE setting_key='embedding_dimensions'`,
  );
  const v = r.rows[0]?.setting_value;
  if (v) {
    const n = parseInt(v, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return parseInt(process.env.EMBEDDING_DIMENSIONS ?? '1024', 10);
}

/**
 * Issue #257 — returns the configured re-embed-all job history retention
 * (how many completed/failed BullMQ job records are kept in Redis before
 * the oldest get swept). Default 150, clamped to [10, 10000].
 *
 * Read per-enqueue inside `enqueueReembedAll` so runtime changes take
 * effect on the next run. Also consumed by the admin GET/PUT
 * `/api/admin/settings` surface.
 */
export async function getReembedHistoryRetention(): Promise<number> {
  const r = await query<{ setting_value: string }>(
    `SELECT setting_value FROM admin_settings WHERE setting_key='reembed_history_retention'`,
  );
  const raw = r.rows[0]?.setting_value;
  const n = raw ? parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n)) return 150;
  return Math.max(10, Math.min(10_000, n));
}

/**
 * Issue #264 — returns the configured retention window (days) for
 * `audit_log` rows with action='ADMIN_ACCESS_DENIED'. Consumed by the
 * targeted purge in `data-retention-service.ts ::
 * runAdminAccessDeniedRetention`. Also consumed by the admin GET/PUT
 * `/api/admin/settings` surface.
 *
 * Read cascade:
 *   admin_settings.admin_access_denied_retention_days  (authoritative)
 *     -> env RETENTION_ADMIN_ACCESS_DENIED_DAYS        (optional fallback)
 *     -> 90                                            (hard default)
 *
 * Clamped to [7, 3650]. No caching — the retention scheduler runs once
 * per 24 h, so a per-tick DB read is negligible and keeps the code
 * simple (no cache invalidation on PUT).
 */
export async function getAdminAccessDeniedRetentionDays(): Promise<number> {
  try {
    const r = await query<{ setting_value: string }>(
      `SELECT setting_value FROM admin_settings WHERE setting_key='admin_access_denied_retention_days'`,
    );
    const raw = r.rows[0]?.setting_value;
    if (raw) {
      const n = parseInt(raw, 10);
      if (Number.isFinite(n) && n >= 7 && n <= 3650) return n;
    }
  } catch {
    // Fall through to env / default — this getter must never throw.
  }
  const env = process.env.RETENTION_ADMIN_ACCESS_DENIED_DAYS;
  if (env) {
    const n = parseInt(env, 10);
    if (Number.isFinite(n) && n >= 7 && n <= 3650) return n;
  }
  return 90;
}

/**
 * Compendiq/compendiq-ee#118 — returns the configured retention window
 * (days) for `pending_sync_versions` rows. Stale conflict-pending versions
 * older than this are pruned by `data-retention-service.ts`.
 *
 * Read cascade:
 *   admin_settings.pending_sync_versions_retention_days  (authoritative)
 *     -> env RETENTION_PENDING_SYNC_VERSIONS_DAYS        (optional fallback)
 *     -> 90                                              (hard default)
 *
 * Clamped to [7, 3650]. No caching — the retention scheduler runs once per
 * 24 h, so the per-tick DB read is negligible (matches the pattern used by
 * `getAdminAccessDeniedRetentionDays`). Resolution deletes the pending row
 * synchronously, so the retention sweep only catches genuinely-abandoned
 * conflict queues.
 */
export async function getPendingSyncVersionsRetentionDays(): Promise<number> {
  try {
    const r = await query<{ setting_value: string }>(
      `SELECT setting_value FROM admin_settings WHERE setting_key='pending_sync_versions_retention_days'`,
    );
    const raw = r.rows[0]?.setting_value;
    if (raw) {
      const n = parseInt(raw, 10);
      if (Number.isFinite(n) && n >= 7 && n <= 3650) return n;
    }
  } catch {
    // Fall through to env / default — this getter must never throw.
  }
  const env = process.env.RETENTION_PENDING_SYNC_VERSIONS_DAYS;
  if (env) {
    const n = parseInt(env, 10);
    if (Number.isFinite(n) && n >= 7 && n <= 3650) return n;
  }
  return 90;
}
