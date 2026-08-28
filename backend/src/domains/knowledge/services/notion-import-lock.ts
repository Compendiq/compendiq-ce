import { createHash } from 'node:crypto';
import { NOTION_IMPORT_LOCK_KEY } from '../../../core/db/advisory-locks.js';
import { getPool } from '../../../core/db/postgres.js';

function normalizeNotionPageId(notionPageId: string): string {
  return notionPageId.replaceAll('-', '').toLowerCase();
}

export function notionImportLockId(notionPageId: string): number {
  return createHash('sha256')
    .update(normalizeNotionPageId(notionPageId))
    .digest()
    .readInt32BE(0);
}

interface NotionImportLock {
  normalizedPageId: string;
  lockId: number;
}

function orderedNotionImportLocks(notionPageIds: readonly string[]): NotionImportLock[] {
  const byNormalizedPageId = new Map<string, NotionImportLock>();
  for (const notionPageId of notionPageIds) {
    const normalizedPageId = normalizeNotionPageId(notionPageId);
    if (byNormalizedPageId.has(normalizedPageId)) continue;
    byNormalizedPageId.set(normalizedPageId, {
      normalizedPageId,
      lockId: notionImportLockId(normalizedPageId),
    });
  }
  return [...byNormalizedPageId.values()].sort((left, right) => {
    const keyOrder = left.lockId - right.lockId;
    if (keyOrder !== 0) return keyOrder;
    if (left.normalizedPageId === right.normalizedPageId) return 0;
    return left.normalizedPageId < right.normalizedPageId ? -1 : 1;
  });
}

export async function withNotionImportLocks<T>(
  notionPageIds: readonly string[],
  operation: () => Promise<T>,
): Promise<T> {
  const locks = orderedNotionImportLocks(notionPageIds);
  const client = await getPool().connect();
  const acquired: NotionImportLock[] = [];
  let discardClient: Error | undefined;
  let operationError: unknown;
  let cleanupError: unknown;
  let result: T | undefined;

  try {
    await client.query('SET statement_timeout = 0; SET lock_timeout = 0');
    for (const lock of locks) {
      await client.query('SELECT pg_advisory_lock($1, $2)', [
        NOTION_IMPORT_LOCK_KEY,
        lock.lockId,
      ]);
      acquired.push(lock);
    }
    result = await operation();
  } catch (error) {
    operationError = error;
  }

  for (const lock of acquired.reverse()) {
    try {
      await client.query('SELECT pg_advisory_unlock($1, $2)', [
        NOTION_IMPORT_LOCK_KEY,
        lock.lockId,
      ]);
    } catch (error) {
      cleanupError ??= error;
      discardClient ??= error instanceof Error ? error : new Error(String(error));
    }
  }
  try {
    await client.query('RESET statement_timeout; RESET lock_timeout');
  } catch (error) {
    cleanupError ??= error;
    discardClient ??= error instanceof Error ? error : new Error(String(error));
  }
  client.release(discardClient);

  if (operationError) throw operationError;
  if (cleanupError) throw cleanupError;
  return result as T;
}

export async function withNotionImportLock<T>(
  notionPageId: string,
  operation: () => Promise<T>,
): Promise<T> {
  return withNotionImportLocks([notionPageId], operation);
}
