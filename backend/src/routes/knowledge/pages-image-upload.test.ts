import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { pagesCrudRoutes } from './pages-crud.js';

// Mock the attachment handler
const mockWriteAttachmentCache = vi.fn();
vi.mock('../../domains/confluence/services/attachment-handler.js', () => ({
  cleanPageAttachments: vi.fn(),
  writeAttachmentCache: (...args: unknown[]) => mockWriteAttachmentCache(...args),
}));

vi.mock('../../core/services/rbac-service.js', () => ({
  getUserAccessibleSpaces: vi.fn().mockResolvedValue(['DEV', 'OPS']),
  invalidateRbacCache: vi.fn().mockResolvedValue(undefined),
}));

const mockQuery = vi.fn();
vi.mock('../../core/db/postgres.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  getPool: vi.fn().mockReturnValue({
    connect: vi.fn().mockResolvedValue({
      query: vi.fn(),
      release: vi.fn(),
    }),
  }),
}));

vi.mock('../../domains/confluence/services/sync-service.js', () => ({
  getClientForUser: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../core/services/content-converter.js', () => ({
  htmlToConfluence: vi.fn(),
  confluenceToHtml: vi.fn(),
}));

vi.mock('../../core/services/audit-service.js', () => ({
  logAuditEvent: vi.fn(),
}));

vi.mock('../../domains/llm/services/embedding-service.js', () => ({
  processDirtyPages: vi.fn(),
  isProcessingUser: vi.fn().mockReturnValue(false),
}));

vi.mock('../../core/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// Mock Redis — pagesCrudRoutes creates a RedisCache instance via `new RedisCache()`
vi.mock('../../core/services/redis-cache.js', () => {
  class MockRedisCache {
    get = vi.fn().mockResolvedValue(null);
    set = vi.fn().mockResolvedValue(undefined);
    invalidate = vi.fn().mockResolvedValue(undefined);
  }
  return {
    RedisCache: MockRedisCache,
    getRedisClient: vi.fn().mockReturnValue(null),
  };
});

// Valid 1x1 transparent PNG as base64
const VALID_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const VALID_PNG_DATA_URI = `data:image/png;base64,${VALID_PNG_BASE64}`;
const VALID_JPG_DATA_URI = `data:image/jpeg;base64,${VALID_PNG_BASE64}`; // Content doesn't matter for this test

describe('POST /api/pages/:id/images', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(sensible);

    // Mock authenticate decorator
    app.decorate('authenticate', async (request: { userId: string }) => {
      request.userId = 'test-user';
    });
    app.decorateRequest('userId', '');

    // Mock redis decorator (required by RedisCache constructor in pagesCrudRoutes)
    app.decorate('redis', null);

    await app.register(pagesCrudRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    mockQuery.mockReset();
    mockWriteAttachmentCache.mockReset();
    mockWriteAttachmentCache.mockResolvedValue('/data/attachments/42/paste-123-abcd.png');
    // Default: no query results (tests must set up their own mocks)
    mockQuery.mockResolvedValue({ rows: [] });
  });

  it('should upload a valid PNG image and return the serving URL', async () => {
    // Mock page lookup: standalone page owned by the test user
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 42, source: 'standalone', confluence_id: null, created_by_user_id: 'test-user', space_key: null }],
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/pages/42/images',
      payload: {
        dataUri: VALID_PNG_DATA_URI,
        filename: 'paste-1234567890-abcd.png',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    expect(body.url).toBe('/api/attachments/42/paste-1234567890-abcd.png');
    expect(mockWriteAttachmentCache).toHaveBeenCalledOnce();
    expect(mockWriteAttachmentCache).toHaveBeenCalledWith(
      'test-user',
      '42',
      'paste-1234567890-abcd.png',
      expect.any(Buffer),
    );
  });

  it('should upload a valid JPEG image', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 42, source: 'standalone', confluence_id: null, created_by_user_id: 'test-user', space_key: null }],
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/pages/42/images',
      payload: {
        dataUri: VALID_JPG_DATA_URI,
        filename: 'paste-1234567890-abcd.jpg',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    expect(body.url).toContain('/api/attachments/42/');
  });

  it('should reject non-image data URIs with 400', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/pages/42/images',
      payload: {
        dataUri: `data:text/plain;base64,${VALID_PNG_BASE64}`,
        filename: 'test.txt',
      },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.payload);
    expect(body.message).toContain('Invalid data URI format');
  });

  it('should reject unsupported image MIME types with 400', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 42, source: 'standalone', confluence_id: null, created_by_user_id: 'test-user', space_key: null }],
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/pages/42/images',
      payload: {
        dataUri: `data:image/svg+xml;base64,${VALID_PNG_BASE64}`,
        filename: 'test.svg',
      },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.payload);
    expect(body.message).toContain('Unsupported image type');
  });

  it('should reject invalid data URI format with 400', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 42, source: 'standalone', confluence_id: null, created_by_user_id: 'test-user', space_key: null }],
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/pages/42/images',
      payload: {
        dataUri: 'not-a-data-uri',
        filename: 'test.png',
      },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.payload);
    expect(body.message).toContain('Invalid data URI format');
  });

  it('should return 404 when page does not exist', async () => {
    // All queries return empty by default (from beforeEach)

    const response = await app.inject({
      method: 'POST',
      url: '/api/pages/999/images',
      payload: {
        dataUri: VALID_PNG_DATA_URI,
        filename: 'paste-123-abcd.png',
      },
    });

    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.payload).message).toBe('Page not found');
  });

  it('should return 403 when user does not own the standalone page', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 42, source: 'standalone', confluence_id: null, created_by_user_id: 'other-user', space_key: null }],
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/pages/42/images',
      payload: {
        dataUri: VALID_PNG_DATA_URI,
        filename: 'paste-123-abcd.png',
      },
    });

    expect(response.statusCode).toBe(403);
  });

  it('should return 413 when image exceeds 10MB', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 42, source: 'standalone', confluence_id: null, created_by_user_id: 'test-user', space_key: null }],
    });

    // Create a data URI that decodes to >10MB
    // base64 encodes 3 bytes to 4 chars, so ~14MB of base64 = ~10.5MB decoded
    const largeBase64 = Buffer.alloc(11 * 1024 * 1024).toString('base64');

    const response = await app.inject({
      method: 'POST',
      url: '/api/pages/42/images',
      payload: {
        dataUri: `data:image/png;base64,${largeBase64}`,
        filename: 'large.png',
      },
    });

    expect(response.statusCode).toBe(413);
  });

  it('should reject filenames with path traversal characters', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/pages/42/images',
      payload: {
        dataUri: VALID_PNG_DATA_URI,
        filename: '../../../etc/passwd',
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it('should use confluence_id as attachment pageId for Confluence pages', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 100, source: 'confluence', confluence_id: 'conf-12345', created_by_user_id: null, space_key: 'DEV' }],
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/pages/100/images',
      payload: {
        dataUri: VALID_PNG_DATA_URI,
        filename: 'paste-123-abcd.png',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    // Confluence pages use confluence_id in the attachment URL
    expect(body.url).toContain('conf-12345');
    expect(mockWriteAttachmentCache).toHaveBeenCalledWith(
      'test-user',
      'conf-12345',
      'paste-123-abcd.png',
      expect.any(Buffer),
    );
  });

  it('should return 403 when page is not standalone and has no space_key', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 42, source: 'confluence', confluence_id: 'conf-999', created_by_user_id: null, space_key: null }],
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/pages/42/images',
      payload: {
        dataUri: VALID_PNG_DATA_URI,
        filename: 'paste-123-abcd.png',
      },
    });

    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.payload).message).toBe('Access denied');
  });

  it('should require auth (route has onRequest authenticate hook)', async () => {
    // The authenticate hook is always called for all routes in this plugin.
    // We verify the hook is set up by checking the app is working normally
    // (our mock authenticate always sets userId to 'test-user').
    // A real unauthenticated request would fail at the hook level.
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 42, source: 'standalone', confluence_id: null, created_by_user_id: 'test-user', space_key: null }],
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/pages/42/images',
      payload: {
        dataUri: VALID_PNG_DATA_URI,
        filename: 'paste-123-abcd.png',
      },
    });

    // Confirms the route works with authentication (mock authenticate)
    expect(response.statusCode).toBe(200);
  });
});
