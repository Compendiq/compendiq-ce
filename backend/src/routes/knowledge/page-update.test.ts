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

    it('keeps per-user invalidation when the payload sends the same visibility', async () => {
      mockStandalonePage('shared');

      const response = await app.inject({
        method: 'PUT',
        url: '/api/pages/7',
        payload: { title: 'Note', bodyHtml: '<p>note</p>', version: 3, visibility: 'shared' },
      });

      expect(response.statusCode).toBe(200);
      expect(mockCacheInvalidateAcrossUsers).not.toHaveBeenCalled();
      expect(mockCacheInvalidate).toHaveBeenCalledWith('user-1', 'pages');
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
});
