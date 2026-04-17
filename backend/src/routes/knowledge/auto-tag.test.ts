import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { ZodError } from 'zod';
import { pagesTagRoutes } from './pages-tags.js';

// Mock external dependencies
vi.mock('../../core/services/redis-cache.js', () => {
  return {
    RedisCache: class MockRedisCache {
      get = vi.fn().mockResolvedValue(null);
      set = vi.fn().mockResolvedValue(undefined);
      invalidate = vi.fn().mockResolvedValue(undefined);
    },
  };
});

vi.mock('../../domains/confluence/services/sync-service.js', () => ({
  getClientForUser: vi.fn().mockResolvedValue({
    deletePage: vi.fn().mockResolvedValue(undefined),
    getPage: vi.fn().mockResolvedValue({
      id: 'page-1',
      title: 'Test Page',
      body: { storage: { value: '<p>content</p>' } },
      version: { number: 1 },
    }),
    addLabels: vi.fn().mockResolvedValue(undefined),
    removeLabel: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('../../core/services/content-converter.js', () => ({
  htmlToConfluence: vi.fn().mockReturnValue('<p>content</p>'),
  confluenceToHtml: vi.fn().mockReturnValue('<p>content</p>'),
  htmlToText: vi.fn().mockReturnValue('content'),
}));

vi.mock('../../domains/confluence/services/attachment-handler.js', () => ({
  cleanPageAttachments: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../core/services/audit-service.js', () => ({
  logAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../domains/knowledge/services/duplicate-detector.js', () => ({
  findDuplicates: vi.fn().mockResolvedValue([]),
  scanAllDuplicates: vi.fn().mockResolvedValue([]),
}));

const mockAutoTagPage = vi.fn();
vi.mock('../../domains/knowledge/services/auto-tagger.js', () => ({
  autoTagPage: (...args: unknown[]) => mockAutoTagPage(...args),
  applyTags: vi.fn().mockResolvedValue([]),
  autoTagAllPages: vi.fn().mockResolvedValue(undefined),
  ALLOWED_TAGS: ['architecture', 'deployment', 'troubleshooting', 'how-to', 'api', 'security', 'database', 'monitoring', 'configuration', 'onboarding', 'policy', 'runbook'],
}));

// Issue #214: route consults the auto_tag use-case resolver on every call so
// the per-use-case provider override is honored even when body supplies a
// model. Default mock returns an empty model so the pre-existing
// "should return 400 when model is missing from body" assertion still holds
// (route throws 400 when neither body nor resolver supplies a model).
const mockGetUsecaseLlmAssignment = vi.fn().mockResolvedValue({
  provider: 'ollama',
  model: '',
  source: { provider: 'default', model: 'default' },
});
vi.mock('../../core/services/admin-settings-service.js', () => ({
  getUsecaseLlmAssignment: (...args: unknown[]) => mockGetUsecaseLlmAssignment(...args),
}));

vi.mock('../../domains/knowledge/services/version-tracker.js', () => ({
  getVersionHistory: vi.fn().mockResolvedValue([]),
  getVersion: vi.fn().mockResolvedValue(null),
  getSemanticDiff: vi.fn().mockResolvedValue('no diff'),
  saveVersionSnapshot: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../core/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const mockQueryFn = vi.fn();
vi.mock('../../core/db/postgres.js', () => ({
  query: (...args: unknown[]) => mockQueryFn(...args),
  getPool: vi.fn().mockReturnValue({}),
  runMigrations: vi.fn(),
  closePool: vi.fn(),
}));

describe('POST /api/pages/:id/auto-tag', () => {
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

    app.decorate('authenticate', async (request: { userId: string; username: string; userRole: string }) => {
      request.userId = 'test-user-id';
      request.username = 'testuser';
      request.userRole = 'user';
    });
    app.decorate('requireAdmin', async (request: { userId: string; username: string; userRole: string }) => {
      request.userId = 'test-user-id';
      request.username = 'testuser';
      request.userRole = 'admin';
    });
    app.decorate('redis', {});

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

  it('should return suggested tags on success', async () => {
    mockAutoTagPage.mockResolvedValueOnce({
      suggestedTags: ['architecture', 'deployment'],
      existingLabels: ['existing'],
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/pages/page-1/auto-tag',
      payload: { model: 'qwen3:32b' },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.suggestedTags).toEqual(['architecture', 'deployment']);
    expect(body.existingLabels).toEqual(['existing']);
  });

  it('should return 404 when page is not found', async () => {
    mockAutoTagPage.mockRejectedValueOnce(new Error('Page not found: page-999'));

    const response = await app.inject({
      method: 'POST',
      url: '/api/pages/page-999/auto-tag',
      payload: { model: 'qwen3:32b' },
    });

    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.body);
    expect(body.error).toContain('not found');
  });

  it('should return 503 when LLM server is unreachable (ECONNREFUSED)', async () => {
    mockAutoTagPage.mockRejectedValueOnce(
      new Error('Auto-tag failed: connect ECONNREFUSED 127.0.0.1:11434'),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/api/pages/page-1/auto-tag',
      payload: { model: 'qwen3:32b' },
    });

    expect(response.statusCode).toBe(503);
    const body = JSON.parse(response.body);
    expect(body.error).toBe('LLM server is not reachable');
  });

  it('should return 503 when LLM fetch fails', async () => {
    mockAutoTagPage.mockRejectedValueOnce(
      new Error('Auto-tag failed: fetch failed'),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/api/pages/page-1/auto-tag',
      payload: { model: 'qwen3:32b' },
    });

    expect(response.statusCode).toBe(503);
    const body = JSON.parse(response.body);
    expect(body.error).toBe('LLM server is not reachable');
  });

  it('should return 502 with actual error message for LLM errors (#151)', async () => {
    mockAutoTagPage.mockRejectedValueOnce(
      new Error('Auto-tag failed: model "bad-model" not found'),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/api/pages/page-1/auto-tag',
      payload: { model: 'bad-model' },
    });

    expect(response.statusCode).toBe(502);
    const body = JSON.parse(response.body);
    // The real error should be surfaced, not a generic "check LLM server connection"
    expect(body.error).toBe('Auto-tagging failed: Auto-tag failed: model "bad-model" not found');
    expect(body.error).not.toContain('check LLM server connection');
  });

  it('should return 502 with actual message for timeout errors (#151)', async () => {
    mockAutoTagPage.mockRejectedValueOnce(
      new Error('Auto-tag failed: The operation was aborted due to timeout'),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/api/pages/page-1/auto-tag',
      payload: { model: 'qwen3:32b' },
    });

    expect(response.statusCode).toBe(502);
    const body = JSON.parse(response.body);
    expect(body.error).toContain('aborted due to timeout');
    expect(body.error).not.toContain('check LLM server connection');
  });

  it('should return 503 when circuit breaker is open (via error cause chain)', async () => {
    // autoTagContent wraps the original error with { cause: err },
    // so the CircuitBreakerOpenError is on err.cause, not err itself
    const cbError = new Error('ollama-chat: LLM server temporarily unavailable');
    cbError.name = 'CircuitBreakerOpenError';
    const wrappedError = new Error(
      'Auto-tag failed: ollama-chat: LLM server temporarily unavailable',
      { cause: cbError },
    );
    mockAutoTagPage.mockRejectedValueOnce(wrappedError);

    const response = await app.inject({
      method: 'POST',
      url: '/api/pages/page-1/auto-tag',
      payload: { model: 'qwen3:32b' },
    });

    expect(response.statusCode).toBe(503);
    const body = JSON.parse(response.body);
    expect(body.error).toContain('temporarily unavailable');
  });

  it('should return 400 when model is missing from body', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/pages/page-1/auto-tag',
      payload: {},
    });

    expect(response.statusCode).toBe(400);
  });
});

describe('PUT /api/pages/:id/labels (#442 — integer PK fix)', () => {
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

    app.decorate('authenticate', async (request: { userId: string; username: string; userRole: string }) => {
      request.userId = 'test-user-id';
      request.username = 'testuser';
      request.userRole = 'user';
    });
    app.decorate('requireAdmin', async (request: { userId: string; username: string; userRole: string }) => {
      request.userId = 'test-user-id';
      request.username = 'testuser';
      request.userRole = 'admin';
    });
    app.decorate('redis', {});

    await app.register(pagesTagRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should add labels using integer PK in the URL', async () => {
    // Mock SELECT query returning page with integer PK
    mockQueryFn.mockResolvedValueOnce({
      rows: [{ id: 42, confluence_id: 'conf-42', labels: ['existing'] }],
      rowCount: 1,
    });
    // Mock UPDATE query
    mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const response = await app.inject({
      method: 'PUT',
      url: '/api/pages/42/labels',
      payload: { addLabels: ['new-label'] },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.labels).toContain('existing');
    expect(body.labels).toContain('new-label');

    // Verify SELECT used integer PK (id = $1) not confluence_id
    const selectCall = mockQueryFn.mock.calls[0];
    expect(selectCall[0]).toContain('id = $1');
    expect(selectCall[1]).toEqual([42]);

    // Verify UPDATE used integer PK (WHERE id = $1)
    const updateCall = mockQueryFn.mock.calls[1];
    expect(updateCall[0]).toContain('WHERE id = $1');
    expect(updateCall[1][0]).toBe(42);
  });

  it('should work for standalone pages with no confluence_id', async () => {
    // Standalone page: confluence_id is null
    mockQueryFn.mockResolvedValueOnce({
      rows: [{ id: 99, confluence_id: null, labels: [] }],
      rowCount: 1,
    });
    // Mock UPDATE query
    mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const response = await app.inject({
      method: 'PUT',
      url: '/api/pages/99/labels',
      payload: { addLabels: ['standalone-tag'] },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.labels).toContain('standalone-tag');

    // Should NOT attempt to sync to Confluence (no confluence_id)
    const { getClientForUser: mockGetClient } = await import('../../domains/confluence/services/sync-service.js');
    expect(mockGetClient).not.toHaveBeenCalled();
  });

  it('should remove labels from a page using integer PK', async () => {
    mockQueryFn.mockResolvedValueOnce({
      rows: [{ id: 42, confluence_id: 'conf-42', labels: ['tag-a', 'tag-b'] }],
      rowCount: 1,
    });
    mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const response = await app.inject({
      method: 'PUT',
      url: '/api/pages/42/labels',
      payload: { removeLabels: ['tag-a'] },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.labels).toEqual(['tag-b']);
  });

  it('should return 404 when page not found', async () => {
    mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const response = await app.inject({
      method: 'PUT',
      url: '/api/pages/999/labels',
      payload: { addLabels: ['tag'] },
    });

    expect(response.statusCode).toBe(404);
  });

  it('should sync labels to Confluence when page has confluence_id', async () => {
    mockQueryFn.mockResolvedValueOnce({
      rows: [{ id: 42, confluence_id: 'conf-42', labels: ['existing'] }],
      rowCount: 1,
    });
    mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const response = await app.inject({
      method: 'PUT',
      url: '/api/pages/42/labels',
      payload: { addLabels: ['new-tag'], removeLabels: ['existing'] },
    });

    expect(response.statusCode).toBe(200);

    // Verify Confluence sync used confluence_id, not integer PK
    const { getClientForUser: mockGetClient } = await import('../../domains/confluence/services/sync-service.js');
    const client = await (mockGetClient as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(client.addLabels).toHaveBeenCalledWith('conf-42', ['new-tag']);
    expect(client.removeLabel).toHaveBeenCalledWith('conf-42', 'existing');
  });
});
