/**
 * Redis fan-out + live-room guard for the collab gateway (#1444).
 *
 * Real Redis via test-redis-helper.ts. Two isolated runtimes stand in for
 * two pods: a delayed second subscriber must still converge, and applying
 * with origin `'redis'` must not republish.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createClient, type RedisClientType } from 'redis';
import { isRedisAvailable } from '../../test-redis-helper.js';
import {
  createCollabRuntime,
  COLLAB_ACTIVE_TTL_SEC,
  type CollabRuntime,
} from './collab-room-service.js';
import { assertNoLiveCollabRoom } from './collab-guard.js';
import { COLLAB_INIT_LOCK_KEY } from '../db/advisory-locks.js';
import { setRedisClient } from './redis-cache.js';

const redisAvailable = await isRedisAvailable();

let main: RedisClientType | null = null;
let runtimeA: CollabRuntime | null = null;
let runtimeB: CollabRuntime | null = null;
const usedPageIds: number[] = [];

function nextPageId(): number {
  const id = 1_411_000 + Math.floor(Math.random() * 1_000_000);
  usedPageIds.push(id);
  return id;
}

async function cleanupKeys(): Promise<void> {
  if (!main) return;
  if (usedPageIds.length === 0) return;
  await main.del(usedPageIds.flatMap((id) => [`collab:active:${id}`, `collab:doc:${id}`]));
}

beforeAll(async () => {
  if (!redisAvailable) return;
  const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
  main = createClient({ url }) as RedisClientType;
  main.on('error', () => { /* assertions surface failures */ });
  await main.connect();
  setRedisClient(main);
}, 15_000);

afterAll(async () => {
  if (!redisAvailable) return;
  if (runtimeA) await runtimeA.close();
  if (runtimeB) await runtimeB.close();
  if (main) {
    await cleanupKeys();
    await main.quit();
  }
});

beforeEach(async () => {
  if (!redisAvailable || !main) return;
  if (runtimeA) await runtimeA.close();
  if (runtimeB) await runtimeB.close();
  await cleanupKeys();
  runtimeA = await createCollabRuntime(main, 'pod-a');
  runtimeB = await createCollabRuntime(main, 'pod-b');
});

describe.skipIf(!redisAvailable)('collab-room-service Redis fan-out (#1444)', () => {
  it('uses the two-key advisory lock constant 1_411_001', () => {
    expect(COLLAB_INIT_LOCK_KEY).toBe(1_411_001);
    expect(COLLAB_INIT_LOCK_KEY).not.toBe(891_001);
    expect(COLLAB_INIT_LOCK_KEY).not.toBe(745_001);
  });

  it('fans an incremental update to a delayed second subscriber via state_dump', async () => {
    const pageId = nextPageId();
    const roomA = await runtimeA!.getOrCreateRoom(pageId);
    roomA.doc.getText('t').insert(0, 'typed-before-b-joined');

    await new Promise((r) => setTimeout(r, 1_000));

    const roomB = await runtimeB!.getOrCreateRoom(pageId);
    await vi.waitFor(() => {
      expect(roomB.doc.getText('t').toString()).toContain('typed-before-b-joined');
    }, { timeout: 4_000 });
  });

  it('does not republish when origin === redis (no loop)', async () => {
    if (!main) throw new Error('unreachable');
    const pageId = nextPageId();
    const publishSpy = vi.spyOn(main, 'publish');

    const roomA = await runtimeA!.getOrCreateRoom(pageId);
    await runtimeB!.getOrCreateRoom(pageId);

    publishSpy.mockClear();
    roomA.doc.getText('t').insert(0, 'loop-probe');

    await vi.waitFor(() => {
      expect(runtimeB!.getRoom(pageId)?.doc.getText('t').toString()).toContain('loop-probe');
    }, { timeout: 4_000 });

    const syncFromB = publishSpy.mock.calls.filter(([channel, payload]) => {
      if (channel !== `collab:doc:${pageId}`) return false;
      try {
        const msg = JSON.parse(String(payload)) as { origin?: string; kind?: string };
        return msg.origin === runtimeB!.podId && msg.kind === 'sync';
      } catch {
        return false;
      }
    });
    expect(syncFromB).toHaveLength(0);
  });

  it('assertNoLiveCollabRoom 409s while a member is in collab:active', async () => {
    const pageId = nextPageId();
    await runtimeA!.getOrCreateRoom(pageId);

    await expect(assertNoLiveCollabRoom(pageId)).rejects.toMatchObject({
      statusCode: 409,
      code: 'collab_session_active',
    });

    const ttl = await main!.ttl(`collab:active:${pageId}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(COLLAB_ACTIVE_TTL_SEC);
  });
});
