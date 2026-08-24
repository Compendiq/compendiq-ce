/**
 * Competing-writer guard (#1444). 409s when `collab:active:{pageId}` is
 * non-empty. PUT / restore / Apply / draft-publish are wired in a later PR;
 * tests call this helper directly.
 */
import { getRedisClient } from './redis-cache.js';

export class CollabSessionActiveError extends Error {
  readonly statusCode = 409;
  readonly code = 'collab_session_active';

  constructor() {
    super('Collaborative editing session is active');
    this.name = 'CollabSessionActiveError';
  }
}

export async function assertNoLiveCollabRoom(pageId: number): Promise<void> {
  const redis = getRedisClient();
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
