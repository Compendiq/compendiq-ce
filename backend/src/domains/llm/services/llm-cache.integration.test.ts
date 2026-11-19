import { randomUUID } from 'node:crypto';
import { createClient, type RedisClientType } from 'redis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isRedisAvailable } from '../../../test-redis-helper.js';
import { LlmCache } from './llm-cache.js';

const redisAvailable = await isRedisAvailable();
function waitForRedisExpiry(milliseconds = 1_100): Promise<void> {
  // This integration test exercises Redis's independent server-side TTL clock;
  // Vitest fake timers cannot advance it.
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, milliseconds);
  return promise;
}
async function expectOwnershipLifecycle(
  redis: RedisClientType,
  a: LlmCache,
  b: LlmCache,
  c: LlmCache,
): Promise<void> {
  const cacheKey = `kb:llm:ownership-${randomUUID()}`;
  const lockKey = `llm:lock:${cacheKey}`;

  try {
    const staleToken = await a.acquireLock(cacheKey, 1);
    if (staleToken === null) throw new Error('Initial Redis lock was not acquired');

    await waitForRedisExpiry();

    const successorToken = await b.acquireLock(cacheKey, 30);
    expect(successorToken).toBeTypeOf('string');
    if (successorToken === null) throw new Error('Successor Redis lock was not acquired');
    expect(successorToken).not.toBe(staleToken);

    await a.releaseLock(cacheKey, staleToken);
    expect(await redis.get(lockKey)).toBe(successorToken);
    await expect(c.acquireLock(cacheKey, 30)).resolves.toBeNull();

    await b.releaseLock(cacheKey, successorToken);
    const nextToken = await c.acquireLock(cacheKey, 30);
    expect(nextToken).toBeTypeOf('string');
    if (nextToken === null) throw new Error('Next Redis lock was not acquired');
    expect(nextToken).not.toBe(successorToken);
    await c.releaseLock(cacheKey, nextToken);
  } finally {
    await redis.del(lockKey);
  }
}



describe.skipIf(!redisAvailable)('LlmCache lock ownership with real Redis', () => {
  let redis: RedisClientType;

  beforeAll(async () => {
    redis = createClient({
      url: process.env.REDIS_URL,
      socket: { connectTimeout: 1_000, reconnectStrategy: false },
    }) as RedisClientType;
    redis.on('error', () => undefined);
    await redis.connect();
  });

  afterAll(async () => {
    if (redis?.isOpen) await redis.quit();
  });

  it('keeps a successor lease when the expired owner releases, then lets the current owner release', async () => {
    await expectOwnershipLifecycle(
      redis,
      new LlmCache(redis),
      new LlmCache(redis),
      new LlmCache(redis),
    );
  });

  it('uses a fresh token for overlapping acquisitions from one cache instance', async () => {
    const cache = new LlmCache(redis);
    await expectOwnershipLifecycle(redis, cache, cache, cache);
  });

  it('renews a live lease and refuses to renew after ownership changes', async () => {
    const cacheKey = `kb:llm:renew-${randomUUID()}`;
    const lockKey = `llm:lock:${cacheKey}`;
    const owner = new LlmCache(redis);
    const waiter = new LlmCache(redis);

    try {
      const ownerToken = await owner.acquireLock(cacheKey, 2);
      expect(ownerToken).toBeTypeOf('string');
      if (ownerToken === null) throw new Error('Initial Redis lock was not acquired');

      await waitForRedisExpiry(1_200);
      await expect(owner.renewLock(cacheKey, ownerToken, 2)).resolves.toBe(true);
      await waitForRedisExpiry(1_200);
      await expect(waiter.acquireLock(cacheKey, 30)).resolves.toBeNull();

      await owner.releaseLock(cacheKey, ownerToken);
      const successorToken = await waiter.acquireLock(cacheKey, 30);
      expect(successorToken).toBeTypeOf('string');
      if (successorToken === null) throw new Error('Successor Redis lock was not acquired');

      await expect(owner.renewLock(cacheKey, ownerToken, 30)).resolves.toBe(false);
      expect(await redis.get(lockKey)).toBe(successorToken);
      await waiter.releaseLock(cacheKey, successorToken);
    } finally {
      await redis.del(lockKey);
    }
  });
});
