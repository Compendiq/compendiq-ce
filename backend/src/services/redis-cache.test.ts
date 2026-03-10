import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import {
  setRedisClient,
  getRedisClient,
  acquireEmbeddingLock,
  releaseEmbeddingLock,
  isEmbeddingLocked,
} from './redis-cache.js';

/**
 * Create a minimal mock Redis client with the methods used by embedding lock functions.
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
  };
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
