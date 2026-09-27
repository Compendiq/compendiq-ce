import type { PoolClient } from 'pg';
import { PAGE_WRITE_INVALIDATION_LOCK_ID } from '../db/advisory-locks.js';
import { getPool } from '../db/postgres.js';
import { logger } from '../utils/logger.js';
import { resolveShutdownTimeoutMs } from '../utils/graceful-shutdown.js';
import { getRedisClient, invalidateCacheNamespaces } from './redis-cache.js';

const DEFAULT_BATCH_SIZE = 25;
const PUBLICATION_TIMEOUT_MS = resolveShutdownTimeoutMs();
const TERMINAL_PUBLICATION_STATUSES = [
  'completed',
  'reconciled_applied',
  'reconciled_not_applied',
] as const;

/**
 * Record cache delivery in the same transaction as the authored page state.
 * The intent is still pending until its caller settles that transaction, so
 * an absent row means the caller supplied the wrong publication identity.
 */
export async function enqueuePageWriteInvalidation(
  client: PoolClient,
  intentId: string,
): Promise<void> {
  const marked = await client.query(
    `UPDATE page_write_intents
        SET cache_invalidation_pending = TRUE
      WHERE id = $1
        AND status = 'pending'
    RETURNING id`,
    [intentId],
  );
  if (marked.rowCount !== 1) {
    throw new Error(`Pending page write intent ${intentId} is unavailable for cache invalidation`);
  }
}

/**
 * Publication owns one abortable SQL transaction. Abandoning a queued pool
 * checkout can only release its eventual lease, never start a late query.
 * An active lease is closed on abort; without COMMIT, its mutations roll back.
 */
export async function withPagePublicationTransaction<T>(
  action: (client: PoolClient) => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  const checkout = getPool().connect();
  const client = await new Promise<PoolClient>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    void checkout.then(
      (acquired) => {
        signal.removeEventListener('abort', onAbort);
        if (signal.aborted) {
          acquired.release();
          reject(signal.reason);
        } else {
          resolve(acquired);
        }
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });

  let destroyed = false;
  let finishClose!: () => void;
  const closed = new Promise<void>((resolve) => { finishClose = resolve; });
  client.once('end', finishClose);
  const onAbort = () => {
    if (destroyed) return;
    destroyed = true;
    client.release(true);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    signal.throwIfAborted();
    await client.query('BEGIN');
    signal.throwIfAborted();
    const result = await action(client);
    signal.throwIfAborted();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    if (!signal.aborted) await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
    if (destroyed) {
      await closed;
    } else {
      client.removeListener('end', finishClose);
      client.release();
    }
  }
}


/**
 * Publish committed read-model changes, including SQL-only writers and deletes.
 * The per-page queue coalesces autosaves; intent flags also preserve publication
 * after terminal external effects. Both clear only after real Redis delivery.
 */
export async function flushPageWriteInvalidations(
  intentId?: string,
  signal: AbortSignal = AbortSignal.timeout(PUBLICATION_TIMEOUT_MS),
): Promise<void> {
  try {
    await withPagePublicationTransaction(async (client) => {
      // A queued page write waits behind this delivery, then leaves its own
      // queue row. It cannot commit into the interval after Redis invalidation
      // and disappear with the preceding publication's queue entry.
      await client.query('SELECT pg_advisory_xact_lock($1)', [PAGE_WRITE_INVALIDATION_LOCK_ID]);
      const selected = await client.query<{ id: string }>(
        `SELECT id
           FROM page_write_intents
          WHERE cache_invalidation_pending = TRUE
            AND status IN ('completed', 'reconciled_applied', 'reconciled_not_applied')
            AND ($1::uuid IS NULL OR id = $1::uuid)
          ORDER BY settled_at, id
          FOR UPDATE
          LIMIT $2`,
        [intentId ?? null, DEFAULT_BATCH_SIZE],
      );
      const queued = await client.query<{ page_id: number }>(
        `SELECT q.page_id
           FROM page_cache_invalidation_queue q
          WHERE $1::uuid IS NULL OR EXISTS (
            SELECT 1 FROM page_write_intents i
             WHERE i.id = $1::uuid AND q.page_id = ANY(i.page_ids)
          )
          ORDER BY q.queued_at, q.page_id
          FOR UPDATE OF q
          LIMIT $2`,
        [intentId ?? null, DEFAULT_BATCH_SIZE],
      );
      if (selected.rows.length === 0 && queued.rows.length === 0) return;

      const redis = getRedisClient();
      if (!redis) throw new Error('Redis unavailable for page write cache invalidation');
      await invalidateCacheNamespaces(redis, ['pages', 'search'], signal);
      signal.throwIfAborted();
      const delivered = await client.query(
        `UPDATE page_write_intents
            SET cache_invalidation_pending = FALSE
          WHERE id = ANY($1::uuid[])
            AND cache_invalidation_pending = TRUE
            AND status = ANY($2::text[])`,
        [selected.rows.map((row) => row.id), TERMINAL_PUBLICATION_STATUSES],
      );
      if (delivered.rowCount !== selected.rows.length) {
        throw new Error('Page write cache invalidation settlement changed concurrently');
      }
      await client.query(
        'DELETE FROM page_cache_invalidation_queue WHERE page_id = ANY($1::integer[])',
        [queued.rows.map((row) => row.page_id)],
      );
    }, signal);
  } catch (err) {
    logger.warn({ err, intentId }, 'page write cache invalidation deferred');
    throw err;
  }
}
