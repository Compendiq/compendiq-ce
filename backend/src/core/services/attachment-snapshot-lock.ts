import type { PoolClient } from 'pg';
import { ATTACHMENT_SNAPSHOT_LOCK_ID } from '../db/advisory-locks.js';
import { getPool } from '../db/postgres.js';

/**
 * Hold the shared side of the backup snapshot barrier around one authoritative
 * attachment mutation. The callback receives the lock-owning client so
 * file-adjacent SQL cannot escape onto a different pool session.
 *
 * Callers that already own the shared lock may pass that client through. This
 * keeps nested filesystem helpers on the same session instead of acquiring a
 * second shared lock and consuming another pool connection.
 */
export async function withLocalAttachmentMutationLock<T>(
  operation: (client: PoolClient) => Promise<T>,
  lockOwningClient?: PoolClient,
): Promise<T> {
  if (lockOwningClient) return operation(lockOwningClient);
  const client = await getPool().connect();
  let lockAcquired = false;
  let discardClient: Error | undefined;

  try {
    await client.query('SET statement_timeout = 0');
    await client.query('SELECT pg_advisory_lock_shared($1)', [ATTACHMENT_SNAPSHOT_LOCK_ID]);
    lockAcquired = true;
    return await operation(client);
  } finally {
    try {
      if (lockAcquired) {
        await client.query('SELECT pg_advisory_unlock_shared($1)', [ATTACHMENT_SNAPSHOT_LOCK_ID]);
      }
    } catch (error) {
      discardClient = error instanceof Error ? error : new Error(String(error));
      throw error;
    } finally {
      try {
        await client.query('RESET statement_timeout');
      } catch (error) {
        discardClient ??= error instanceof Error ? error : new Error(String(error));
        throw error;
      } finally {
        client.release(discardClient);
      }
    }
  }
}
