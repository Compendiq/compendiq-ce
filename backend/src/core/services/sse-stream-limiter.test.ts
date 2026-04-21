import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../test-db-helper.js';
import { query } from '../db/postgres.js';
import { setRedisClient, getRedisClient } from './redis-cache.js';
import {
  acquireStreamSlot,
  getStreamCap,
  invalidateStreamCapCache,
  _resetStreamCapCache,
} from './sse-stream-limiter.js';
import type { RedisClientType } from 'redis';

const dbAvailable = await isDbAvailable();

interface MockRedis {
  eval: ReturnType<typeof vi.fn>;
  decr: ReturnType<typeof vi.fn>;
}

function makeMockRedis(): MockRedis {
  return {
    eval: vi.fn(),
    decr: vi.fn().mockResolvedValue(0),
  };
}

describe.skipIf(!dbAvailable)('sse-stream-limiter', () => {
  let mockRedis: MockRedis;
  let originalRedis: RedisClientType | null;

  beforeAll(async () => {
    await setupTestDb();
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  beforeEach(async () => {
    await truncateAllTables();
    _resetStreamCapCache();
    originalRedis = getRedisClient();
    mockRedis = makeMockRedis();
    // Inject the mock so the limiter picks it up via getRedisClient().
    setRedisClient(mockRedis as unknown as RedisClientType);
    delete process.env.LLM_MAX_CONCURRENT_STREAMS_PER_USER;
  });

  afterEach(() => {
    // Restore original client (typically null in the unit-test process).
    setRedisClient(originalRedis as RedisClientType);
    delete process.env.LLM_MAX_CONCURRENT_STREAMS_PER_USER;
  });

  describe('acquireStreamSlot', () => {
    it('returns acquired=true when under cap', async () => {
      mockRedis.eval.mockResolvedValue(1);
      const slot = await acquireStreamSlot('user-a');
      expect(slot.acquired).toBe(true);
    });

    it('returns acquired=false when cap exceeded', async () => {
      mockRedis.eval.mockResolvedValue(0);
      const slot = await acquireStreamSlot('user-a');
      expect(slot.acquired).toBe(false);
    });

    it('release() is idempotent — DECR called at most once', async () => {
      mockRedis.eval.mockResolvedValue(1);
      const slot = await acquireStreamSlot('user-a');
      await slot.release();
      await slot.release();
      await slot.release();
      expect(mockRedis.decr).toHaveBeenCalledTimes(1);
      expect(mockRedis.decr).toHaveBeenCalledWith('llm:streams:user-a');
    });

    it('fails open (acquired=true) when Redis client is null', async () => {
      setRedisClient(null as unknown as RedisClientType);
      const slot = await acquireStreamSlot('user-a');
      expect(slot.acquired).toBe(true);
      // release() must not throw even without a client.
      await expect(slot.release()).resolves.toBeUndefined();
    });

    it('fails open when Redis eval throws', async () => {
      mockRedis.eval.mockRejectedValue(new Error('redis down'));
      const slot = await acquireStreamSlot('user-a');
      expect(slot.acquired).toBe(true);
      // Degraded release is a no-op.
      await expect(slot.release()).resolves.toBeUndefined();
      expect(mockRedis.decr).not.toHaveBeenCalled();
    });

    it('rejected slot does not call DECR on release', async () => {
      mockRedis.eval.mockResolvedValue(0);
      const slot = await acquireStreamSlot('user-a');
      expect(slot.acquired).toBe(false);
      await slot.release();
      expect(mockRedis.decr).not.toHaveBeenCalled();
    });

    it('Lua script receives user-keyed counter + resolved cap + ttl', async () => {
      await query(
        `INSERT INTO admin_settings (setting_key, setting_value) VALUES ($1, $2)
         ON CONFLICT (setting_key) DO UPDATE SET setting_value = $2`,
        ['llm_max_concurrent_streams_per_user', '9'],
      );
      _resetStreamCapCache();
      mockRedis.eval.mockResolvedValue(1);
      await acquireStreamSlot('user-a');
      expect(mockRedis.eval).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          keys: ['llm:streams:user-a'],
          arguments: ['9', '3600'],
        }),
      );
    });
  });

  describe('getStreamCap — cascade', () => {
    it('reads admin_settings row when present', async () => {
      await query(
        `INSERT INTO admin_settings (setting_key, setting_value) VALUES ($1, $2)
         ON CONFLICT (setting_key) DO UPDATE SET setting_value = $2`,
        ['llm_max_concurrent_streams_per_user', '7'],
      );
      _resetStreamCapCache();
      expect(await getStreamCap()).toBe(7);
    });

    it('falls back to env var when admin_settings row is absent', async () => {
      await query(
        `DELETE FROM admin_settings WHERE setting_key = $1`,
        ['llm_max_concurrent_streams_per_user'],
      );
      process.env.LLM_MAX_CONCURRENT_STREAMS_PER_USER = '5';
      _resetStreamCapCache();
      expect(await getStreamCap()).toBe(5);
    });

    it('falls back to 3 when neither DB nor env is set', async () => {
      await query(
        `DELETE FROM admin_settings WHERE setting_key = $1`,
        ['llm_max_concurrent_streams_per_user'],
      );
      delete process.env.LLM_MAX_CONCURRENT_STREAMS_PER_USER;
      _resetStreamCapCache();
      expect(await getStreamCap()).toBe(3);
    });

    it('rejects out-of-range admin_settings values (keeps hard default)', async () => {
      await query(
        `INSERT INTO admin_settings (setting_key, setting_value) VALUES ($1, $2)
         ON CONFLICT (setting_key) DO UPDATE SET setting_value = $2`,
        ['llm_max_concurrent_streams_per_user', '999'],
      );
      _resetStreamCapCache();
      expect(await getStreamCap()).toBe(3);
    });

    it('rejects non-numeric admin_settings values (keeps hard default)', async () => {
      await query(
        `INSERT INTO admin_settings (setting_key, setting_value) VALUES ($1, $2)
         ON CONFLICT (setting_key) DO UPDATE SET setting_value = $2`,
        ['llm_max_concurrent_streams_per_user', 'not-a-number'],
      );
      _resetStreamCapCache();
      expect(await getStreamCap()).toBe(3);
    });

    it('caches the resolved value (second call skips the DB)', async () => {
      await query(
        `INSERT INTO admin_settings (setting_key, setting_value) VALUES ($1, $2)
         ON CONFLICT (setting_key) DO UPDATE SET setting_value = $2`,
        ['llm_max_concurrent_streams_per_user', '4'],
      );
      _resetStreamCapCache();
      expect(await getStreamCap()).toBe(4);
      // Change the DB value but do NOT invalidate the cache.
      await query(
        `UPDATE admin_settings SET setting_value = $1 WHERE setting_key = $2`,
        ['12', 'llm_max_concurrent_streams_per_user'],
      );
      // Within the 60-second TTL, the cached value is still returned.
      expect(await getStreamCap()).toBe(4);
      // Manual invalidation picks up the new value.
      invalidateStreamCapCache();
      expect(await getStreamCap()).toBe(12);
    });
  });

  describe('graceful lowering', () => {
    it('lowering the cap does not trim in-flight streams — new opens see the new cap', async () => {
      // Start at cap=10: 4 successful acquires.
      await query(
        `INSERT INTO admin_settings (setting_key, setting_value) VALUES ($1, $2)
         ON CONFLICT (setting_key) DO UPDATE SET setting_value = $2`,
        ['llm_max_concurrent_streams_per_user', '10'],
      );
      _resetStreamCapCache();
      mockRedis.eval
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(1);
      const slots = await Promise.all([
        acquireStreamSlot('u'),
        acquireStreamSlot('u'),
        acquireStreamSlot('u'),
        acquireStreamSlot('u'),
      ]);
      expect(slots.every((s) => s.acquired)).toBe(true);

      // Admin lowers cap to 2.
      await query(
        `UPDATE admin_settings SET setting_value = $1 WHERE setting_key = $2`,
        ['2', 'llm_max_concurrent_streams_per_user'],
      );
      invalidateStreamCapCache();

      // New open sees cap=2: Lua DECRs past the cap and returns 0.
      mockRedis.eval.mockResolvedValueOnce(0);
      const rejected = await acquireStreamSlot('u');
      expect(rejected.acquired).toBe(false);

      // Existing in-flight slots still release cleanly — one DECR per slot.
      for (const s of slots) await s.release();
      expect(mockRedis.decr).toHaveBeenCalledTimes(4);
    });
  });
});
