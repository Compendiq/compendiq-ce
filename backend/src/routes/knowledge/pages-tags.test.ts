import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { ZodError } from 'zod';
import { pagesTagRoutes } from './pages-tags.js';

// --- Mock: redis-cache ---
vi.mock('../../core/services/redis-cache.js', () => ({
  RedisCache: class MockRedisCache {
    get = vi.fn().mockResolvedValue(null);
    set = vi.fn().mockResolvedValue(undefined);
    invalidate = vi.fn().mockResolvedValue(undefined);
  },
}));

// --- Mock: sync-service ---
vi.mock('../../domains/confluence/services/sync-service.js', () => ({
  getClientForUser: vi.fn().mockResolvedValue({
    addLabels: vi.fn().mockResolvedValue(undefined),
    removeLabel: vi.fn().mockResolvedValue(undefined),
  }),
}));

// --- Mock: auto-tagger ---
const mockAutoTagPage = vi.fn();
const mockApplyTags = vi.fn();

vi.mock('../../domains/knowledge/services/auto-tagger.js', () => ({
  autoTagPage: (...args: unknown[]) => mockAutoTagPage(...args),
  applyTags: (...args: unknown[]) => mockApplyTags(...args),
  autoTagAllPages: vi.fn().mockResolvedValue(undefined),
  ALLOWED_TAGS: ['architecture', 'deployment', 'troubleshooting', 'how-to', 'api', 'security', 'database', 'monitoring', 'configuration', 'onboarding', 'policy', 'runbook'],
}));

// --- Mock: logger ---
vi.mock('../../core/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// --- Mock: postgres query ---
const mockQueryFn = vi.fn();
vi.mock('../../core/db/postgres.js', () => ({
  query: (...args: unknown[]) => mockQueryFn(...args),
  getPool: vi.fn().mockReturnValue({}),
  runMigrations: vi.fn(),
  closePool: vi.fn(),
}));

// =============================================================================
// Test Suite 1: Auth-required tests
// =============================================================================

describe('pages-tags routes - auth required', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(sensible);

    app.decorate('authenticate', async () => {
      throw app.httpErrors.unauthorized('Missing or invalid token');
    });
    app.decorate('requireAdmin', async () => {});
    app.decorate('redis', {});

    await app.register(pagesTagRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('should return 401 for POST /api/pages/:id/auto-tag without auth', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/pages/page-1/auto-tag',
      payload: { model: 'llama3' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('should return 401 for POST /api/pages/:id/apply-tags without auth', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/pages/page-1/apply-tags',
      payload: { tags: ['architecture'] },
    });

    expect(response.statusCode).toBe(401);
  });

  it('should return 401 for PUT /api/pages/:id/labels without auth', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/pages/page-1/labels',
      payload: { addLabels: ['test'] },
    });

    expect(response.statusCode).toBe(401);
  });
});

// =============================================================================
// Test Suite 2: apply-tags endpoint
// =============================================================================

describe('POST /api/pages/:id/apply-tags', () => {
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
    app.decorate('requireAdmin', async () => {});
    app.decorate('redis', {});
    app.decorateRequest('userId', '');

    await app.register(pagesTagRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockQueryFn.mockResolvedValue({ rows: [{ id: 1, confluence_id: 'conf-1', labels: ['existing'] }], rowCount: 1 });
  });

  it('should apply valid tags and return merged labels', async () => {
    mockApplyTags.mockResolvedValueOnce(['existing', 'architecture', 'deployment']);

    const response = await app.inject({
      method: 'POST',
      url: '/api/pages/page-1/apply-tags',
      payload: { tags: ['architecture', 'deployment'] },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.labels).toEqual(['existing', 'architecture', 'deployment']);
    expect(mockApplyTags).toHaveBeenCalledWith('test-user-id', 'page-1', ['architecture', 'deployment']);
  });

  it('should reject tags not in ALLOWED_TAGS list', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/pages/page-1/apply-tags',
      payload: { tags: ['invalid-tag', 'not-a-real-tag'] },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error).toContain('No valid tags');
  });

  it('should filter and apply only valid tags when mixed', async () => {
    mockApplyTags.mockResolvedValueOnce(['architecture']);

    const response = await app.inject({
      method: 'POST',
      url: '/api/pages/page-1/apply-tags',
      payload: { tags: ['architecture', 'invalid-tag'] },
    });

    expect(response.statusCode).toBe(200);
    // Only 'architecture' should be passed (the valid one)
    expect(mockApplyTags).toHaveBeenCalledWith('test-user-id', 'page-1', ['architecture']);
  });

  it('should return 400 when tags array is empty', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/pages/page-1/apply-tags',
      payload: { tags: [] },
    });

    expect(response.statusCode).toBe(400);
  });

  it('should return 400 when tags field is missing', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/pages/page-1/apply-tags',
      payload: {},
    });

    expect(response.statusCode).toBe(400);
  });
});

// =============================================================================
// Test Suite 3: PUT /api/pages/:id/labels (add/remove)
// =============================================================================

describe('PUT /api/pages/:id/labels - tag CRUD', () => {
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
    app.decorate('requireAdmin', async () => {});
    app.decorate('redis', {});
    app.decorateRequest('userId', '');

    await app.register(pagesTagRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should add a tag to a page', async () => {
    mockQueryFn.mockResolvedValueOnce({
      rows: [{ id: 10, confluence_id: null, labels: ['existing'] }],
    });
    mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const response = await app.inject({
      method: 'PUT',
      url: '/api/pages/10/labels',
      payload: { addLabels: ['new-tag'] },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.labels).toContain('existing');
    expect(body.labels).toContain('new-tag');
  });

  it('should remove a tag from a page', async () => {
    mockQueryFn.mockResolvedValueOnce({
      rows: [{ id: 10, confluence_id: null, labels: ['tag-a', 'tag-b'] }],
    });
    mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const response = await app.inject({
      method: 'PUT',
      url: '/api/pages/10/labels',
      payload: { removeLabels: ['tag-a'] },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.labels).toEqual(['tag-b']);
  });

  it('should return 404 when page is not found', async () => {
    mockQueryFn.mockResolvedValueOnce({ rows: [] });

    const response = await app.inject({
      method: 'PUT',
      url: '/api/pages/999/labels',
      payload: { addLabels: ['tag'] },
    });

    expect(response.statusCode).toBe(404);
  });

  it('should return 400 when neither addLabels nor removeLabels provided', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/pages/10/labels',
      payload: {},
    });

    expect(response.statusCode).toBe(400);
  });

  it('should deduplicate when adding an existing label', async () => {
    mockQueryFn.mockResolvedValueOnce({
      rows: [{ id: 10, confluence_id: null, labels: ['existing'] }],
    });
    mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const response = await app.inject({
      method: 'PUT',
      url: '/api/pages/10/labels',
      payload: { addLabels: ['existing', 'new'] },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    const existingCount = body.labels.filter((l: string) => l === 'existing');
    expect(existingCount).toHaveLength(1);
    expect(body.labels).toContain('new');
  });
});
