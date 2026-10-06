/**
 * Competing-writer guard (#1444/#1445/#276). PostgreSQL runtime admissions
 * are authoritative; Redis membership is only a fast liveness signal.
 */
import type { PoolClient } from 'pg';
import { query } from '../db/postgres.js';
import { COLLAB_INIT_LOCK_KEY } from '../db/advisory-locks.js';
import * as redisCache from './redis-cache.js';
import type { RedisClientType } from 'redis';
import { withPageWriteTransaction } from './page-write-admission.js';

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
    const client = redisCache.getRedisClient();
    if (!client || typeof client.sCard !== 'function') return null;
    return client;
  } catch {
    // Unit tests mock redis-cache without getRedisClient; vitest throws on the missing export.
    return null;
  }
}

export async function isLiveCollabRoom(pageId: number): Promise<boolean> {
  const redis = readRedisClient();
  if (redis) {
    try {
      if (Number(await redis.sCard(`collab:active:${pageId}`)) > 0) return true;
    } catch {
      // PostgreSQL admissions are the authority; keep checking below.
    }
  }
  const active = await query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM page_runtime_admissions
        WHERE page_id = $1 AND released_at IS NULL
     ) AS present`,
    [pageId],
  );
  return active.rows[0]?.present === true;
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
  await withPageWriteTransaction([pageId], async (writeClient) => {
    await writeClient.query('SELECT pg_advisory_xact_lock($1, $2)', [COLLAB_INIT_LOCK_KEY, pageId]);
    await writeClient.query('DELETE FROM page_collaborative_docs WHERE page_id = $1', [pageId]);
  });
}
