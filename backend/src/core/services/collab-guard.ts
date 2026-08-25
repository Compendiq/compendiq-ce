/**
 * Competing-writer guard (#1444/#1445). 409s when `collab:active:{pageId}` is
 * non-empty. Wired on PUT, restore, Apply, and draft-publish.
 */
import { query } from '../db/postgres.js';
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

export async function assertNoLiveCollabRoom(pageId: number): Promise<void> {
  const redis = readRedisClient();
  if (!redis) return;
  try {
    const n = await redis.sCard(`collab:active:${pageId}`);
    if (n > 0) {
      throw new CollabSessionActiveError();
    }
  } catch (err) {
    if (err instanceof CollabSessionActiveError) throw err;
    // Redis blip: do not 409 a writer on an unread SET.
  }
}

/** Decision B: leftover BYTEA must not outlive a non-collab body_html write. */
export async function invalidateCollabDocAfterBodyWrite(pageId: number): Promise<void> {
  await query('DELETE FROM page_collaborative_docs WHERE page_id = $1', [pageId]);
}
