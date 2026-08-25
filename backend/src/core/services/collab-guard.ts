/**
 * Competing-writer guard (#1444/#1445). 409s when `collab:active:{pageId}` is
 * non-empty. Wired on PUT, restore, Apply, and draft-publish.
 */
import type { PoolClient } from 'pg';
import { getPool } from '../db/postgres.js';
import { COLLAB_INIT_LOCK_KEY } from '../db/advisory-locks.js';
import * as redisCache from './redis-cache.js';
import type { RedisClientType } from 'redis';

export class CollabSessionActiveError extends Error {
  readonly statusCode = 409;
  readonly code = 'collab_session_active';

  constructor() {
    super('Collaborative editing session is active');
    this.name = 'CollabSessionActiveError';
  }
}

export async function rejectIfLiveCollabRoom(
  pageId: number,
  conflict: (message: string) => Error,
  message?: string,
): Promise<void> {
  try {
    await assertNoLiveCollabRoom(pageId);
  } catch (err) {
    if (err instanceof CollabSessionActiveError) {
      throw Object.assign(conflict(message ?? err.message), { code: err.code });
    }
    throw err;
  }
}

function readRedisClient(): RedisClientType | null {
  try {
    const fn = (redisCache as { getRedisClient?: () => RedisClientType | null }).getRedisClient;
    if (typeof fn !== 'function') return null;
    const client = fn();
    if (!client || typeof client.sCard !== 'function') return null;
    return client;
  } catch {
    // Unit tests mock redis-cache without getRedisClient; vitest throws on the missing export.
    return null;
  }
}

export async function isLiveCollabRoom(pageId: number): Promise<boolean> {
  const redis = readRedisClient();
  if (!redis) return false;
  try {
    return Number(await redis.sCard(`collab:active:${pageId}`)) > 0;
  } catch {
    // Redis blip: fail open (treat as empty) so inbound sync does not skip forever.
    return false;
  }
}

export async function assertNoLiveCollabRoom(pageId: number): Promise<void> {
  if (await isLiveCollabRoom(pageId)) {
    throw new CollabSessionActiveError();
  }
}

/** Decision B: leftover BYTEA must not outlive a non-collab body_html write. */
export async function invalidateCollabDocAfterBodyWrite(
  pageId: number,
  client?: PoolClient,
): Promise<void> {
  if (client) {
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [COLLAB_INIT_LOCK_KEY, pageId]);
    await client.query('DELETE FROM page_collaborative_docs WHERE page_id = $1', [pageId]);
    return;
  }
  const owned = await getPool().connect();
  try {
    await owned.query('BEGIN');
    await owned.query('SELECT pg_advisory_xact_lock($1, $2)', [COLLAB_INIT_LOCK_KEY, pageId]);
    await owned.query('DELETE FROM page_collaborative_docs WHERE page_id = $1', [pageId]);
    await owned.query('COMMIT');
  } catch (err) {
    try { await owned.query('ROLLBACK'); } catch { /* */ }
    throw err;
  } finally {
    owned.release();
  }
}
