/**
 * Runtime DDL under a bounded lock wait, in one place (#1115).
 *
 * Hoisted out of `shadow-migration-service.ts`, which is where the discipline
 * was worked out, because #1115's image index needs exactly the same one and a
 * second copy would be a second place for it to drift. Both callers rebuild a
 * pgvector column and its HNSW index while the app is serving.
 *
 * Three things in here are load-bearing and each was a bug first:
 *
 *  - **`SET LOCAL lock_timeout`.** No pool sets one (only `runMigrations`, to
 *    0), so without this a `LOCK TABLE` or an `ALTER` queues indefinitely
 *    behind a long-running reader *while blocking every new one* — the classic
 *    lock-queue pile-up.
 *  - **`SET LOCAL statement_timeout = 0`.** A deployment that sets
 *    `PG_STATEMENT_TIMEOUT` applies it to every pooled connection, and these
 *    transactions run genuinely long statements. 57014 is neither a lock code
 *    nor retried, so it aborted the transaction and propagated, which stranded
 *    the shadow migration in `swapped` with no way out of the UI. `SET LOCAL`,
 *    so it lasts exactly this transaction; the `lock_timeout` above still
 *    bounds the wait that could hurt others.
 *  - **Retrying 55P03 AND 40P01.** The first is our own `lock_timeout` firing;
 *    the second is a genuine deadlock against a concurrent statement touching
 *    the same tables. Both are transient. Anything else propagates unchanged.
 */
import { getPool } from './postgres.js';
import { logger } from '../utils/logger.js';

/** `lock_not_available` — our `SET LOCAL lock_timeout` fired. */
const LOCK_NOT_AVAILABLE = '55P03';
/** `deadlock_detected` — a concurrent statement holds a conflicting lock. */
const DEADLOCK_DETECTED = '40P01';

/** The narrow client surface a locked DDL transaction needs. */
export interface LockedDdlClient {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface WithLockRetryOptions {
  lockTimeoutMs: number;
  maxAttempts: number;
  /**
   * Named in the exhaustion error, so an operator reading a toast knows which
   * operation gave up — "the shadow swap" and "the image index rebuild" reach
   * very different runbook sections.
   */
  operation: string;
}

export async function withLockRetry(
  opts: WithLockRetryOptions,
  fn: (client: LockedDdlClient) => Promise<void>,
): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL lock_timeout = '${Number(opts.lockTimeoutMs)}ms'`);
      await client.query('SET LOCAL statement_timeout = 0');
      await fn(client as unknown as LockedDdlClient);
      await client.query('COMMIT');
      return;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      lastErr = err;
      const code = (err as { code?: string }).code;
      if (code !== LOCK_NOT_AVAILABLE && code !== DEADLOCK_DETECTED) throw err;
      logger.warn(
        { attempt, maxAttempts: opts.maxAttempts, code, operation: opts.operation },
        'DDL lock wait failed — retrying',
      );
      await new Promise((r) => setTimeout(r, 200 * attempt));
    } finally {
      client.release();
    }
  }
  throw new Error(
    `Could not acquire the table lock for ${opts.operation} after ${opts.maxAttempts} attempts (lock_timeout ${opts.lockTimeoutMs}ms) — retry when long-running queries have drained: ${String((lastErr as Error)?.message ?? lastErr)}`,
  );
}
