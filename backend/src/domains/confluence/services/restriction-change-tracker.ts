import type { AuditRetention, ConfluenceClient } from './confluence-client.js';
import { logger } from '../../../core/utils/logger.js';

/** Default "confirm window": re-confirm every page's restrictions at least this often. */
const DEFAULT_CONFIRM_WINDOW_HOURS = 168; // 7 days

/**
 * Margin subtracted from the retention horizon so we never rely on audit records
 * sitting right at the purge boundary (which may vanish mid-query).
 */
export const RETENTION_SAFETY_MARGIN_MS = 3_600_000; // 1 hour

const HOUR_MS = 3_600_000;

/**
 * The outcome of asking "which pages' restrictions changed since we last looked?".
 *
 * - `full`: we could not establish a trustworthy audit window, so the caller must
 *   re-fetch restrictions for every page (today's behavior — always correct).
 * - `incremental`: the audit log covers `(windowStartMs, auditQueryAt]` with no
 *   gaps; only pages in `changedPageIds` (or those not synced within the window)
 *   need a re-fetch.
 */
export type RestrictionChangeSet =
  | { mode: 'full' }
  | { mode: 'incremental'; changedPageIds: Set<string>; windowStartMs: number; auditQueryAt: number };

type AuditCapableClient = Pick<ConfluenceClient, 'getAuditRecords' | 'getAuditRetention'>;

/**
 * Determine which pages had restriction changes since the confirm window opened,
 * using the Confluence Audit Log. Fails safe to `{ mode: 'full' }` on ANY
 * uncertainty (no audit access, retention probe failure, unknown retention units,
 * query error, or an unparseable permission event) — a page's ACEs are never
 * staler than they are today.
 */
export async function getRestrictionChangeSet(
  client: AuditCapableClient,
  nowMs: number,
  opts?: { confirmWindowHours?: number },
): Promise<RestrictionChangeSet> {
  const windowHours = opts?.confirmWindowHours ?? confirmWindowHoursFromEnv();
  const auditQueryAt = nowMs;
  const desiredStart = nowMs - windowHours * HOUR_MS;

  try {
    let retentionMs: number | null;
    try {
      retentionMs = retentionToMs(await client.getAuditRetention());
    } catch (err) {
      logFallback('audit retention probe failed', err);
      return { mode: 'full' };
    }
    if (retentionMs === null) {
      logFallback('audit retention units not understood', undefined);
      return { mode: 'full' };
    }

    // Never trust a window that reaches past what the audit log still retains.
    const safeRetentionStart = nowMs - retentionMs + RETENTION_SAFETY_MARGIN_MS;
    const windowStartMs = Math.max(desiredStart, safeRetentionStart);

    const records = await client.getAuditRecords({ startDate: windowStartMs });

    const changedPageIds = new Set<string>();
    for (const rec of records) {
      if (rec.category !== 'Permissions') continue;
      if (rec.affectedObject?.type !== 'page') continue;
      const id = rec.affectedObject.id;
      if (!id) {
        // A page-permission event we can't pin to an id — don't risk missing it.
        logFallback('audit Permissions event missing a page id', undefined);
        return { mode: 'full' };
      }
      changedPageIds.add(id);
    }

    return { mode: 'incremental', changedPageIds, windowStartMs, auditQueryAt };
  } catch (err) {
    logFallback('audit records query failed', err);
    return { mode: 'full' };
  }
}

function confirmWindowHoursFromEnv(): number {
  const raw = process.env.RESTRICTION_CONFIRM_WINDOW_HOURS;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CONFIRM_WINDOW_HOURS;
}

/** Convert a Confluence audit retention period into milliseconds; null if not understood. */
function retentionToMs(retention: AuditRetention): number | null {
  const n = retention.number;
  if (!Number.isFinite(n) || n <= 0) return null;
  switch (String(retention.units).toUpperCase()) {
    case 'MINUTES': return n * 60_000;
    case 'HOURS': return n * HOUR_MS;
    case 'DAYS': return n * 24 * HOUR_MS;
    case 'WEEKS': return n * 7 * 24 * HOUR_MS;
    case 'MONTHS': return n * 30 * 24 * HOUR_MS;
    case 'YEARS': return n * 365 * 24 * HOUR_MS;
    default: return null;
  }
}

function logFallback(reason: string, err: unknown): void {
  logger.warn(
    { reason, error: err instanceof Error ? err.message : err ? String(err) : undefined },
    'Restriction change-detection falling back to full restriction sync',
  );
}
