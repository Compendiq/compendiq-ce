import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { pagesRoutes } from './pages.js';

const mockQuery = vi.fn();
const mockGetClientForUser = vi.fn();
const mockConfluenceToHtml = vi.fn().mockReturnValue('<p>converted</p>');
const mockHtmlToConfluence = vi.fn().mockReturnValue('<p>storage</p>');
const mockHtmlToText = vi.fn().mockReturnValue('converted');
const mockLogAuditEvent = vi.fn();

vi.mock('../db/postgres.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

vi.mock('../services/sync-service.js', () => ({
  getClientForUser: (...args: unknown[]) => mockGetClientForUser(...args),
}));

vi.mock('../services/content-converter.js', () => ({
  confluenceToHtml: (...args: unknown[]) => mockConfluenceToHtml(...args),
  htmlToConfluence: (...args: unknown[]) => mockHtmlToConfluence(...args),
  htmlToText: (...args: unknown[]) => mockHtmlToText(...args),
}));

vi.mock('../services/redis-cache.js', () => ({
  RedisCache: class MockRedisCache {
    get = vi.fn().mockResolvedValue(null);
    set = vi.fn().mockResolvedValue(undefined);
    invalidate = vi.fn().mockResolvedValue(undefined);
  },
}));

vi.mock('../services/attachment-handler.js', () => ({
  cleanPageAttachments: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/audit-service.js', () => ({
  logAuditEvent: (...args: unknown[]) => mockLogAuditEvent(...args),
}));

vi.mock('../services/duplicate-detector.js', () => ({
  findDuplicates: vi.fn().mockResolvedValue([]),
  scanAllDuplicates: vi.fn().mockResolvedValue([]),
}));

vi.mock('../services/auto-tagger.js', () => ({
  autoTagPage: vi.fn().mockResolvedValue({ tags: [] }),
  applyTags: vi.fn().mockResolvedValue([]),
  autoTagAllPages: vi.fn().mockResolvedValue(undefined),
  ALLOWED_TAGS: ['architecture', 'howto', 'troubleshooting'],
}));

vi.mock('../services/version-tracker.js', () => ({
  getVersionHistory: vi.fn().mockResolvedValue([]),
  getVersion: vi.fn().mockResolvedValue(null),
  getSemanticDiff: vi.fn().mockResolvedValue(''),
  saveVersionSnapshot: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/embedding-service.js', () => ({
  processDirtyPages: vi.fn().mockResolvedValue({ processed: 0, errors: 0 }),
  isProcessingUser: vi.fn().mockResolvedValue(false),
  computePageRelationships: vi.fn().mockResolvedValue(0),
}));

vi.mock('../utils/logger.js', () => ({
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

    await app.register(pagesRoutes, { prefix: '/api' });
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

    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('SELECT version, space_key FROM cached_pages')) {
        return Promise.resolve({ rows: [{ version: 7, space_key: 'OPS' }] });
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
});
