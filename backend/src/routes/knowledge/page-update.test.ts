import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { pagesCrudRoutes } from './pages-crud.js';

const mockQuery = vi.fn();
const mockGetClientForUser = vi.fn();
const mockConfluenceToHtml = vi.fn().mockReturnValue('<p>converted</p>');
const mockHtmlToConfluence = vi.fn().mockReturnValue('<p>storage</p>');
const mockHtmlToText = vi.fn().mockReturnValue('converted');
const mockLogAuditEvent = vi.fn();

vi.mock('../../core/db/postgres.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

vi.mock('../../domains/confluence/services/sync-service.js', () => ({
  getClientForUser: (...args: unknown[]) => mockGetClientForUser(...args),
}));

const mockGetUserAccessibleSpaces = vi.fn();
vi.mock('../../core/services/rbac-service.js', () => ({
  getUserAccessibleSpaces: (...args: unknown[]) => mockGetUserAccessibleSpaces(...args),
}));

vi.mock('../../core/services/content-converter.js', () => ({
  confluenceToHtml: (...args: unknown[]) => mockConfluenceToHtml(...args),
  htmlToConfluence: (...args: unknown[]) => mockHtmlToConfluence(...args),
  htmlToText: (...args: unknown[]) => mockHtmlToText(...args),
}));

const mockCacheInvalidate = vi.fn();
const mockCacheInvalidateAcrossUsers = vi.fn();

vi.mock('../../core/services/redis-cache.js', () => ({
  RedisCache: class MockRedisCache {
    get = vi.fn().mockResolvedValue(null);
    set = vi.fn().mockResolvedValue(undefined);
    invalidate = (...args: unknown[]) => mockCacheInvalidate(...args);
    invalidateAcrossUsers = (...args: unknown[]) => mockCacheInvalidateAcrossUsers(...args);
  },
}));

vi.mock('../../domains/confluence/services/attachment-handler.js', () => ({
  cleanPageAttachments: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../core/services/audit-service.js', () => ({
  logAuditEvent: (...args: unknown[]) => mockLogAuditEvent(...args),
}));

vi.mock('../../domains/knowledge/services/duplicate-detector.js', () => ({
  findDuplicates: vi.fn().mockResolvedValue([]),
  scanAllDuplicates: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../domains/knowledge/services/auto-tagger.js', () => ({
  autoTagPage: vi.fn().mockResolvedValue({ tags: [] }),
  applyTags: vi.fn().mockResolvedValue([]),
  autoTagAllPages: vi.fn().mockResolvedValue(undefined),
  ALLOWED_TAGS: ['architecture', 'howto', 'troubleshooting'],
}));

vi.mock('../../domains/knowledge/services/version-tracker.js', () => ({
  getVersionHistory: vi.fn().mockResolvedValue([]),
  getVersion: vi.fn().mockResolvedValue(null),
  getSemanticDiff: vi.fn().mockResolvedValue(''),
  saveVersionSnapshot: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../domains/llm/services/embedding-service.js', () => ({
  processDirtyPages: vi.fn().mockResolvedValue({ processed: 0, errors: 0 }),
  isProcessingUser: vi.fn().mockResolvedValue(false),
  computePageRelationships: vi.fn().mockResolvedValue(0),
}));

vi.mock('../../core/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

describe('PUT /api/pages/:id', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(sensible);
    app.decorate('authenticate', async (request: { userId: string }) => {
      request.userId = 'user-1';
    });
    app.decorate('requireAdmin', async () => {});
    app.decorate('redis', {});
    app.decorateRequest('userId', '');

    await app.register(pagesCrudRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockConfluenceToHtml.mockReturnValue('<p>converted</p>');
    mockHtmlToConfluence.mockReturnValue('<p>storage</p>');
    mockHtmlToText.mockReturnValue('converted');
    // Default: the test user can reach the OPS space used by the Confluence fixture.
    mockGetUserAccessibleSpaces.mockResolvedValue(['OPS']);

    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('SELECT id, version, space_key')) {
        return Promise.resolve({
          rows: [{
            id: 42, version: 7, space_key: 'OPS', source: 'confluence',
            created_by_user_id: null, visibility: 'shared',
            confluence_id: 'page-1', deleted_at: null,
          }],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    mockGetClientForUser.mockResolvedValue({
      updatePage: vi.fn().mockResolvedValue({
        version: { number: 8 },
        body: { storage: { value: '<p>updated from confluence</p>' } },
      }),
    });
  });

  it('passes the cached space key back into confluenceToHtml', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/pages/page-1',
      payload: {
        title: 'Updated title',
        bodyHtml: '<p>updated body</p>',
        version: 7,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(mockConfluenceToHtml).toHaveBeenCalledWith(
      '<p>updated from confluence</p>',
      'page-1',
      'OPS',
    );
  });

  it('returns 403 and does not push to Confluence when the page is in a space the user cannot access', async () => {
    // Page lives in OPS but the user only has DEV — mirrors DELETE /pages/:id RBAC.
    mockGetUserAccessibleSpaces.mockResolvedValue(['DEV']);
    const updatePage = vi.fn();
    mockGetClientForUser.mockResolvedValue({ updatePage });

    const response = await app.inject({
      method: 'PUT',
      url: '/api/pages/page-1',
      payload: {
        title: 'Should not happen',
        bodyHtml: '<p>unauthorized edit</p>',
        version: 7,
      },
    });

    expect(response.statusCode).toBe(403);
    expect(mockGetUserAccessibleSpaces).toHaveBeenCalledWith('user-1');
    // Critical: no upstream edit must occur for an unauthorized space.
    expect(updatePage).not.toHaveBeenCalled();
  });

  // #828 — an edit changes content, so the summary/quality workers must
  // re-process the page. The workers exclude retry-exhausted 'failed' pages,
  // so if the edit path leaves a stale 'failed'/'summarized' status the page
  // keeps a stale (or absent) summary/quality forever. Both app-side edit
  // paths must reset status + retry count (mirroring the sync-service
  // convention that resets on upstream changes).
  describe('re-queues summary/quality analysis after an edit (#828)', () => {
    function findUpdatePagesCall(marker: string): string {
      const call = mockQuery.mock.calls.find(
        (c) => typeof c[0] === 'string' && (c[0] as string).includes('UPDATE pages SET') && (c[0] as string).includes(marker),
      );
      if (!call) throw new Error(`no UPDATE pages call containing ${marker}`);
      return call[0] as string;
    }

    it('resets summary + quality status on a standalone edit', async () => {
      mockQuery.mockImplementation((sql: string) => {
        if (sql.includes('SELECT id, version, space_key')) {
          return Promise.resolve({
            rows: [{
              id: 7, version: 3, space_key: 'NOTES', source: 'standalone',
              created_by_user_id: 'user-1', visibility: 'shared',
              confluence_id: null, deleted_at: null, page_type: 'page',
            }],
          });
        }
        // A matching, guarded UPDATE affects exactly one row (#926).
        if (sql.includes('UPDATE pages SET')) {
          return Promise.resolve({ rows: [], rowCount: 1 });
        }
        return Promise.resolve({ rows: [] });
      });

      const response = await app.inject({
        method: 'PUT',
        url: '/api/pages/7',
        payload: { title: 'Note', bodyHtml: '<p>note</p>', version: 3 },
      });

      expect(response.statusCode).toBe(200);
      const sql = findUpdatePagesCall('local_modified_by');
      expect(sql).toContain("summary_status = 'pending'");
      expect(sql).toContain('summary_retry_count = 0');
      expect(sql).toContain("quality_status = 'pending'");
      expect(sql).toContain('quality_retry_count = 0');
    });

    it('resets summary + quality status and stamps last_modified_at on a Confluence-push edit', async () => {
      // Default beforeEach mock resolves a Confluence-backed page (id 42).
      const response = await app.inject({
        method: 'PUT',
        url: '/api/pages/page-1',
        payload: { title: 'Updated title', bodyHtml: '<p>updated body</p>', version: 7 },
      });

      expect(response.statusCode).toBe(200);
      const sql = findUpdatePagesCall('body_storage');
      expect(sql).toContain("summary_status = 'pending'");
      expect(sql).toContain('summary_retry_count = 0');
      expect(sql).toContain("quality_status = 'pending'");
      expect(sql).toContain('quality_retry_count = 0');
      // The Confluence-push UPDATE previously omitted last_modified_at entirely,
      // so downstream last_modified_at-based change detection never fired.
      expect(sql).toContain('last_modified_at = NOW()');
    });
  });

  describe('standalone visibility change — cache invalidation', () => {
    function mockStandalonePage(visibility: 'private' | 'shared') {
      mockQuery.mockImplementation((sql: string) => {
        if (sql.includes('SELECT id, version, space_key')) {
          return Promise.resolve({
            rows: [{
              id: 7, version: 3, space_key: 'NOTES', source: 'standalone',
              created_by_user_id: 'user-1', visibility,
              confluence_id: null, deleted_at: null, page_type: 'page',
            }],
          });
        }
        // A matching, guarded UPDATE affects exactly one row (#926).
        if (sql.includes('UPDATE pages SET')) {
          return Promise.resolve({ rows: [], rowCount: 1 });
        }
        return Promise.resolve({ rows: [] });
      });
    }

    it('invalidates the pages cache across all users when the update changes visibility', async () => {
      mockStandalonePage('private');

      const response = await app.inject({
        method: 'PUT',
        url: '/api/pages/7',
        payload: { title: 'Note', bodyHtml: '<p>note</p>', version: 3, visibility: 'shared' },
      });

      expect(response.statusCode).toBe(200);
      // Other users' cached trees/lists would otherwise serve stale data
      // for up to the cache TTL after a private → shared flip (and vice versa).
      expect(mockCacheInvalidateAcrossUsers).toHaveBeenCalledWith('pages');
    });

    it('invalidates across users when a shared page is edited with the same visibility (#893)', async () => {
      // A shared page's list rows (title/snippet) are visible to every user, so
      // an edit that keeps visibility='shared' must still clear every user's
      // cache — not just the editor's — or others see the stale title for 15 min.
      mockStandalonePage('shared');

      const response = await app.inject({
        method: 'PUT',
        url: '/api/pages/7',
        payload: { title: 'Note', bodyHtml: '<p>note</p>', version: 3, visibility: 'shared' },
      });

      expect(response.statusCode).toBe(200);
      expect(mockCacheInvalidateAcrossUsers).toHaveBeenCalledWith('pages');
    });

    it('invalidates across users when a shared page is edited and the payload omits visibility (#893)', async () => {
      mockStandalonePage('shared');

      const response = await app.inject({
        method: 'PUT',
        url: '/api/pages/7',
        payload: { title: 'Note', bodyHtml: '<p>note</p>', version: 3 },
      });

      expect(response.statusCode).toBe(200);
      expect(mockCacheInvalidateAcrossUsers).toHaveBeenCalledWith('pages');
    });

    it('keeps per-user invalidation when the payload omits visibility', async () => {
      mockStandalonePage('private');

      const response = await app.inject({
        method: 'PUT',
        url: '/api/pages/7',
        payload: { title: 'Note', bodyHtml: '<p>note</p>', version: 3 },
      });

      expect(response.statusCode).toBe(200);
      expect(mockCacheInvalidateAcrossUsers).not.toHaveBeenCalled();
      expect(mockCacheInvalidate).toHaveBeenCalledWith('user-1', 'pages');
    });
  });

  // #926 — the standalone update read the current version, computed
  // newVersion = version + 1, then wrote with a bare `WHERE id = $1`. Two
  // concurrent writers that both read version N both write N+1, and the
  // slower one silently clobbers the faster one's edit (last-write-wins,
  // no 409). The JS pre-check only rejects a client that sends a STALE
  // body.version; it can't see a write that landed after the SELECT. The
  // UPDATE must carry an atomic `AND version = <read version>` guard and
  // return 409 when it matches no row.
  describe('standalone update — atomic version guard (#926)', () => {
    function mockStandalonePageWithUpdate(updateResult: { rows: unknown[]; rowCount: number }) {
      mockQuery.mockImplementation((sql: string) => {
        if (sql.includes('SELECT id, version, space_key')) {
          return Promise.resolve({
            rows: [{
              id: 7, version: 5, space_key: 'NOTES', source: 'standalone',
              created_by_user_id: 'user-1', visibility: 'private',
              confluence_id: null, deleted_at: null, page_type: 'page',
            }],
          });
        }
        if (sql.includes('UPDATE pages SET')) {
          return Promise.resolve(updateResult);
        }
        return Promise.resolve({ rows: [] });
      });
    }

    it('returns 409 when the UPDATE matches no row because a concurrent writer bumped the version', async () => {
      // A concurrent writer already advanced the row from 5 to 6, so the
      // guarded UPDATE (`AND version = 5`) matches nothing → rowCount 0.
      mockStandalonePageWithUpdate({ rows: [], rowCount: 0 });

      const response = await app.inject({
        method: 'PUT',
        url: '/api/pages/7',
        // body.version === current read version, so the JS pre-check passes
        // and only the atomic guard can catch the lost-update race.
        payload: { title: 'Note', bodyHtml: '<p>note</p>', version: 5 },
      });

      expect(response.statusCode).toBe(409);
    });

    it('locks the read version into the UPDATE WHERE clause as a bound parameter', async () => {
      mockStandalonePageWithUpdate({ rows: [], rowCount: 1 });

      await app.inject({
        method: 'PUT',
        url: '/api/pages/7',
        payload: { title: 'Note', bodyHtml: '<p>note</p>', version: 5 },
      });

      const call = mockQuery.mock.calls.find(
        (c) => typeof c[0] === 'string'
          && (c[0] as string).includes('UPDATE pages SET')
          && (c[0] as string).includes('local_modified_by'),
      );
      if (!call) throw new Error('no standalone UPDATE pages call');
      const sql = call[0] as string;
      const params = call[1] as unknown[];
      // Guard predicate present and parameterised (never string-interpolated).
      expect(sql).toMatch(/version\s*=\s*\$\d+/);
      // The bound value is the version read from the SELECT (5).
      expect(params).toContain(5);
    });
  });

  describe('Confluence-push edit — cache invalidation (#893)', () => {
    it('invalidates the pages cache across all users after a Confluence-push edit', async () => {
      // Default beforeEach mock resolves a Confluence-backed page (id 42),
      // which every user with space access can see — so its cached list rows
      // must be cleared for all users, not just the editor's.
      const response = await app.inject({
        method: 'PUT',
        url: '/api/pages/page-1',
        payload: { title: 'Updated title', bodyHtml: '<p>updated body</p>', version: 7 },
      });

      expect(response.statusCode).toBe(200);
      expect(mockCacheInvalidateAcrossUsers).toHaveBeenCalledWith('pages');
      expect(mockCacheInvalidate).not.toHaveBeenCalledWith('user-1', 'pages');
    });
  });
});
