import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { ZodError } from 'zod';
import { pagesDuplicateRoutes } from './pages-duplicates.js';

// --- Mock: duplicate-detector ---
const mockFindDuplicates = vi.fn();
const mockScanAllDuplicates = vi.fn();

vi.mock('../../domains/knowledge/services/duplicate-detector.js', () => ({
  findDuplicates: (...args: unknown[]) => mockFindDuplicates(...args),
  scanAllDuplicates: (...args: unknown[]) => mockScanAllDuplicates(...args),
}));

// --- Mock: logger ---
vi.mock('../../core/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// =============================================================================
// Test Suite 1: Auth-required tests
// =============================================================================

describe('pages-duplicates routes - auth required', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(sensible);

    app.decorate('authenticate', async () => {
      throw app.httpErrors.unauthorized('Missing or invalid token');
    });
    app.decorate('requireAdmin', async () => {});
    app.decorate('redis', {});

    await app.register(pagesDuplicateRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('should return 401 for GET /api/pages/:id/duplicates without auth', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/pages/page-1/duplicates',
    });

    expect(response.statusCode).toBe(401);
  });

  it('should return 401 for GET /api/admin/duplicates without auth', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/duplicates',
    });

    expect(response.statusCode).toBe(401);
  });
});

// =============================================================================
// Test Suite 2: Duplicate detection
// =============================================================================

describe('GET /api/pages/:id/duplicates', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(sensible);

    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof ZodError) {
        reply.status(400).send({
          error: 'ValidationError',
          message: error.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join('; '),
          statusCode: 400,
        });
        return;
      }
      reply.status(error.statusCode ?? 500).send({ error: error.message, statusCode: error.statusCode ?? 500 });
    });

    app.decorate('authenticate', async (request: { userId: string }) => {
      request.userId = 'test-user-id';
    });
    app.decorate('requireAdmin', async (request: { userId: string }) => {
      request.userId = 'test-user-id';
    });
    app.decorate('redis', {});
    app.decorateRequest('userId', '');

    await app.register(pagesDuplicateRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return duplicates for a given page', async () => {
    mockFindDuplicates.mockResolvedValueOnce([
      {
        pageId: 2,
        confluenceId: 'page-2',
        title: 'Similar Article',
        distance: 0.08,
        score: 0.92,
      },
      {
        pageId: 3,
        confluenceId: 'page-3',
        title: 'Another Similar',
        distance: 0.12,
        score: 0.88,
      },
    ]);

    const response = await app.inject({
      method: 'GET',
      url: '/api/pages/page-1/duplicates',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.pageId).toBe('page-1');
    expect(body.duplicates).toHaveLength(2);
    expect(body.duplicates[0].title).toBe('Similar Article');
    expect(body.duplicates[1].title).toBe('Another Similar');

    // Verify findDuplicates was called with correct params
    expect(mockFindDuplicates).toHaveBeenCalledWith(
      'test-user-id',
      'page-1',
      expect.objectContaining({
        distanceThreshold: 0.15,
        limit: 10,
      }),
    );
  });

  it('should return empty duplicates array when no duplicates found', async () => {
    mockFindDuplicates.mockResolvedValueOnce([]);

    const response = await app.inject({
      method: 'GET',
      url: '/api/pages/page-1/duplicates',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.pageId).toBe('page-1');
    expect(body.duplicates).toEqual([]);
  });

  it('should respect custom threshold query param', async () => {
    mockFindDuplicates.mockResolvedValueOnce([]);

    const response = await app.inject({
      method: 'GET',
      url: '/api/pages/page-1/duplicates?threshold=0.10',
    });

    expect(response.statusCode).toBe(200);
    expect(mockFindDuplicates).toHaveBeenCalledWith(
      'test-user-id',
      'page-1',
      expect.objectContaining({
        distanceThreshold: 0.10,
      }),
    );
  });

  it('should respect custom limit query param', async () => {
    mockFindDuplicates.mockResolvedValueOnce([]);

    const response = await app.inject({
      method: 'GET',
      url: '/api/pages/page-1/duplicates?limit=5',
    });

    expect(response.statusCode).toBe(200);
    expect(mockFindDuplicates).toHaveBeenCalledWith(
      'test-user-id',
      'page-1',
      expect.objectContaining({
        limit: 5,
      }),
    );
  });

  it('should cap limit at 50 even if higher value is provided', async () => {
    mockFindDuplicates.mockResolvedValueOnce([]);

    const response = await app.inject({
      method: 'GET',
      url: '/api/pages/page-1/duplicates?limit=100',
    });

    expect(response.statusCode).toBe(200);
    expect(mockFindDuplicates).toHaveBeenCalledWith(
      'test-user-id',
      'page-1',
      expect.objectContaining({
        limit: 50,
      }),
    );
  });

  it('should use default threshold when invalid value provided', async () => {
    mockFindDuplicates.mockResolvedValueOnce([]);

    const response = await app.inject({
      method: 'GET',
      url: '/api/pages/page-1/duplicates?threshold=notanumber',
    });

    expect(response.statusCode).toBe(200);
    expect(mockFindDuplicates).toHaveBeenCalledWith(
      'test-user-id',
      'page-1',
      expect.objectContaining({
        distanceThreshold: 0.15,
      }),
    );
  });

  // --- GET /api/admin/duplicates (admin endpoint) ---

  it('should return all duplicate pairs for admin scan', async () => {
    mockScanAllDuplicates.mockResolvedValueOnce([
      {
        page1Id: 'page-1',
        page1Title: 'Article A',
        page2Id: 'page-2',
        page2Title: 'Article B',
        distance: 0.05,
      },
    ]);

    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/duplicates',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.pairs).toHaveLength(1);
    expect(body.total).toBe(1);
    expect(body.pairs[0].page1Title).toBe('Article A');
  });

  it('should return empty pairs when no duplicates found across all pages', async () => {
    mockScanAllDuplicates.mockResolvedValueOnce([]);

    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/duplicates',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.pairs).toEqual([]);
    expect(body.total).toBe(0);
  });
});
