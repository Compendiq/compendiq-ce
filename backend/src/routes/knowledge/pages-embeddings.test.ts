import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { ZodError } from 'zod';

// --- Mock: redis-cache ---
vi.mock('../../core/services/redis-cache.js', () => ({
  RedisCache: class MockRedisCache {
    get = vi.fn().mockResolvedValue(null);
    set = vi.fn().mockResolvedValue(undefined);
    invalidate = vi.fn().mockResolvedValue(undefined);
  },
}));

// --- Mock: rbac-service ---
const mockGetUserAccessibleSpaces = vi.fn();
vi.mock('../../core/services/rbac-service.js', () => ({
  getUserAccessibleSpaces: (...args: unknown[]) => mockGetUserAccessibleSpaces(...args),
}));

// --- Mock: postgres query ---
const mockQueryFn = vi.fn();
vi.mock('../../core/db/postgres.js', () => ({
  query: (...args: unknown[]) => mockQueryFn(...args),
  getPool: vi.fn().mockReturnValue({}),
  runMigrations: vi.fn(),
  closePool: vi.fn(),
}));

// --- Mock: embedding-service ---
const mockComputePageRelationships = vi.fn();
vi.mock('../../domains/llm/services/embedding-service.js', () => ({
  computePageRelationships: (...args: unknown[]) => mockComputePageRelationships(...args),
}));

import { pagesEmbeddingRoutes } from './pages-embeddings.js';

// =============================================================================
// Test Suite 1: Auth-required tests
// =============================================================================

describe('pages-embeddings routes - auth required', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(sensible);

    app.decorate('authenticate', async () => {
      throw app.httpErrors.unauthorized('Missing or invalid token');
    });
    app.decorate('requireAdmin', async () => {
      throw app.httpErrors.forbidden('Admin access required');
    });
    app.decorate('redis', {});

    await app.register(pagesEmbeddingRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('should return 401 for GET /api/pages/graph without auth', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/pages/graph',
    });

    expect(response.statusCode).toBe(401);
  });

  it('should return 401 for GET /api/pages/:id/graph/local without auth', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/pages/123/graph/local',
    });

    expect(response.statusCode).toBe(401);
  });

  it('should return 401 for POST /api/pages/graph/refresh without auth', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/pages/graph/refresh',
    });

    expect(response.statusCode).toBe(401);
  });
});

// =============================================================================
// Test Suite 2: GET /api/pages/graph - knowledge graph
// =============================================================================

describe('GET /api/pages/graph', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(sensible);

    app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
      if (error instanceof ZodError) {
        return reply.status(400).send({ error: 'Validation failed' });
      }
      reply.status(error.statusCode ?? 500).send({ error: error.message });
    });

    app.decorate('authenticate', async (request: { userId: string }) => {
      request.userId = 'test-user-id';
    });
    app.decorate('requireAdmin', async (request: { userId: string; userRole: string }) => {
      request.userId = 'test-user-id';
      request.userRole = 'admin';
    });
    app.decorate('redis', {});
    app.decorateRequest('userId', '');

    await app.register(pagesEmbeddingRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUserAccessibleSpaces.mockResolvedValue(['DEV', 'OPS']);
  });

  it('should return nodes and edges for accessible spaces', async () => {
    // Mock pages query
    mockQueryFn.mockImplementation((sql: string) => {
      if (typeof sql === 'string' && sql.includes('SELECT cp.id')) {
        return {
          rows: [
            {
              id: 1,
              confluence_id: 'page-1',
              space_key: 'DEV',
              title: 'Test Page',
              labels: ['docs'],
              embedding_status: 'embedded',
              last_modified_at: new Date('2026-01-01'),
              parent_id: null,
            },
          ],
        };
      }
      if (typeof sql === 'string' && sql.includes('page_embeddings')) {
        return { rows: [{ page_id: 1, count: '5' }] };
      }
      if (typeof sql === 'string' && sql.includes('page_relationships')) {
        return { rows: [] };
      }
      return { rows: [] };
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/pages/graph',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.nodes).toHaveLength(1);
    expect(body.nodes[0].title).toBe('Test Page');
    expect(body.nodes[0].embeddingCount).toBe(5);
    expect(body.edges).toEqual([]);
  });

  it('should return empty graph when user has no accessible spaces', async () => {
    mockGetUserAccessibleSpaces.mockResolvedValue([]);

    const response = await app.inject({
      method: 'GET',
      url: '/api/pages/graph',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.nodes).toEqual([]);
    expect(body.edges).toEqual([]);
  });

  it('should filter by spaceKey query parameter', async () => {
    mockQueryFn.mockResolvedValue({ rows: [] });

    const response = await app.inject({
      method: 'GET',
      url: '/api/pages/graph?spaceKey=DEV',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.nodes).toEqual([]);
    expect(body.edges).toEqual([]);
  });
});

// =============================================================================
// Test Suite 3: POST /api/pages/graph/refresh - admin only
// =============================================================================

describe('POST /api/pages/graph/refresh', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(sensible);

    app.decorate('authenticate', async (request: { userId: string; userRole: string }) => {
      request.userId = 'admin-user';
      request.userRole = 'admin';
    });
    app.decorate('requireAdmin', async (request: { userId: string; userRole: string }) => {
      request.userId = 'admin-user';
      request.userRole = 'admin';
    });
    app.decorate('redis', {});
    app.decorateRequest('userId', '');

    await app.register(pagesEmbeddingRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should trigger relationship computation and return edge count', async () => {
    mockComputePageRelationships.mockResolvedValue(42);

    const response = await app.inject({
      method: 'POST',
      url: '/api/pages/graph/refresh',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.message).toContain('refreshed');
    expect(body.edges).toBe(42);
    expect(mockComputePageRelationships).toHaveBeenCalledOnce();
  });
});
