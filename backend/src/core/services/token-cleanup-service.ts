/**
 * Background token cleanup worker.
 *
 * Periodically deletes expired rows from the `refresh_tokens` table.
 * Modeled after sync-service.ts / quality-worker.ts: setInterval scheduling,
 * in-memory idempotency guard, in-memory lock, configurable interval via env var.
 */

import { cleanupExpiredTokens } from '../plugins/auth.js';
import { logger } from '../utils/logger.js';

// ─── State ────────────────────────────────────────────────────────────────────

let cleanupIntervalHandle: ReturnType<typeof setInterval> | null = null;
let cleanupLock = false;

// ─── Worker ───────────────────────────────────────────────────────────────────

/**
 * Start the background token cleanup worker.
 *
 * Reads TOKEN_CLEANUP_INTERVAL_HOURS from the environment (default: 24).
 * Invalid or non-positive values fall back to 24 with a warning.
 * Idempotent — calling it a second time while the worker is already running
 * is a no-op.
 */
export function startTokenCleanupWorker(): void {
  if (cleanupIntervalHandle) return;

  const parsed = Number(process.env.TOKEN_CLEANUP_INTERVAL_HOURS ?? '24');
  const intervalHours = Number.isFinite(parsed) && parsed > 0 ? parsed : 24;

  if (!(Number.isFinite(parsed) && parsed > 0)) {
    logger.warn(
      { TOKEN_CLEANUP_INTERVAL_HOURS: process.env.TOKEN_CLEANUP_INTERVAL_HOURS },
      'TOKEN_CLEANUP_INTERVAL_HOURS is invalid; falling back to 24h',
    );
  }

  cleanupIntervalHandle = setInterval(async () => {
    if (cleanupLock) return;
    cleanupLock = true;

    try {
      const deleted = await cleanupExpiredTokens();
      logger.info({ deleted }, 'Token cleanup complete');
    } catch (err) {
      logger.error({ err }, 'Token cleanup worker error');
    } finally {
      cleanupLock = false;
    }
  }, intervalHours * 60 * 60 * 1000);

  logger.info({ intervalHours }, 'Token cleanup worker started');
}

/**
 * Stop the background token cleanup worker.
 *
 * Clears the interval, nullifies the handle (so the worker can be restarted),
 * and resets the in-memory lock to prevent a permanently-stuck lock if stop
 * races a mid-run callback.
 */
export function stopTokenCleanupWorker(): void {
  if (cleanupIntervalHandle) {
    clearInterval(cleanupIntervalHandle);
    cleanupIntervalHandle = null;
  }
  cleanupLock = false;
  logger.info('Token cleanup worker stopped');
}
