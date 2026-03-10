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
    it('should return true when lock is acquired (SET NX returns OK)', async () => {
      mockRedis.set.mockResolvedValue('OK');

      const acquired = await acquireEmbeddingLock('user-42');

      expect(acquired).toBe(true);
      expect(mockRedis.set).toHaveBeenCalledWith(
        'embedding:lock:user-42',
        expect.any(String),
        { NX: true, EX: 3600 },
      );
    });

    it('should return false when lock is already held (SET NX returns null)', async () => {
      mockRedis.set.mockResolvedValue(null);

      const acquired = await acquireEmbeddingLock('user-42');

      expect(acquired).toBe(false);
    });

    it('should return false when Redis throws', async () => {
      mockRedis.set.mockRejectedValue(new Error('Redis connection refused'));

      const acquired = await acquireEmbeddingLock('user-42');

      expect(acquired).toBe(false);
    });

    it('should use 1 hour TTL for safety', async () => {
      mockRedis.set.mockResolvedValue('OK');

      await acquireEmbeddingLock('user-99');

      const setCall = mockRedis.set.mock.calls[0];
      expect(setCall[2]).toEqual({ NX: true, EX: 3600 });
    });

    it('should store process PID as lock value', async () => {
      mockRedis.set.mockResolvedValue('OK');

      await acquireEmbeddingLock('user-1');

      const setCall = mockRedis.set.mock.calls[0];
      expect(setCall[1]).toBe(process.pid.toString());
    });

    it('should return true when Redis client is not available', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setRedisClient(null as any);

      const acquired = await acquireEmbeddingLock('user-1');

      expect(acquired).toBe(true); // graceful fallback
    });
  });

  describe('releaseEmbeddingLock', () => {
    it('should delete the lock key from Redis', async () => {
      mockRedis.del.mockResolvedValue(1);

      await releaseEmbeddingLock('user-42');

      expect(mockRedis.del).toHaveBeenCalledWith('embedding:lock:user-42');
    });

    it('should not throw when Redis throws', async () => {
      mockRedis.del.mockRejectedValue(new Error('Redis timeout'));

      await expect(releaseEmbeddingLock('user-42')).resolves.toBeUndefined();
    });

    it('should no-op when Redis client is not available', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setRedisClient(null as any);

      await expect(releaseEmbeddingLock('user-1')).resolves.toBeUndefined();
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
      mockRedis.del.mockResolvedValue(1);

      await acquireEmbeddingLock('test-user');
      await isEmbeddingLocked('test-user');
      await releaseEmbeddingLock('test-user');

      expect(mockRedis.set.mock.calls[0][0]).toBe('embedding:lock:test-user');
      expect(mockRedis.exists.mock.calls[0][0]).toBe('embedding:lock:test-user');
      expect(mockRedis.del.mock.calls[0][0]).toBe('embedding:lock:test-user');
    });
  });
});
