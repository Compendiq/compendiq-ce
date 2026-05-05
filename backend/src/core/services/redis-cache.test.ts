import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RedisClientType } from 'redis';

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import {
  setRedisClient,
  getRedisClient,
  acquireEmbeddingLock,
  releaseEmbeddingLock,
  isEmbeddingLocked,
  listActiveEmbeddingLocks,
  forceReleaseEmbeddingLock,
  recordAttachmentFailure,
  getAttachmentFailureCount,
  clearAttachmentFailures,
  MAX_ATTACHMENT_FAILURES,
  RedisCache,
  acquireWorkerLock,
  releaseWorkerLock,
} from './redis-cache.js';

/**
 * Create a minimal mock Redis client with the methods used by all functions in this module.
 */
function createMockRedisClient() {
  return {
    set: vi.fn(),
    del: vi.fn(),
    eval: vi.fn(),
    exists: vi.fn(),
    get: vi.fn(),
    setEx: vi.fn(),
    scan: vi.fn(),
    ping: vi.fn(),
    incr: vi.fn(),
    expire: vi.fn(),
    pTTL: vi.fn(),
    sMembers: vi.fn(),
    sAdd: vi.fn(),
    sRem: vi.fn(),
    multi: vi.fn(),
  };
}

/** Cast the mock client to the Redis type for type-safe function calls in tests */
function asRedis(mock: ReturnType<typeof createMockRedisClient>): RedisClientType {
  return mock as unknown as RedisClientType;
}

describe('redis-cache embedding lock', () => {
  let mockRedis: ReturnType<typeof createMockRedisClient>;

  beforeEach(() => {
    mockRedis = createMockRedisClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setRedisClient(mockRedis as any);
  });

  afterEach(() => {
    // Reset the module-level client to avoid leaking between tests
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setRedisClient(null as any);
  });

  describe('getRedisClient', () => {
    it('should return the client after setRedisClient is called', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const client = { fake: true } as any;
      setRedisClient(client);
      expect(getRedisClient()).toBe(client);
    });
  });

  describe('acquireEmbeddingLock', () => {
    it('should return the lock identifier when Lua script returns it (acquired)', async () => {
      // The acquire Lua script returns ARGV[1] (the lockId) on success.
      mockRedis.eval.mockImplementation(
        async (_script: string, opts: { arguments: string[] }) => opts.arguments[0],
      );

      const lockId = await acquireEmbeddingLock('user-42');

      expect(lockId).toBeTypeOf('string');
      expect(lockId).toBeTruthy();
    });

    it('atomically adds userId to embedding:locks:active on success (plan RED #1)', async () => {
      mockRedis.eval.mockImplementation(
        async (_script: string, opts: { arguments: string[] }) => opts.arguments[0],
      );

      await acquireEmbeddingLock('user-a');

      expect(mockRedis.eval).toHaveBeenCalledWith(
        expect.stringContaining('sadd'),
        expect.objectContaining({
          keys: ['embedding:lock:user-a', 'embedding:locks:active'],
          // lockId, userId, ttl
          arguments: expect.arrayContaining(['user-a', '3600']),
        }),
      );
      // Lua script must be gated on SET NX so SADD does not run if already locked.
      const script = mockRedis.eval.mock.calls[0][0] as string;
      expect(script.toLowerCase()).toContain('set');
      expect(script.toLowerCase()).toContain('nx');
      expect(script.toLowerCase()).toContain('sadd');
    });

    it('should return null when lock is already held (Lua returns nil) — plan RED #1b', async () => {
      mockRedis.eval.mockResolvedValue(null);

      const lockId = await acquireEmbeddingLock('user-42');

      expect(lockId).toBeNull();
    });

    it('should return null when Redis throws', async () => {
      mockRedis.eval.mockRejectedValue(new Error('Redis connection refused'));

      const lockId = await acquireEmbeddingLock('user-42');

      expect(lockId).toBeNull();
    });

    it('should pass 1 hour TTL (3600 s) to the Lua script', async () => {
      mockRedis.eval.mockImplementation(
        async (_script: string, opts: { arguments: string[] }) => opts.arguments[0],
      );

      await acquireEmbeddingLock('user-99');

      const call = mockRedis.eval.mock.calls[0];
      const opts = call[1] as { arguments: string[] };
      // arguments = [lockId, userId, ttl]
      expect(opts.arguments[2]).toBe('3600');
    });

    it('should pass a UUID as lockId', async () => {
      mockRedis.eval.mockImplementation(
        async (_script: string, opts: { arguments: string[] }) => opts.arguments[0],
      );

      const lockId = await acquireEmbeddingLock('user-1');

      const call = mockRedis.eval.mock.calls[0];
      const opts = call[1] as { arguments: string[] };
      // The returned lockId comes from ARGV[1]; it is the argument passed to the script.
      expect(opts.arguments[0]).toBe(lockId);
      expect(opts.arguments[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it('should return a lock identifier when Redis client is not available', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setRedisClient(null as any);

      const lockId = await acquireEmbeddingLock('user-1');

      expect(lockId).toBeTypeOf('string');
      expect(lockId).toBeTruthy(); // graceful fallback
    });
  });

  describe('releaseEmbeddingLock', () => {
    it('uses Lua script that verifies ownership and SREMs the active set atomically (plan RED #2)', async () => {
      mockRedis.eval.mockResolvedValue(1);
      const lockId = 'test-lock-id-123';

      await releaseEmbeddingLock('user-42', lockId);

      expect(mockRedis.eval).toHaveBeenCalledTimes(1);
      const [script, opts] = mockRedis.eval.mock.calls[0];
      expect(script).toEqual(expect.stringContaining('redis.call("get", KEYS[1]) == ARGV[1]'));
      expect((script as string).toLowerCase()).toContain('srem');
      expect(opts).toEqual({
        keys: ['embedding:lock:user-42', 'embedding:locks:active'],
        arguments: [lockId, 'user-42'],
      });
    });

    it('should not call del directly (uses Lua script instead)', async () => {
      mockRedis.eval.mockResolvedValue(1);

      await releaseEmbeddingLock('user-42', 'some-lock-id');

      expect(mockRedis.del).not.toHaveBeenCalled();
    });

    it('should not throw when Redis throws', async () => {
      mockRedis.eval.mockRejectedValue(new Error('Redis timeout'));

      await expect(releaseEmbeddingLock('user-42', 'some-lock-id')).resolves.toBeUndefined();
    });

    it('should no-op when Redis client is not available', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setRedisClient(null as any);

      await expect(releaseEmbeddingLock('user-1', 'some-lock-id')).resolves.toBeUndefined();
    });
  });

  describe('isEmbeddingLocked', () => {
    it('should return true when key exists', async () => {
      mockRedis.exists.mockResolvedValue(1);

      const locked = await isEmbeddingLocked('user-42');

      expect(locked).toBe(true);
      expect(mockRedis.exists).toHaveBeenCalledWith('embedding:lock:user-42');
    });

    it('should return false when key does not exist', async () => {
      mockRedis.exists.mockResolvedValue(0);

      const locked = await isEmbeddingLocked('user-42');

      expect(locked).toBe(false);
    });

    it('should return false when Redis throws', async () => {
      mockRedis.exists.mockRejectedValue(new Error('Redis down'));

      const locked = await isEmbeddingLocked('user-42');

      expect(locked).toBe(false);
    });

    it('should return false when Redis client is not available', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setRedisClient(null as any);

      const locked = await isEmbeddingLocked('user-1');

      expect(locked).toBe(false);
    });
  });

  // ─── Issue #265 — SMEMBERS-based listing with lazy self-heal ─────────────
  describe('listActiveEmbeddingLocks', () => {
    /**
     * Build a chainable MULTI mock whose `exec()` resolves to `replies`,
     * interleaved [GET, PTTL, GET, PTTL, ...] — matching the implementation
     * order for each SMEMBERS entry.
     */
    function mockMulti(replies: Array<string | number | null>) {
      const chain = {
        get: vi.fn().mockReturnThis(),
        pTTL: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue(replies),
      };
      mockRedis.multi.mockReturnValue(chain);
      return chain;
    }

    it('returns empty array when Redis client is not available', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setRedisClient(null as any);
      const locks = await listActiveEmbeddingLocks();
      expect(locks).toEqual([]);
    });

    it('returns empty array when the active-locks set is empty (SMEMBERS → [])', async () => {
      mockRedis.sMembers.mockResolvedValueOnce([]);
      const locks = await listActiveEmbeddingLocks();
      expect(locks).toEqual([]);
      expect(mockRedis.sMembers).toHaveBeenCalledWith('embedding:locks:active');
      // Must NOT fall back to SCAN.
      expect(mockRedis.scan).not.toHaveBeenCalled();
    });

    it('returns EmbeddingLockSnapshot[] for each member (parity with SCAN version) — plan RED #3', async () => {
      mockRedis.sMembers.mockResolvedValueOnce(['alice', 'bob']);
      mockMulti(['uuid-alice', 3_000_000, 'uuid-bob', 2_500_000]);

      const locks = await listActiveEmbeddingLocks();

      // Shape parity: same EmbeddingLockSnapshot[] as the old SCAN version.
      expect(locks).toEqual(
        expect.arrayContaining([
          { userId: 'alice', holderEpoch: 'uuid-alice', ttlRemainingMs: 3_000_000 },
          { userId: 'bob', holderEpoch: 'uuid-bob', ttlRemainingMs: 2_500_000 },
        ]),
      );
      expect(locks).toHaveLength(2);
    });

    it('self-heals a stale set member (key expired, SREM never ran) — plan RED #4', async () => {
      mockRedis.sMembers.mockResolvedValueOnce(['alice', 'stale-user']);
      // Replies interleaved [GET, PTTL, GET, PTTL]. `null` GET = expired key.
      mockMulti(['uuid-alice', 3_000_000, null, -2]);
      mockRedis.sRem.mockResolvedValue(1);

      const locks = await listActiveEmbeddingLocks();

      // Snapshot returned synchronously includes the stale entry with parity -2 TTL.
      expect(locks).toContainEqual({ userId: 'alice', holderEpoch: 'uuid-alice', ttlRemainingMs: 3_000_000 });
      expect(locks).toContainEqual({ userId: 'stale-user', holderEpoch: '', ttlRemainingMs: -2 });

      // Lazy async self-heal fires SREM for the stale member(s) — not awaited, but
      // the microtask is scheduled synchronously by the promise chain. Yield once.
      await Promise.resolve();
      await Promise.resolve();
      expect(mockRedis.sRem).toHaveBeenCalledWith('embedding:locks:active', ['stale-user']);
    });

    it('does NOT call SREM when no stale members are present', async () => {
      mockRedis.sMembers.mockResolvedValueOnce(['alice']);
      mockMulti(['uuid-alice', 3_000_000]);
      mockRedis.sRem.mockResolvedValue(0);

      await listActiveEmbeddingLocks();
      await Promise.resolve();

      expect(mockRedis.sRem).not.toHaveBeenCalled();
    });

    it('returns empty array when SMEMBERS throws', async () => {
      mockRedis.sMembers.mockRejectedValue(new Error('Redis down'));
      const locks = await listActiveEmbeddingLocks();
      expect(locks).toEqual([]);
    });

    it('returns empty array when MULTI.exec throws', async () => {
      mockRedis.sMembers.mockResolvedValueOnce(['alice']);
      const chain = {
        get: vi.fn().mockReturnThis(),
        pTTL: vi.fn().mockReturnThis(),
        exec: vi.fn().mockRejectedValue(new Error('Pipeline failed')),
      };
      mockRedis.multi.mockReturnValue(chain);

      const locks = await listActiveEmbeddingLocks();
      expect(locks).toEqual([]);
    });
  });

  // ─── Issue #265 — forceReleaseEmbeddingLock via Lua (key + SREM atomic) ───
  describe('forceReleaseEmbeddingLock', () => {
    it('returns { released: false, previousHolderEpoch: null } when Redis is unavailable', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setRedisClient(null as any);
      const result = await forceReleaseEmbeddingLock('alice');
      expect(result).toEqual({ released: false, previousHolderEpoch: null });
    });

    it('returns { released: true, previousHolderEpoch: "<uuid>" } when the key existed', async () => {
      // Lua returns the previous holder epoch on successful DEL.
      mockRedis.eval.mockResolvedValueOnce('uuid-alice');

      const result = await forceReleaseEmbeddingLock('alice');

      expect(result).toEqual({ released: true, previousHolderEpoch: 'uuid-alice' });
      expect(mockRedis.eval).toHaveBeenCalledWith(
        expect.stringContaining('srem'),
        expect.objectContaining({
          keys: ['embedding:lock:alice', 'embedding:locks:active'],
          arguments: ['alice'],
        }),
      );
    });

    it('SREMs the active set even when the key was already gone (plan RED #5, idempotent)', async () => {
      // Lua returns nil when key did not exist; SREM still runs to scrub drift.
      mockRedis.eval.mockResolvedValueOnce(null);

      const result = await forceReleaseEmbeddingLock('ghost');

      expect(result).toEqual({ released: false, previousHolderEpoch: null });
      expect(mockRedis.eval).toHaveBeenCalledWith(
        expect.stringContaining('srem'),
        expect.objectContaining({
          keys: ['embedding:lock:ghost', 'embedding:locks:active'],
          arguments: ['ghost'],
        }),
      );
    });

    it('returns { released: false, previousHolderEpoch: null } when Redis throws', async () => {
      mockRedis.eval.mockRejectedValueOnce(new Error('Redis down'));

      const result = await forceReleaseEmbeddingLock('alice');

      expect(result).toEqual({ released: false, previousHolderEpoch: null });
    });

    it('uses the embedding:lock:<userId> key pattern', async () => {
      mockRedis.eval.mockResolvedValueOnce('uuid');

      await forceReleaseEmbeddingLock('user-with-hyphens');

      const call = mockRedis.eval.mock.calls[0];
      const opts = call[1] as { keys: string[] };
      expect(opts.keys[0]).toBe('embedding:lock:user-with-hyphens');
    });
  });

  describe('attachment failure tracking', () => {
    it('MAX_ATTACHMENT_FAILURES is exported and equals 3', () => {
      expect(MAX_ATTACHMENT_FAILURES).toBe(3);
    });

    describe('recordAttachmentFailure', () => {
      it('calls INCR on the correct key pattern attach:fail:{pageId}:{filename}', async () => {
        mockRedis.incr = vi.fn().mockResolvedValue(1);
        mockRedis.expire = vi.fn().mockResolvedValue(1);

        await recordAttachmentFailure(asRedis(mockRedis), 'page-1', 'logo.png');

        expect(mockRedis.incr).toHaveBeenCalledWith('attach:fail:page-1:logo.png');
      });

      it('calls EXPIRE after INCR with a 7-day TTL', async () => {
        mockRedis.incr = vi.fn().mockResolvedValue(1);
        mockRedis.expire = vi.fn().mockResolvedValue(1);

        await recordAttachmentFailure(asRedis(mockRedis), 'page-1', 'logo.png');

        expect(mockRedis.expire).toHaveBeenCalledWith('attach:fail:page-1:logo.png', 7 * 24 * 3600);
      });

      it('is a no-op when redis is null', async () => {
        // Should not throw
        await expect(recordAttachmentFailure(null, 'page-1', 'logo.png')).resolves.toBeUndefined();
      });

      it('logs error but does not throw when Redis throws', async () => {
        mockRedis.incr = vi.fn().mockRejectedValue(new Error('Redis unavailable'));
        mockRedis.expire = vi.fn().mockResolvedValue(1);

        await expect(recordAttachmentFailure(asRedis(mockRedis), 'page-1', 'logo.png')).resolves.toBeUndefined();
      });
    });

    describe('getAttachmentFailureCount', () => {
      it('returns the integer count from Redis GET', async () => {
        mockRedis.get.mockResolvedValue('2');

        const count = await getAttachmentFailureCount(asRedis(mockRedis), 'page-1', 'logo.png');

        expect(count).toBe(2);
        expect(mockRedis.get).toHaveBeenCalledWith('attach:fail:page-1:logo.png');
      });

      it('returns 0 when key does not exist (GET returns null)', async () => {
        mockRedis.get.mockResolvedValue(null);

        const count = await getAttachmentFailureCount(asRedis(mockRedis), 'page-1', 'logo.png');

        expect(count).toBe(0);
      });

      it('returns 0 when redis is null', async () => {
        const count = await getAttachmentFailureCount(null, 'page-1', 'logo.png');

        expect(count).toBe(0);
      });

      it('returns 0 when Redis throws', async () => {
        mockRedis.get.mockRejectedValue(new Error('Redis down'));

        const count = await getAttachmentFailureCount(asRedis(mockRedis), 'page-1', 'logo.png');

        expect(count).toBe(0);
      });

      it('returns 0 when stored value is not a valid number', async () => {
        mockRedis.get.mockResolvedValue('not-a-number');

        const count = await getAttachmentFailureCount(asRedis(mockRedis), 'page-1', 'logo.png');

        expect(count).toBe(0);
      });
    });

    describe('clearAttachmentFailures', () => {
      it('scans for and deletes all attach:fail:{pageId}:* keys', async () => {
        mockRedis.scan.mockResolvedValueOnce({ cursor: '0', keys: ['attach:fail:page-1:logo.png', 'attach:fail:page-1:photo.jpg'] });
        mockRedis.del.mockResolvedValue(2);

        await clearAttachmentFailures(asRedis(mockRedis), 'page-1');

        expect(mockRedis.scan).toHaveBeenCalledWith('0', { MATCH: 'attach:fail:page-1:*', COUNT: 100 });
        expect(mockRedis.del).toHaveBeenCalledWith(['attach:fail:page-1:logo.png', 'attach:fail:page-1:photo.jpg']);
      });

      it('handles paginated SCAN results (multi-page cursor loop)', async () => {
        mockRedis.scan
          .mockResolvedValueOnce({ cursor: '5', keys: ['attach:fail:page-1:a.png'] })
          .mockResolvedValueOnce({ cursor: '0', keys: ['attach:fail:page-1:b.png'] });

        await clearAttachmentFailures(asRedis(mockRedis), 'page-1');

        expect(mockRedis.scan).toHaveBeenCalledTimes(2);
        expect(mockRedis.del).toHaveBeenCalledTimes(2);
      });

      it('does not call del when no keys are found', async () => {
        mockRedis.scan.mockResolvedValueOnce({ cursor: '0', keys: [] });

        await clearAttachmentFailures(asRedis(mockRedis), 'page-1');

        expect(mockRedis.del).not.toHaveBeenCalled();
      });

      it('is a no-op when redis is null', async () => {
        await expect(clearAttachmentFailures(null, 'page-1')).resolves.toBeUndefined();
      });
    });
  });

  describe('lock key format', () => {
    it('should use embedding:lock:<userId> format alongside embedding:locks:active', async () => {
      mockRedis.eval.mockImplementation(
        async (_script: string, opts: { arguments: string[] }) => opts.arguments[0],
      );
      mockRedis.exists.mockResolvedValue(1);

      const lockId = await acquireEmbeddingLock('test-user');
      await isEmbeddingLocked('test-user');
      await releaseEmbeddingLock('test-user', lockId!);

      // Acquire eval — call 0
      expect(mockRedis.eval.mock.calls[0][1]).toEqual(
        expect.objectContaining({
          keys: ['embedding:lock:test-user', 'embedding:locks:active'],
        }),
      );
      expect(mockRedis.exists.mock.calls[0][0]).toBe('embedding:lock:test-user');
      // Release eval — call 1
      expect(mockRedis.eval.mock.calls[1][1]).toEqual(
        expect.objectContaining({
          keys: ['embedding:lock:test-user', 'embedding:locks:active'],
        }),
      );
    });
  });

  describe('acquireWorkerLock', () => {
    it('returns true when lock is acquired (SET NX returns OK)', async () => {
      mockRedis.set.mockResolvedValue('OK');

      const acquired = await acquireWorkerLock('quality-worker');

      expect(acquired).toBe(true);
      expect(mockRedis.set).toHaveBeenCalledWith(
        'worker:lock:quality-worker',
        '1',
        { NX: true, EX: 300 },
      );
    });

    it('returns false when lock is already held', async () => {
      mockRedis.set.mockResolvedValue(null);

      const acquired = await acquireWorkerLock('quality-worker');

      expect(acquired).toBe(false);
    });

    it('uses custom TTL when provided', async () => {
      mockRedis.set.mockResolvedValue('OK');

      await acquireWorkerLock('summary-worker', 600);

      const call = mockRedis.set.mock.calls[0];
      expect(call[2]).toEqual({ NX: true, EX: 600 });
    });

    it('falls back to true when Redis is not available', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setRedisClient(null as any);

      const acquired = await acquireWorkerLock('test-worker');

      expect(acquired).toBe(true);
    });

    it('falls back to true when Redis throws', async () => {
      mockRedis.set.mockRejectedValue(new Error('Redis down'));

      const acquired = await acquireWorkerLock('test-worker');

      expect(acquired).toBe(true);
    });
  });

  describe('releaseWorkerLock', () => {
    it('deletes the lock key', async () => {
      mockRedis.del.mockResolvedValue(1);

      await releaseWorkerLock('quality-worker');

      expect(mockRedis.del).toHaveBeenCalledWith('worker:lock:quality-worker');
    });

    it('is a no-op when Redis is not available', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setRedisClient(null as any);

      await expect(releaseWorkerLock('test-worker')).resolves.toBeUndefined();
    });

    it('does not throw when Redis throws', async () => {
      mockRedis.del.mockRejectedValue(new Error('Redis timeout'));

      await expect(releaseWorkerLock('test-worker')).resolves.toBeUndefined();
    });
  });
});

describe('RedisCache.getOrCompute', () => {
  let mockRedis: ReturnType<typeof createMockRedisClient>;
  let cache: RedisCache;

  beforeEach(() => {
    mockRedis = createMockRedisClient();
    cache = new RedisCache(asRedis(mockRedis));
  });

  it('returns cached value on cache hit without calling computeFn', async () => {
    mockRedis.get.mockResolvedValue(JSON.stringify({ data: 42 }));
    const computeFn = vi.fn();

    const result = await cache.getOrCompute('key1', computeFn, 300);

    expect(result).toEqual({ data: 42 });
    expect(computeFn).not.toHaveBeenCalled();
  });

  it('computes, stores, and returns value on cache miss when lock acquired', async () => {
    // Cache miss
    mockRedis.get.mockResolvedValueOnce(null);
    // Lock acquired
    mockRedis.set.mockResolvedValue('OK');
    // setEx succeeds
    mockRedis.setEx.mockResolvedValue('OK');
    // del (lock release) succeeds
    mockRedis.del.mockResolvedValue(1);

    const computeFn = vi.fn().mockResolvedValue({ data: 99 });

    const result = await cache.getOrCompute('key2', computeFn, 600);

    expect(result).toEqual({ data: 99 });
    expect(computeFn).toHaveBeenCalledOnce();
    expect(mockRedis.setEx).toHaveBeenCalledWith('key2', 600, JSON.stringify({ data: 99 }));
    expect(mockRedis.del).toHaveBeenCalledWith('key2:lock');
  });

  it('polls and returns value when another caller holds the lock', async () => {
    // Cache miss on initial get
    mockRedis.get.mockResolvedValueOnce(null);
    // Lock NOT acquired (another caller has it)
    mockRedis.set.mockResolvedValue(null);
    // Polling: miss on first poll, hit on second poll
    mockRedis.get
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(JSON.stringify({ data: 'from-other-caller' }));

    const computeFn = vi.fn();

    const result = await cache.getOrCompute('key3', computeFn, 300);

    expect(result).toEqual({ data: 'from-other-caller' });
    expect(computeFn).not.toHaveBeenCalled();
  });

  it('falls through to compute when poll times out', async () => {
    // Cache miss
    mockRedis.get.mockResolvedValue(null);
    // Lock NOT acquired
    mockRedis.set.mockResolvedValue(null);
    // setEx for the fallback compute
    mockRedis.setEx.mockResolvedValue('OK');

    const computeFn = vi.fn().mockResolvedValue('fallback-value');

    const result = await cache.getOrCompute('key4', computeFn, 300);

    expect(result).toBe('fallback-value');
    expect(computeFn).toHaveBeenCalledOnce();
  }, 15_000);

  it('releases lock even when computeFn throws', async () => {
    mockRedis.get.mockResolvedValueOnce(null);
    mockRedis.set.mockResolvedValue('OK');
    mockRedis.del.mockResolvedValue(1);

    const computeFn = vi.fn().mockRejectedValue(new Error('compute error'));

    await expect(cache.getOrCompute('key5', computeFn, 300)).rejects.toThrow('compute error');
    expect(mockRedis.del).toHaveBeenCalledWith('key5:lock');
  });

  it('falls through to compute when Redis read fails', async () => {
    mockRedis.get.mockRejectedValue(new Error('Redis down'));
    // Lock acquisition also fails
    mockRedis.set.mockRejectedValue(new Error('Redis down'));
    mockRedis.setEx.mockRejectedValue(new Error('Redis down'));

    const computeFn = vi.fn().mockResolvedValue('computed');

    const result = await cache.getOrCompute('key6', computeFn, 300);

    expect(result).toBe('computed');
    expect(computeFn).toHaveBeenCalledOnce();
  });
});

describe('RedisCache.invalidateAcrossUsers (#352)', () => {
  let mockRedis: ReturnType<typeof createMockRedisClient>;
  let cache: RedisCache;

  beforeEach(() => {
    mockRedis = createMockRedisClient();
    cache = new RedisCache(asRedis(mockRedis));
  });

  it('SCANs the cross-user pattern and deletes every matching key', async () => {
    // One SCAN page, two matching keys across two different userIds.
    mockRedis.scan.mockResolvedValueOnce({
      cursor: '0',
      keys: ['kb:alice:spaces:list', 'kb:bob:spaces:list'],
    });
    mockRedis.del.mockResolvedValue(2);

    await cache.invalidateAcrossUsers('spaces');

    expect(mockRedis.scan).toHaveBeenCalledWith('0', {
      MATCH: 'kb:*:spaces:*',
      COUNT: 100,
    });
    expect(mockRedis.del).toHaveBeenCalledWith([
      'kb:alice:spaces:list',
      'kb:bob:spaces:list',
    ]);
  });

  it('walks the cursor across multiple SCAN pages', async () => {
    mockRedis.scan
      .mockResolvedValueOnce({ cursor: '42', keys: ['kb:alice:spaces:list'] })
      .mockResolvedValueOnce({ cursor: '0', keys: ['kb:bob:spaces:list'] });
    mockRedis.del.mockResolvedValue(1);

    await cache.invalidateAcrossUsers('spaces');

    expect(mockRedis.scan).toHaveBeenCalledTimes(2);
    expect(mockRedis.del).toHaveBeenCalledTimes(2);
  });

  it('does not call DEL when SCAN returns no keys', async () => {
    mockRedis.scan.mockResolvedValueOnce({ cursor: '0', keys: [] });

    await cache.invalidateAcrossUsers('spaces');

    expect(mockRedis.del).not.toHaveBeenCalled();
  });

  it('soft-fails when SCAN throws (logs, does not raise)', async () => {
    mockRedis.scan.mockRejectedValue(new Error('Redis down'));

    await expect(cache.invalidateAcrossUsers('spaces')).resolves.toBeUndefined();
  });
});
