/**
 * Unit tests for presence-service (issue #301).
 *
 * Uses a real Redis connection. Skips automatically when REDIS_URL is
 * unreachable so CI doesn't spuriously fail on workstations without Redis.
 *
 * We deliberately keep `ACTIVE_WINDOW_SEC` waits short by manipulating the
 * stored heartbeat score (via ZADD) rather than actually sleeping 20+ seconds
 * inside the test — the service exposes its own floor computation so we just
 * backdate the score directly when we want to simulate staleness.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createClient, type RedisClientType } from 'redis';
import {
  initPresenceBus,
  recordHeartbeat,
  getActiveViewers,
  removeViewer,
  subscribeToPage,
  _resetForTest,
  ACTIVE_WINDOW_SEC,
  VIEWERS_TTL_SEC,
} from './presence-service.js';

async function checkRedisReachable(): Promise<boolean> {
  const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
  const probe = createClient({ url });
  probe.on('error', () => { /* swallow */ });
  try {
    await probe.connect();
    await probe.ping();
    await probe.quit();
    return true;
  } catch {
    try { await probe.quit(); } catch { /* best effort */ }
    return false;
  }
}

const redisAvailable = await checkRedisReachable();

let main: RedisClientType | null = null;
let teardown: (() => Promise<void>) | null = null;

// Unique per-test-run key prefix so concurrent test files can't collide on
// the shared dev Redis.
const TEST_PAGE = `pgtest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const TEST_PAGE_2 = `${TEST_PAGE}-2`;

async function cleanupKeys(): Promise<void> {
  if (!main) return;
  await main.del([
    `presence:viewers:${TEST_PAGE}`,
    `presence:viewers:${TEST_PAGE_2}`,
    'presence:meta:user-alice',
    'presence:meta:user-bob',
  ]);
}

beforeAll(async () => {
  if (!redisAvailable) return;
  const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
  main = createClient({ url }) as RedisClientType;
  main.on('error', () => { /* test runner surfaces via assertions */ });
  await main.connect();
  teardown = await initPresenceBus(main);
}, 15_000);

afterAll(async () => {
  if (!redisAvailable) return;
  if (teardown) await teardown();
  await _resetForTest();
  if (main) {
    await cleanupKeys();
    await main.quit();
  }
});

beforeEach(async () => {
  if (!redisAvailable) return;
  await cleanupKeys();
});

describe.skipIf(!redisAvailable)('presence-service', () => {
  it('records a heartbeat and returns self in getActiveViewers', async () => {
    await recordHeartbeat(TEST_PAGE, 'user-alice', false, { name: 'Alice', role: 'user' });

    const viewers = await getActiveViewers(TEST_PAGE);
    expect(viewers).toHaveLength(1);
    expect(viewers[0]).toMatchObject({
      userId: 'user-alice',
      name: 'Alice',
      role: 'user',
      isEditing: false,
    });
  });

  it('reflects the isEditing flag on subsequent heartbeats', async () => {
    await recordHeartbeat(TEST_PAGE, 'user-alice', false, { name: 'Alice', role: 'user' });
    let viewers = await getActiveViewers(TEST_PAGE);
    expect(viewers[0]!.isEditing).toBe(false);

    await recordHeartbeat(TEST_PAGE, 'user-alice', true, { name: 'Alice', role: 'user' });
    viewers = await getActiveViewers(TEST_PAGE);
    expect(viewers[0]!.isEditing).toBe(true);
  });

  it('orders editing viewers first', async () => {
    await recordHeartbeat(TEST_PAGE, 'user-alice', false, { name: 'Alice', role: 'user' });
    await recordHeartbeat(TEST_PAGE, 'user-bob', true, { name: 'Bob', role: 'editor' });

    const viewers = await getActiveViewers(TEST_PAGE);
    expect(viewers).toHaveLength(2);
    expect(viewers[0]!.userId).toBe('user-bob');
    expect(viewers[0]!.isEditing).toBe(true);
    expect(viewers[1]!.userId).toBe('user-alice');
  });

  it('drops viewers whose heartbeat score is older than the active window', async () => {
    if (!main) throw new Error('unreachable');

    // Write two viewers: alice with a fresh heartbeat, bob with a stale one.
    await recordHeartbeat(TEST_PAGE, 'user-alice', false, { name: 'Alice', role: 'user' });

    const staleScore = Math.floor(Date.now() / 1000) - (ACTIVE_WINDOW_SEC + 5);
    await main.zAdd(`presence:viewers:${TEST_PAGE}`, { score: staleScore, value: 'user-bob' });
    await main.hSet('presence:meta:user-bob', { name: 'Bob', role: 'user' });

    const viewers = await getActiveViewers(TEST_PAGE);
    const ids = viewers.map((v) => v.userId);
    expect(ids).toContain('user-alice');
    expect(ids).not.toContain('user-bob');
  });

  it('removes a viewer explicitly via removeViewer', async () => {
    await recordHeartbeat(TEST_PAGE, 'user-alice', false, { name: 'Alice', role: 'user' });
    await recordHeartbeat(TEST_PAGE, 'user-bob', false, { name: 'Bob', role: 'user' });

    let viewers = await getActiveViewers(TEST_PAGE);
    expect(viewers.map((v) => v.userId).sort()).toEqual(['user-alice', 'user-bob']);

    await removeViewer(TEST_PAGE, 'user-alice');
    viewers = await getActiveViewers(TEST_PAGE);
    expect(viewers.map((v) => v.userId)).toEqual(['user-bob']);
  });

  it('sets a TTL on the viewers ZSET', async () => {
    if (!main) throw new Error('unreachable');
    await recordHeartbeat(TEST_PAGE, 'user-alice', false, { name: 'Alice', role: 'user' });

    const ttl = await main.ttl(`presence:viewers:${TEST_PAGE}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(VIEWERS_TTL_SEC);
  });

  it('fans out heartbeats to local subscribers via pub/sub', async () => {
    const received: Array<Array<{ userId: string; isEditing: boolean }>> = [];
    const unsub = subscribeToPage(TEST_PAGE, (viewers) => {
      received.push(viewers.map((v) => ({ userId: v.userId, isEditing: v.isEditing })));
    });

    try {
      await recordHeartbeat(TEST_PAGE, 'user-alice', false, { name: 'Alice', role: 'user' });

      // Pub/sub is effectively synchronous on a local Redis but we still need
      // one event-loop turn for the listener to fire.
      await new Promise((r) => setTimeout(r, 200));

      expect(received.length).toBeGreaterThanOrEqual(1);
      const last = received[received.length - 1]!;
      expect(last.some((v) => v.userId === 'user-alice')).toBe(true);
    } finally {
      unsub();
    }
  });

  it('scopes listeners to the pageId — updates on page A do not fire page B listeners', async () => {
    const receivedA: string[] = [];
    const receivedB: string[] = [];
    const unsubA = subscribeToPage(TEST_PAGE, (viewers) => {
      receivedA.push(...viewers.map((v) => v.userId));
    });
    const unsubB = subscribeToPage(TEST_PAGE_2, (viewers) => {
      receivedB.push(...viewers.map((v) => v.userId));
    });

    try {
      await recordHeartbeat(TEST_PAGE, 'user-alice', false, { name: 'Alice', role: 'user' });
      await new Promise((r) => setTimeout(r, 200));
      expect(receivedA).toContain('user-alice');
      expect(receivedB).not.toContain('user-alice');
    } finally {
      unsubA();
      unsubB();
    }
  });

  it('subscribeToPage returns a working unsubscribe function', async () => {
    let callCount = 0;
    const unsub = subscribeToPage(TEST_PAGE, () => { callCount++; });

    await recordHeartbeat(TEST_PAGE, 'user-alice', false, { name: 'Alice', role: 'user' });
    await new Promise((r) => setTimeout(r, 200));
    const afterFirst = callCount;
    expect(afterFirst).toBeGreaterThanOrEqual(1);

    unsub();

    await recordHeartbeat(TEST_PAGE, 'user-bob', false, { name: 'Bob', role: 'user' });
    await new Promise((r) => setTimeout(r, 200));
    expect(callCount).toBe(afterFirst);
  });
});
