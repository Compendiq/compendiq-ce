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

const mockConfluenceClientInstance: Record<string, ReturnType<typeof vi.fn>> = {
  getAllSpaces: vi.fn().mockResolvedValue([]),
  getAllPagesInSpace: vi.fn().mockResolvedValue([]),
  getModifiedPages: vi.fn().mockResolvedValue([]),
  getPage: vi.fn().mockResolvedValue({ id: '', title: '', body: { storage: { value: '' } }, version: { number: 1 }, metadata: { labels: { results: [] } }, ancestors: [] }),
  getPageAttachments: vi.fn().mockResolvedValue({ results: [] }),
};

vi.mock('./confluence-client.js', () => ({
  ConfluenceClient: vi.fn(function (this: any) {
    Object.assign(this, mockConfluenceClientInstance);
  }),
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
import { getSyncStatus, setSyncStatus, startSyncWorker, stopSyncWorker, syncUser } from './sync-service.js';
import { query } from '../../../core/db/postgres.js';
import { getUserAccessibleSpaces } from '../../../core/services/rbac-service.js';
import { cleanPageAttachments } from './attachment-handler.js';
import { clearAttachmentFailures } from '../../../core/services/redis-cache.js';

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

  // ── soft-delete and restore (issue #33) ────────────────────────────────

  describe('detectDeletedPages (soft-delete)', () => {
    /**
     * Helper: set up mocks so syncUser flows through syncSpace → detectDeletedPages.
     * Uses a full sync (no last_synced) so detectDeletedPages is called.
     */
    function setupSyncMocks(opts: {
      confluencePageIds: string[];
      dbPageIds: string[];
      rbacUserCount?: number;
    }) {
      const { confluencePageIds, dbPageIds, rbacUserCount = 1 } = opts;

      // Configure the shared mock client instance
      mockConfluenceClientInstance.getAllSpaces.mockResolvedValue([{ key: 'TEST', name: 'Test Space', homepage: null }]);
      mockConfluenceClientInstance.getAllPagesInSpace.mockResolvedValue(
        confluencePageIds.map((id) => ({ id, title: `Page ${id}`, status: 'current' })),
      );
      mockConfluenceClientInstance.getModifiedPages.mockResolvedValue([]);
      mockConfluenceClientInstance.getPage.mockImplementation((id: string) =>
        Promise.resolve({
          id,
          title: `Page ${id}`,
          body: { storage: { value: '<p>content</p>' } },
          version: { number: 1, when: '2025-01-01T00:00:00Z', by: { displayName: 'Author' } },
          metadata: { labels: { results: [] } },
          ancestors: [],
        }),
      );
      mockConfluenceClientInstance.getPageAttachments.mockResolvedValue({ results: [] });

      // Mock RBAC spaces
      vi.mocked(getUserAccessibleSpaces).mockResolvedValue(['TEST']);

      // Track query calls and provide responses
      vi.mocked(query).mockImplementation(async (sql: string, params?: unknown[]) => {
        const sqlStr = typeof sql === 'string' ? sql : '';
        const emptyResult = { rows: [], rowCount: 0, command: '', oid: 0, fields: [] };

        // getClientForUser: user settings
        if (sqlStr.includes('confluence_url') && sqlStr.includes('user_settings')) {
          return {
            rows: [{ confluence_url: 'https://confluence.test', confluence_pat: 'encrypted-pat' }],
            rowCount: 1, command: '', oid: 0, fields: [],
          } as any;
        }

        // syncSpace: upsert space metadata
        if (sqlStr.includes('INSERT INTO spaces')) {
          return emptyResult as any;
        }

        // syncSpace: check last sync time (return null to force full sync)
        if (sqlStr.includes('last_synced') && sqlStr.includes('FROM spaces')) {
          return { rows: [{ last_synced: null }], rowCount: 1, command: '', oid: 0, fields: [] } as any;
        }

        // syncPage: check existing page
        if (sqlStr.includes('SELECT version') && sqlStr.includes('FROM pages')) {
          return emptyResult as any;
        }

        // syncPage: upsert page
        if (sqlStr.includes('INSERT INTO pages')) {
          return emptyResult as any;
        }

        // detectDeletedPages: RBAC user count
        if (sqlStr.includes('COUNT(DISTINCT principal_id)')) {
          return {
            rows: [{ count: String(rbacUserCount) }],
            rowCount: 1, command: '', oid: 0, fields: [],
          } as any;
        }

        // detectDeletedPages: existing pages in DB
        if (sqlStr.includes('SELECT confluence_id FROM pages') && sqlStr.includes('deleted_at IS NULL')) {
          return {
            rows: dbPageIds.map((id) => ({ confluence_id: id })),
            rowCount: dbPageIds.length, command: '', oid: 0, fields: [],
          } as any;
        }

        // detectDeletedPages: soft-delete UPDATE
        if (sqlStr.includes('UPDATE pages SET deleted_at = NOW()')) {
          return { rows: [], rowCount: 1, command: 'UPDATE', oid: 0, fields: [] } as any;
        }

        // purgeDeletedPages: DELETE old soft-deleted
        if (sqlStr.includes('DELETE FROM pages') && sqlStr.includes('deleted_at <')) {
          return { rows: [], rowCount: 0, command: 'DELETE', oid: 0, fields: [] } as any;
        }

        // syncSpace: update space timestamp
        if (sqlStr.includes('UPDATE spaces SET last_synced')) {
          return emptyResult as any;
        }

        // processDirtyPages status updates (setSyncStatus via Redis, not query)
        return emptyResult as any;
      });
    }

    it('uses UPDATE SET deleted_at instead of DELETE for stale pages', async () => {
      // DB has pages 'page-1' and 'page-2', but Confluence only returns 'page-1'
      setupSyncMocks({
        confluencePageIds: ['page-1'],
        dbPageIds: ['page-1', 'page-2'],
      });
      mockRedisSet.mockResolvedValue('OK');
      mockRedisGet.mockResolvedValue(null);

      await syncUser('user-1');

      // Verify soft-delete was called for page-2 (the missing page)
      const queryCalls = vi.mocked(query).mock.calls;
      const softDeleteCall = queryCalls.find(
        (call) => typeof call[0] === 'string' && call[0].includes('UPDATE pages SET deleted_at = NOW()'),
      );
      expect(softDeleteCall).toBeDefined();
      expect(softDeleteCall![1]).toEqual(['page-2']);

      // Verify hard DELETE was NOT called for pages
      const hardDeleteCall = queryCalls.find(
        (call) => typeof call[0] === 'string'
          && call[0].includes('DELETE FROM pages')
          && !call[0].includes('deleted_at <'),
      );
      expect(hardDeleteCall).toBeUndefined();
    });

    it('does not soft-delete pages that still exist in Confluence', async () => {
      // Both pages exist in Confluence and DB
      setupSyncMocks({
        confluencePageIds: ['page-1', 'page-2'],
        dbPageIds: ['page-1', 'page-2'],
      });
      mockRedisSet.mockResolvedValue('OK');
      mockRedisGet.mockResolvedValue(null);

      await syncUser('user-1');

      const queryCalls = vi.mocked(query).mock.calls;
      const softDeleteCall = queryCalls.find(
        (call) => typeof call[0] === 'string' && call[0].includes('UPDATE pages SET deleted_at = NOW()'),
      );
      expect(softDeleteCall).toBeUndefined();
    });

    it('calls cleanPageAttachments and clearPageFailures after soft-delete', async () => {
      setupSyncMocks({
        confluencePageIds: [],
        dbPageIds: ['page-orphan'],
      });
      mockRedisSet.mockResolvedValue('OK');
      mockRedisGet.mockResolvedValue(null);

      await syncUser('user-1');

      expect(vi.mocked(cleanPageAttachments)).toHaveBeenCalledWith('', 'page-orphan');
    });
  });

  describe('purgeDeletedPages', () => {
    it('runs DELETE for pages with deleted_at older than 30 days', async () => {
      // Configure the shared mock client instance for a minimal sync
      mockConfluenceClientInstance.getAllSpaces.mockResolvedValue([{ key: 'TEST', name: 'Test Space', homepage: null }]);
      mockConfluenceClientInstance.getAllPagesInSpace.mockResolvedValue([]);
      mockConfluenceClientInstance.getModifiedPages.mockResolvedValue([]);

      vi.mocked(getUserAccessibleSpaces).mockResolvedValue(['TEST']);
      mockRedisSet.mockResolvedValue('OK');
      mockRedisGet.mockResolvedValue(null);

      vi.mocked(query).mockImplementation(async (sql: string) => {
        const sqlStr = typeof sql === 'string' ? sql : '';
        const emptyResult = { rows: [], rowCount: 0, command: '', oid: 0, fields: [] };

        if (sqlStr.includes('confluence_url') && sqlStr.includes('user_settings')) {
          return {
            rows: [{ confluence_url: 'https://confluence.test', confluence_pat: 'encrypted-pat' }],
            rowCount: 1, command: '', oid: 0, fields: [],
          } as any;
        }
        if (sqlStr.includes('INSERT INTO spaces')) return emptyResult as any;
        if (sqlStr.includes('last_synced') && sqlStr.includes('FROM spaces')) {
          return { rows: [{ last_synced: null }], rowCount: 1, command: '', oid: 0, fields: [] } as any;
        }
        if (sqlStr.includes('COUNT(DISTINCT principal_id)')) {
          return { rows: [{ count: '1' }], rowCount: 1, command: '', oid: 0, fields: [] } as any;
        }
        if (sqlStr.includes('SELECT confluence_id FROM pages')) {
          return emptyResult as any;
        }
        if (sqlStr.includes('DELETE FROM pages') && sqlStr.includes('deleted_at <')) {
          return { rows: [], rowCount: 0, command: 'DELETE', oid: 0, fields: [] } as any;
        }
        if (sqlStr.includes('UPDATE spaces SET last_synced')) return emptyResult as any;
        return emptyResult as any;
      });

      await syncUser('user-1');

      const queryCalls = vi.mocked(query).mock.calls;
      const purgeCall = queryCalls.find(
        (call) => typeof call[0] === 'string'
          && call[0].includes('DELETE FROM pages')
          && call[0].includes("deleted_at < NOW() - INTERVAL '30 days'"),
      );
      expect(purgeCall).toBeDefined();
      expect(purgeCall![1]).toEqual(['TEST']);
    });

    it('calls cleanPageAttachments and clearPageFailures for each purged page', async () => {
      mockConfluenceClientInstance.getAllSpaces.mockResolvedValue([{ key: 'TEST', name: 'Test Space', homepage: null }]);
      mockConfluenceClientInstance.getAllPagesInSpace.mockResolvedValue([]);
      mockConfluenceClientInstance.getModifiedPages.mockResolvedValue([]);

      vi.mocked(getUserAccessibleSpaces).mockResolvedValue(['TEST']);
      mockRedisSet.mockResolvedValue('OK');
      mockRedisGet.mockResolvedValue(null);

      vi.mocked(query).mockImplementation(async (sql: string) => {
        const sqlStr = typeof sql === 'string' ? sql : '';
        const emptyResult = { rows: [], rowCount: 0, command: '', oid: 0, fields: [] };

        if (sqlStr.includes('confluence_url') && sqlStr.includes('user_settings')) {
          return {
            rows: [{ confluence_url: 'https://confluence.test', confluence_pat: 'encrypted-pat' }],
            rowCount: 1, command: '', oid: 0, fields: [],
          } as any;
        }
        if (sqlStr.includes('INSERT INTO spaces')) return emptyResult as any;
        if (sqlStr.includes('last_synced') && sqlStr.includes('FROM spaces')) {
          return { rows: [{ last_synced: null }], rowCount: 1, command: '', oid: 0, fields: [] } as any;
        }
        if (sqlStr.includes('COUNT(DISTINCT principal_id)')) {
          return { rows: [{ count: '1' }], rowCount: 1, command: '', oid: 0, fields: [] } as any;
        }
        if (sqlStr.includes('SELECT confluence_id FROM pages')) {
          return emptyResult as any;
        }
        if (sqlStr.includes('DELETE FROM pages') && sqlStr.includes('deleted_at <')) {
          return {
            rows: [{ confluence_id: 'purged-1' }, { confluence_id: 'purged-2' }],
            rowCount: 2, command: 'DELETE', oid: 0, fields: [],
          } as any;
        }
        if (sqlStr.includes('UPDATE spaces SET last_synced')) return emptyResult as any;
        return emptyResult as any;
      });

      await syncUser('user-1');

      expect(vi.mocked(cleanPageAttachments)).toHaveBeenCalledWith('', 'purged-1');
      expect(vi.mocked(cleanPageAttachments)).toHaveBeenCalledWith('', 'purged-2');
      expect(vi.mocked(clearAttachmentFailures)).toHaveBeenCalledWith(mockRedisClient, 'purged-1');
      expect(vi.mocked(clearAttachmentFailures)).toHaveBeenCalledWith(mockRedisClient, 'purged-2');
    });
  });

  describe('syncPage restore (deleted_at = NULL)', () => {
    it('sets deleted_at = NULL in the upsert ON CONFLICT clause when syncing a page', async () => {
      // Configure the shared mock client instance
      mockConfluenceClientInstance.getAllSpaces.mockResolvedValue([{ key: 'TEST', name: 'Test Space', homepage: null }]);
      mockConfluenceClientInstance.getAllPagesInSpace.mockResolvedValue([
        { id: 'restored-page', title: 'Restored', status: 'current' },
      ]);
      mockConfluenceClientInstance.getModifiedPages.mockResolvedValue([]);
      mockConfluenceClientInstance.getPage.mockResolvedValue({
        id: 'restored-page',
        title: 'Restored Page',
        body: { storage: { value: '<p>restored</p>' } },
        version: { number: 2, when: '2025-06-01T00:00:00Z', by: { displayName: 'Author' } },
        metadata: { labels: { results: [] } },
        ancestors: [],
      });
      mockConfluenceClientInstance.getPageAttachments.mockResolvedValue({ results: [] });

      vi.mocked(getUserAccessibleSpaces).mockResolvedValue(['TEST']);
      mockRedisSet.mockResolvedValue('OK');
      mockRedisGet.mockResolvedValue(null);

      vi.mocked(query).mockImplementation(async (sql: string) => {
        const sqlStr = typeof sql === 'string' ? sql : '';
        const emptyResult = { rows: [], rowCount: 0, command: '', oid: 0, fields: [] };

        if (sqlStr.includes('confluence_url') && sqlStr.includes('user_settings')) {
          return {
            rows: [{ confluence_url: 'https://confluence.test', confluence_pat: 'encrypted-pat' }],
            rowCount: 1, command: '', oid: 0, fields: [],
          } as any;
        }
        if (sqlStr.includes('INSERT INTO spaces')) return emptyResult as any;
        if (sqlStr.includes('last_synced') && sqlStr.includes('FROM spaces')) {
          return { rows: [{ last_synced: null }], rowCount: 1, command: '', oid: 0, fields: [] } as any;
        }
        // syncPage: existing page check — return no existing page so upsert is used
        if (sqlStr.includes('SELECT version') && sqlStr.includes('FROM pages')) {
          return emptyResult as any;
        }
        // syncPage: upsert with deleted_at = NULL
        if (sqlStr.includes('INSERT INTO pages')) {
          return emptyResult as any;
        }
        if (sqlStr.includes('COUNT(DISTINCT principal_id)')) {
          return { rows: [{ count: '1' }], rowCount: 1, command: '', oid: 0, fields: [] } as any;
        }
        if (sqlStr.includes('SELECT confluence_id FROM pages') && sqlStr.includes('deleted_at IS NULL')) {
          return emptyResult as any;
        }
        if (sqlStr.includes('DELETE FROM pages') && sqlStr.includes('deleted_at <')) {
          return { rows: [], rowCount: 0, command: 'DELETE', oid: 0, fields: [] } as any;
        }
        if (sqlStr.includes('UPDATE spaces SET last_synced')) return emptyResult as any;
        return emptyResult as any;
      });

      await syncUser('user-1');

      // Find the upsert query and verify it includes deleted_at = NULL
      const queryCalls = vi.mocked(query).mock.calls;
      const upsertCall = queryCalls.find(
        (call) => typeof call[0] === 'string'
          && call[0].includes('INSERT INTO pages')
          && call[0].includes('ON CONFLICT'),
      );
      expect(upsertCall).toBeDefined();
      const upsertSql = upsertCall![0] as string;
      expect(upsertSql).toContain('deleted_at = NULL');
    });
  });
});
