/**
 * Webhook emit-call-site tests for sync-service (#114).
 *
 * Verifies that `emitWebhookEvent` fires `sync.completed` once per synced
 * space on the success path with the expected aggregate counters, and is NOT
 * called when the sync errors before the syncSpace finalisation block runs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { QueryResult } from 'pg';
import type { RedisClientType } from 'redis';

// ── Mocks (mirror sync-service.test.ts so the module-under-test loads) ───────

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
  addAllowedBaseUrlSilent: vi.fn(),
}));

const mockConfluenceClientInstance: Record<string, ReturnType<typeof vi.fn>> = {
  getAllSpaces: vi.fn().mockResolvedValue([]),
  getAllPagesInSpace: vi.fn().mockResolvedValue([]),
  getModifiedPages: vi.fn().mockResolvedValue([]),
  getPage: vi.fn(),
  getPageAttachments: vi.fn().mockResolvedValue({ results: [] }),
};

vi.mock('./confluence-client.js', () => ({
  ConfluenceClient: vi.fn(function (this: Record<string, ReturnType<typeof vi.fn>>) {
    Object.assign(this, mockConfluenceClientInstance);
  }),
}));

vi.mock('../../../core/services/content-converter.js', () => ({
  confluenceToHtml: vi.fn().mockReturnValue('<p>html</p>'),
  htmlToText: vi.fn().mockReturnValue('text'),
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

const mockEmitWebhookEvent = vi.fn();
vi.mock('../../../core/services/webhook-emit-hook.js', () => ({
  emitWebhookEvent: (...args: unknown[]) => mockEmitWebhookEvent(...args),
}));

const mockRedisSet = vi.fn();
const mockRedisGet = vi.fn();
const mockRedisEval = vi.fn();

let mockRedisClient: RedisClientType | null = null;

function createMockRedis() {
  return {
    get: mockRedisGet,
    set: mockRedisSet,
    del: vi.fn(),
    eval: mockRedisEval,
    exists: vi.fn(),
    scan: vi.fn(),
    incr: vi.fn(),
    expire: vi.fn(),
    setEx: vi.fn(),
    ping: vi.fn(),
  } as unknown as RedisClientType;
}

vi.mock('../../../core/services/redis-cache.js', () => ({
  getRedisClient: () => mockRedisClient,
  recordAttachmentFailure: vi.fn(),
  getAttachmentFailureCount: vi.fn().mockResolvedValue(0),
  clearAttachmentFailures: vi.fn(),
  MAX_ATTACHMENT_FAILURES: 3,
}));

// Now import the module under test
import { syncUser } from './sync-service.js';
import { query } from '../../../core/db/postgres.js';
import { getUserAccessibleSpaces } from '../../../core/services/rbac-service.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Configure mocks for a single-space full-sync run.
 *
 * @param confluencePages — pages reported by Confluence for the space
 * @param dbPages         — confluence_ids already in the local DB
 */
function setupSyncMocks(opts: {
  confluencePages: Array<{ id: string; title: string; version?: number }>;
  dbPages?: string[];
  rbacUserCount?: number;
}) {
  const { confluencePages, dbPages = [], rbacUserCount = 1 } = opts;

  mockConfluenceClientInstance.getAllSpaces.mockResolvedValue([
    { key: 'TEST', name: 'Test Space', homepage: null },
  ]);
  mockConfluenceClientInstance.getAllPagesInSpace.mockResolvedValue(
    confluencePages.map((p) => ({ id: p.id, title: p.title, status: 'current' })),
  );
  mockConfluenceClientInstance.getModifiedPages.mockResolvedValue([]);
  mockConfluenceClientInstance.getPage.mockImplementation((id: string) => {
    const summary = confluencePages.find((p) => p.id === id);
    return Promise.resolve({
      id,
      title: summary?.title ?? `Page ${id}`,
      body: { storage: { value: '<p>content</p>' } },
      version: {
        number: summary?.version ?? 1,
        when: '2025-01-01T00:00:00Z',
        by: { displayName: 'Author' },
      },
      metadata: { labels: { results: [] } },
      ancestors: [],
    });
  });
  mockConfluenceClientInstance.getPageAttachments.mockResolvedValue({ results: [] });

  vi.mocked(getUserAccessibleSpaces).mockResolvedValue(['TEST']);

  vi.mocked(query).mockImplementation(async (sql: string, _params?: unknown[]) => {
    const sqlStr = typeof sql === 'string' ? sql : '';
    const empty = { rows: [], rowCount: 0, command: '', oid: 0, fields: [] };

    if (sqlStr.includes('confluence_url') && sqlStr.includes('user_settings')) {
      return {
        rows: [{ confluence_url: 'https://confluence.test', confluence_pat: 'enc' }],
        rowCount: 1, command: '', oid: 0, fields: [],
      } as QueryResult;
    }
    if (sqlStr.includes('INSERT INTO spaces')) return empty as QueryResult;
    if (sqlStr.includes('last_synced') && sqlStr.includes('FROM spaces')) {
      // null → forces full sync (so detectDeletedPages runs)
      return { rows: [{ last_synced: null }], rowCount: 1, command: '', oid: 0, fields: [] } as QueryResult;
    }
    // syncPage: SELECT version, title, body_html, body_text FROM pages WHERE confluence_id = $1
    if (sqlStr.includes('SELECT version') && sqlStr.includes('FROM pages')) {
      return empty as QueryResult; // fresh create for every page in confluencePages
    }
    if (sqlStr.includes('INSERT INTO pages')) return empty as QueryResult;
    // detectDeletedPages: COUNT(DISTINCT principal_id)
    if (sqlStr.includes('COUNT(DISTINCT principal_id)')) {
      return {
        rows: [{ count: String(rbacUserCount) }],
        rowCount: 1, command: '', oid: 0, fields: [],
      } as QueryResult;
    }
    // detectDeletedPages: SELECT confluence_id FROM pages WHERE space_key = $1 AND deleted_at IS NULL
    if (sqlStr.includes('SELECT confluence_id FROM pages') && sqlStr.includes('deleted_at IS NULL')) {
      return {
        rows: dbPages.map((id) => ({ confluence_id: id })),
        rowCount: dbPages.length, command: '', oid: 0, fields: [],
      } as QueryResult;
    }
    // detectDeletedPages: soft-delete UPDATE
    if (sqlStr.includes('UPDATE pages SET deleted_at = NOW()')) {
      return { rows: [], rowCount: 1, command: 'UPDATE', oid: 0, fields: [] } as QueryResult;
    }
    // purgeDeletedPages: DELETE old soft-deleted
    if (sqlStr.includes('DELETE FROM pages') && sqlStr.includes('deleted_at <')) {
      return { rows: [], rowCount: 0, command: 'DELETE', oid: 0, fields: [] } as QueryResult;
    }
    if (sqlStr.includes('UPDATE spaces SET last_synced')) return empty as QueryResult;
    return empty as QueryResult;
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('sync-service webhook emit call-sites', () => {
  beforeEach(() => {
    mockRedisClient = createMockRedis();
    mockRedisSet.mockResolvedValue('OK');
    mockRedisGet.mockResolvedValue(null);
    mockRedisEval.mockResolvedValue(1);
    mockEmitWebhookEvent.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('emits sync.completed once per space with aggregate counts', async () => {
    setupSyncMocks({
      confluencePages: [
        { id: 'p1', title: 'Page 1' },
        { id: 'p2', title: 'Page 2' },
      ],
      dbPages: [], // both pages are fresh creates
    });

    await syncUser('user-1');

    const completedCalls = mockEmitWebhookEvent.mock.calls.filter(
      (c) => c[0]?.eventType === 'sync.completed',
    );
    expect(completedCalls).toHaveLength(1);

    const event = completedCalls[0]![0];
    expect(event.payload).toMatchObject({
      spaceKey: 'TEST',
      pagesCreated: 2,
      pagesUpdated: 0,
      pagesDeleted: 0,
    });
    expect(typeof event.payload.durationMs).toBe('number');
    expect(event.payload.durationMs).toBeGreaterThanOrEqual(0);
    expect(typeof event.payload.completedAt).toBe('string');
  });

  it('counts soft-deletes from detectDeletedPages in pagesDeleted', async () => {
    // DB has p1 + p2; Confluence reports only p1 → p2 must be soft-deleted.
    setupSyncMocks({
      confluencePages: [{ id: 'p1', title: 'Page 1' }],
      dbPages: ['p1', 'p2'],
    });

    await syncUser('user-1');

    const completedCalls = mockEmitWebhookEvent.mock.calls.filter(
      (c) => c[0]?.eventType === 'sync.completed',
    );
    expect(completedCalls).toHaveLength(1);

    expect(completedCalls[0]![0].payload).toMatchObject({
      spaceKey: 'TEST',
      pagesCreated: 1, // p1 was a fresh create
      pagesDeleted: 1, // p2 was soft-deleted
    });
  });

  it('does NOT emit per-page page.created/updated/deleted from sync (one event per run)', async () => {
    setupSyncMocks({
      confluencePages: [{ id: 'p1', title: 'Page 1' }],
      dbPages: ['p1', 'p2'],
    });

    await syncUser('user-1');

    // Only sync.completed should be emitted; per-page events would
    // double-fire alongside the aggregate counters.
    const types = mockEmitWebhookEvent.mock.calls.map((c) => c[0]?.eventType);
    expect(types.every((t) => t === 'sync.completed')).toBe(true);
    expect(types).not.toContain('page.created');
    expect(types).not.toContain('page.updated');
    expect(types).not.toContain('page.deleted');
  });

  it('does NOT emit sync.completed when getAllSpaces throws before syncSpace finalises', async () => {
    setupSyncMocks({ confluencePages: [] });
    mockConfluenceClientInstance.getAllSpaces.mockRejectedValue(new Error('Confluence down'));

    await expect(syncUser('user-1')).rejects.toThrow('Confluence down');

    expect(mockEmitWebhookEvent).not.toHaveBeenCalled();
  });

  it('does NOT emit sync.completed when no spaces are accessible (sync skipped)', async () => {
    setupSyncMocks({ confluencePages: [] });
    vi.mocked(getUserAccessibleSpaces).mockResolvedValue([]);

    await syncUser('user-1');

    expect(mockEmitWebhookEvent).not.toHaveBeenCalled();
  });
});
