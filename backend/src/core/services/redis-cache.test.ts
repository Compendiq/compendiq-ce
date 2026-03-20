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
  recordAttachmentFailure,
  getAttachmentFailureCount,
  clearAttachmentFailures,
  MAX_ATTACHMENT_FAILURES,
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
    it('should return a lock identifier when lock is acquired (SET NX returns OK)', async () => {
      mockRedis.set.mockResolvedValue('OK');

      const lockId = await acquireEmbeddingLock('user-42');

      expect(lockId).toBeTypeOf('string');
      expect(lockId).toBeTruthy();
      expect(mockRedis.set).toHaveBeenCalledWith(
        'embedding:lock:user-42',
        expect.any(String),
        { NX: true, EX: 3600 },
      );
    });

    it('should return null when lock is already held (SET NX returns null)', async () => {
      mockRedis.set.mockResolvedValue(null);

      const lockId = await acquireEmbeddingLock('user-42');

      expect(lockId).toBeNull();
    });

    it('should return null when Redis throws', async () => {
      mockRedis.set.mockRejectedValue(new Error('Redis connection refused'));

      const lockId = await acquireEmbeddingLock('user-42');

      expect(lockId).toBeNull();
    });

    it('should use 1 hour TTL for safety', async () => {
      mockRedis.set.mockResolvedValue('OK');

      await acquireEmbeddingLock('user-99');

      const setCall = mockRedis.set.mock.calls[0];
      expect(setCall[2]).toEqual({ NX: true, EX: 3600 });
    });

    it('should store a UUID as lock value (not PID)', async () => {
      mockRedis.set.mockResolvedValue('OK');

      const lockId = await acquireEmbeddingLock('user-1');

      const setCall = mockRedis.set.mock.calls[0];
      // Lock value stored in Redis should match the returned identifier
      expect(setCall[1]).toBe(lockId);
      // Should be a UUID format
      expect(setCall[1]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
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
    it('should use Lua script to verify ownership before deleting', async () => {
      mockRedis.eval.mockResolvedValue(1);
      const lockId = 'test-lock-id-123';

      await releaseEmbeddingLock('user-42', lockId);

      expect(mockRedis.eval).toHaveBeenCalledWith(
        expect.stringContaining('redis.call("get", KEYS[1]) == ARGV[1]'),
        {
          keys: ['embedding:lock:user-42'],
          arguments: [lockId],
        },
      );
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
    it('should use embedding:lock:<userId> format', async () => {
      mockRedis.set.mockResolvedValue('OK');
      mockRedis.exists.mockResolvedValue(1);
      mockRedis.eval.mockResolvedValue(1);

      const lockId = await acquireEmbeddingLock('test-user');
      await isEmbeddingLocked('test-user');
      await releaseEmbeddingLock('test-user', lockId!);

      expect(mockRedis.set.mock.calls[0][0]).toBe('embedding:lock:test-user');
      expect(mockRedis.exists.mock.calls[0][0]).toBe('embedding:lock:test-user');
      expect(mockRedis.eval.mock.calls[0][1]).toEqual(
        expect.objectContaining({ keys: ['embedding:lock:test-user'] }),
      );
    });
  });
});
