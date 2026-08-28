import { createHash } from 'node:crypto';
import { NOTION_IMPORT_LOCK_KEY } from '../../../core/db/advisory-locks.js';
import { getPool } from '../../../core/db/postgres.js';

export function notionImportLockId(notionPageId: string): number {
  return createHash('sha256')
    .update(notionPageId.replaceAll('-', '').toLowerCase())
    .digest()
    .readInt32BE(0);
}

export async function withNotionImportLock<T>(
  notionPageId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const lockId = notionImportLockId(notionPageId);
  const client = await getPool().connect();
  let lockAcquired = false;
  let discardClient: Error | undefined;

  try {
    await client.query('SET statement_timeout = 0; SET lock_timeout = 0');
    await client.query('SELECT pg_advisory_lock($1, $2)', [
      NOTION_IMPORT_LOCK_KEY,
      lockId,
    ]);
    lockAcquired = true;
    return await operation();
  } finally {
    try {
      if (lockAcquired) {
        await client.query('SELECT pg_advisory_unlock($1, $2)', [
          NOTION_IMPORT_LOCK_KEY,
          lockId,
        ]);
      }
    } catch (error) {
      discardClient = error instanceof Error ? error : new Error(String(error));
      throw error;
    } finally {
      try {
        await client.query('RESET statement_timeout; RESET lock_timeout');
      } catch (error) {
        discardClient ??= error instanceof Error ? error : new Error(String(error));
        throw error;
      } finally {
        client.release(discardClient);
      }
    }
  }
}
