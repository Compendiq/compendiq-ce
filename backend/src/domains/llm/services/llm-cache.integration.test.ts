import { randomUUID } from 'node:crypto';
import { createClient, type RedisClientType } from 'redis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isRedisAvailable } from '../../../test-redis-helper.js';
import { LlmCache } from './llm-cache.js';

const redisAvailable = await isRedisAvailable();
function waitForRedisExpiry(): Promise<void> {
  // This integration test exercises Redis's independent server-side TTL clock;
  // Vitest fake timers cannot advance it.
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 1_100);
  return promise;
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
    const cacheKey = `kb:llm:ownership-${randomUUID()}`;
    const lockKey = `llm:lock:${cacheKey}`;
    const a = new LlmCache(redis);
    const b = new LlmCache(redis);
    const c = new LlmCache(redis);

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
  });
});
