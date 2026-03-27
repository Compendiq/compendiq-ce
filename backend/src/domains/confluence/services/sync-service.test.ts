/**
 * Unit tests for sync-service.ts Redis distributed lock and status.
 *
 * Mocks Redis, database, and external services to isolate the lock/status logic.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RedisClientType } from 'redis';

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../../../core/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../core/db/postgres.js', () => ({
  query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
}));

vi.mock('../../../core/services/rbac-service.js', () => ({
  getUserAccessibleSpaces: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../../core/utils/crypto.js', () => ({
  decryptPat: vi.fn().mockReturnValue('decrypted-pat'),
}));

vi.mock('../../../core/utils/ssrf-guard.js', () => ({
  addAllowedBaseUrl: vi.fn(),
}));

vi.mock('./confluence-client.js', () => ({
  ConfluenceClient: vi.fn(),
}));

vi.mock('../../../core/services/content-converter.js', () => ({
  confluenceToHtml: vi.fn().mockReturnValue('<p>test</p>'),
  htmlToText: vi.fn().mockReturnValue('test'),
}));

vi.mock('./attachment-handler.js', () => ({
  syncDrawioAttachments: vi.fn(),
  syncImageAttachments: vi.fn(),
  cleanPageAttachments: vi.fn(),
  getMissingAttachments: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../../core/services/version-snapshot.js', () => ({
  saveVersionSnapshot: vi.fn(),
}));

vi.mock('../../llm/services/embedding-service.js', () => ({
  processDirtyPages: vi.fn().mockResolvedValue({ processed: 0, errors: 0 }),
}));

// Mock redis-cache with controllable getRedisClient
const mockRedisGet = vi.fn();
const mockRedisSet = vi.fn();
const mockRedisDel = vi.fn();
const mockRedisEval = vi.fn();
const mockRedisExists = vi.fn();
const mockRedisScan = vi.fn();
const mockRedisIncr = vi.fn();
const mockRedisExpire = vi.fn();

function createMockRedis() {
  return {
    get: mockRedisGet,
    set: mockRedisSet,
    del: mockRedisDel,
    eval: mockRedisEval,
    exists: mockRedisExists,
    scan: mockRedisScan,
    incr: mockRedisIncr,
    expire: mockRedisExpire,
    setEx: vi.fn(),
    ping: vi.fn(),
  } as unknown as RedisClientType;
}

let mockRedisClient: RedisClientType | null = null;

vi.mock('../../../core/services/redis-cache.js', () => ({
  getRedisClient: () => mockRedisClient,
  recordAttachmentFailure: vi.fn(),
  getAttachmentFailureCount: vi.fn().mockResolvedValue(0),
  clearAttachmentFailures: vi.fn(),
  MAX_ATTACHMENT_FAILURES: 3,
}));

// Now import the module under test
import { getSyncStatus, setSyncStatus, startSyncWorker, stopSyncWorker } from './sync-service.js';
import { query } from '../../../core/db/postgres.js';

// ── Tests ────────────────────────────────────────────────────────────────────

describe('sync-service', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockRedisClient = createMockRedis();
    mockRedisGet.mockReset();
    mockRedisSet.mockReset();
    mockRedisDel.mockReset();
    mockRedisEval.mockReset();
    mockRedisExists.mockReset();
    mockRedisScan.mockReset();
    mockRedisIncr.mockReset();
    mockRedisExpire.mockReset();
  });

  afterEach(() => {
    stopSyncWorker();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  // ── setSyncStatus ─────────────────────────────────────────────────────────

  describe('setSyncStatus', () => {
    it('writes status to Redis with 24h TTL', async () => {
      mockRedisSet.mockResolvedValue('OK');

      await setSyncStatus('user-1', { userId: 'user-1', status: 'syncing' });

      expect(mockRedisSet).toHaveBeenCalledWith(
        'sync:status:user-1',
        expect.any(String),
        { EX: 86_400 },
      );

      // Verify the JSON payload
      const payload = JSON.parse(mockRedisSet.mock.calls[0][1] as string);
      expect(payload.userId).toBe('user-1');
      expect(payload.status).toBe('syncing');
    });

    it('does not throw when Redis is unavailable', async () => {
      mockRedisClient = null;

      await expect(
        setSyncStatus('user-1', { userId: 'user-1', status: 'idle' }),
      ).resolves.toBeUndefined();
    });

    it('does not throw when Redis set fails', async () => {
      mockRedisSet.mockRejectedValue(new Error('Redis timeout'));

      await expect(
        setSyncStatus('user-1', { userId: 'user-1', status: 'idle' }),
      ).resolves.toBeUndefined();
    });
  });

  // ── getSyncStatus ─────────────────────────────────────────────────────────

  describe('getSyncStatus', () => {
    it('reads status from Redis and revives lastSynced Date', async () => {
      const isoDate = '2025-01-15T10:30:00.000Z';
      mockRedisGet.mockResolvedValue(
        JSON.stringify({ userId: 'user-2', status: 'idle', lastSynced: isoDate }),
      );

      const status = await getSyncStatus('user-2');

      expect(mockRedisGet).toHaveBeenCalledWith('sync:status:user-2');
      expect(status.status).toBe('idle');
      expect(status.lastSynced).toBeInstanceOf(Date);
      expect((status.lastSynced as Date).toISOString()).toBe(isoDate);
    });

    it('falls back to DB when Redis has no data', async () => {
      mockRedisGet.mockResolvedValue(null);
      vi.mocked(query).mockResolvedValueOnce({
        rows: [{ last_synced: new Date('2025-01-01T00:00:00Z') }],
        rowCount: 1,
        command: '',
        oid: 0,
        fields: [],
      });

      const status = await getSyncStatus('user-3');

      expect(status.status).toBe('idle');
      expect(status.lastSynced).toBeInstanceOf(Date);
    });

    it('falls back to DB when Redis throws', async () => {
      mockRedisGet.mockRejectedValue(new Error('Redis connection refused'));
      vi.mocked(query).mockResolvedValueOnce({
        rows: [{ last_synced: null }],
        rowCount: 1,
        command: '',
        oid: 0,
        fields: [],
      });

      const status = await getSyncStatus('user-4');

      expect(status.status).toBe('idle');
    });

    it('returns idle with no lastSynced when DB has no data either', async () => {
      mockRedisGet.mockResolvedValue(null);
      mockRedisClient = null; // force Redis unavailable
      vi.mocked(query).mockResolvedValueOnce({
        rows: [{ last_synced: null }],
        rowCount: 1,
        command: '',
        oid: 0,
        fields: [],
      });

      const status = await getSyncStatus('user-5');

      expect(status.status).toBe('idle');
      expect(status.lastSynced).toBeUndefined();
    });
  });

  // ── startSyncWorker / distributed lock ────────────────────────────────────

  describe('startSyncWorker', () => {
    it('acquires Redis lock via SET NX before running sync', async () => {
      mockRedisSet.mockResolvedValue('OK'); // Lock acquired
      vi.mocked(query).mockResolvedValue({
        rows: [],
        rowCount: 0,
        command: '',
        oid: 0,
        fields: [],
      });

      startSyncWorker(1); // 1 minute interval for fast testing

      // Advance past the interval
      await vi.advanceTimersByTimeAsync(60_000);

      // Should have called SET NX for the lock
      expect(mockRedisSet).toHaveBeenCalledWith(
        'sync:worker:lock',
        expect.any(String),
        { NX: true, EX: 600 },
      );
    });

    it('skips sync cycle when lock is already held', async () => {
      mockRedisSet.mockResolvedValue(null); // Lock NOT acquired

      startSyncWorker(1);

      await vi.advanceTimersByTimeAsync(60_000);

      // Lock attempt was made
      expect(mockRedisSet).toHaveBeenCalledWith(
        'sync:worker:lock',
        expect.any(String),
        { NX: true, EX: 600 },
      );

      // But no user query was made (sync was skipped)
      expect(vi.mocked(query)).not.toHaveBeenCalled();
    });

    it('releases lock via Lua script after sync completes', async () => {
      mockRedisSet.mockResolvedValue('OK');
      mockRedisEval.mockResolvedValue(1);
      vi.mocked(query).mockResolvedValue({
        rows: [],
        rowCount: 0,
        command: '',
        oid: 0,
        fields: [],
      });

      startSyncWorker(1);

      await vi.advanceTimersByTimeAsync(60_000);

      // Verify Lua release script was called
      expect(mockRedisEval).toHaveBeenCalledWith(
        expect.stringContaining('redis.call("get", KEYS[1]) == ARGV[1]'),
        expect.objectContaining({
          keys: ['sync:worker:lock'],
          arguments: [expect.any(String)],
        }),
      );
    });

    it('is idempotent — calling twice creates only one interval', () => {
      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

      startSyncWorker(15);
      startSyncWorker(15);

      expect(setIntervalSpy).toHaveBeenCalledOnce();
    });
  });

  // ── stopSyncWorker ────────────────────────────────────────────────────────

  describe('stopSyncWorker', () => {
    it('clears the interval so worker can be restarted', () => {
      const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

      startSyncWorker(15);
      stopSyncWorker();

      expect(clearIntervalSpy).toHaveBeenCalledOnce();

      // Can restart
      startSyncWorker(15);
      expect(setIntervalSpy).toHaveBeenCalledTimes(2);
    });
  });
});
