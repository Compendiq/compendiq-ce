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

vi.mock('../../domains/knowledge/services/auto-tagger.js', () => ({
  autoTagPage: vi.fn().mockResolvedValue({ tags: [] }),
  applyTags: vi.fn().mockResolvedValue([]),
  autoTagAllPages: vi.fn().mockResolvedValue(undefined),
  ALLOWED_TAGS: ['architecture', 'howto', 'troubleshooting'],
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

import { getClientForUser } from '../../domains/confluence/services/sync-service.js';

describe('PUT /api/pages/:id/labels', () => {
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
    mockQueryFn.mockResolvedValue({ rows: [{ labels: ['existing-tag'] }], rowCount: 1 });
  });

  it('should add labels to a page', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/pages/page-1/labels',
      payload: { addLabels: ['new-tag'] },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.labels).toContain('existing-tag');
    expect(body.labels).toContain('new-tag');
  });

  it('should remove labels from a page', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/pages/page-1/labels',
      payload: { removeLabels: ['existing-tag'] },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.labels).not.toContain('existing-tag');
  });

  it('should add and remove labels simultaneously', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/pages/page-1/labels',
      payload: { addLabels: ['new-tag'], removeLabels: ['existing-tag'] },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.labels).toContain('new-tag');
    expect(body.labels).not.toContain('existing-tag');
  });

  it('should return 400 when neither addLabels nor removeLabels provided', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/pages/page-1/labels',
      payload: {},
    });

    expect(response.statusCode).toBe(400);
  });

  it('should return 404 when page not found', async () => {
    mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const response = await app.inject({
      method: 'PUT',
      url: '/api/pages/nonexistent/labels',
      payload: { addLabels: ['tag'] },
    });

    expect(response.statusCode).toBe(404);
  });

  it('should deduplicate when adding an existing label', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/pages/page-1/labels',
      payload: { addLabels: ['existing-tag', 'new-tag'] },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    // Should only have each label once
    const occurrences = body.labels.filter((l: string) => l === 'existing-tag');
    expect(occurrences).toHaveLength(1);
  });

  it('should sync added labels to Confluence', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/pages/page-1/labels',
      payload: { addLabels: ['new-tag'] },
    });

    expect(response.statusCode).toBe(200);
    const client = await vi.mocked(getClientForUser).mock.results[0].value;
    expect(client.addLabels).toHaveBeenCalledWith('page-1', ['new-tag']);
  });

  it('should sync removed labels to Confluence', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/pages/page-1/labels',
      payload: { removeLabels: ['existing-tag'] },
    });

    expect(response.statusCode).toBe(200);
    const client = await vi.mocked(getClientForUser).mock.results[0].value;
    expect(client.removeLabel).toHaveBeenCalledWith('page-1', 'existing-tag');
  });
});
