import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { ZodError } from 'zod';
import { pagesRoutes } from './pages.js';

vi.mock('../services/redis-cache.js', () => {
  return {
    RedisCache: class MockRedisCache {
      get = vi.fn().mockResolvedValue(null);
      set = vi.fn().mockResolvedValue(undefined);
      invalidate = vi.fn().mockResolvedValue(undefined);
    },
  };
});

vi.mock('../services/sync-service.js', () => ({
  getClientForUser: vi.fn().mockResolvedValue(null),
}));

vi.mock('../services/content-converter.js', () => ({
  htmlToConfluence: vi.fn().mockReturnValue('<p>content</p>'),
  confluenceToHtml: vi.fn().mockReturnValue('<p>content</p>'),
  htmlToText: vi.fn().mockReturnValue('content'),
}));

vi.mock('../services/attachment-handler.js', () => ({
  cleanPageAttachments: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/audit-service.js', () => ({
  logAuditEvent: vi.fn().mockResolvedValue(undefined),
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
  getSemanticDiff: vi.fn().mockResolvedValue('no diff'),
  saveVersionSnapshot: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const mockQueryFn = vi.fn();
vi.mock('../db/postgres.js', () => ({
  query: (...args: unknown[]) => mockQueryFn(...args),
  getPool: vi.fn().mockReturnValue({}),
  runMigrations: vi.fn(),
  closePool: vi.fn(),
}));

describe('GET /api/pages/tree', () => {
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

    await app.register(pagesRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return all pages with minimal fields', async () => {
    mockQueryFn.mockResolvedValueOnce({
      rows: [
        {
          confluence_id: 'root-1',
          space_key: 'DEV',
          title: 'Root Page',
          parent_id: null,
          labels: ['architecture'],
          last_modified_at: new Date('2026-03-01'),
          embedding_dirty: false,
          embedding_status: 'embedded',
          embedded_at: new Date('2026-03-01'),
        },
        {
          confluence_id: 'child-1',
          space_key: 'DEV',
          title: 'Child Page',
          parent_id: 'root-1',
          labels: [],
          last_modified_at: new Date('2026-03-02'),
          embedding_dirty: true,
          embedding_status: 'not_embedded',
          embedded_at: null,
        },
      ],
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/pages/tree',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    expect(body.items).toHaveLength(2);
    expect(body.total).toBe(2);
    expect(body.items[0]).toEqual({
      id: 'root-1',
      spaceKey: 'DEV',
      title: 'Root Page',
      parentId: null,
      labels: ['architecture'],
      lastModifiedAt: '2026-03-01T00:00:00.000Z',
      embeddingDirty: false,
      embeddingStatus: 'embedded',
      embeddedAt: '2026-03-01T00:00:00.000Z',
    });
    expect(body.items[1].parentId).toBe('root-1');
  });

  it('should filter by spaceKey', async () => {
    mockQueryFn.mockResolvedValueOnce({ rows: [] });

    const response = await app.inject({
      method: 'GET',
      url: '/api/pages/tree?spaceKey=DEV',
    });

    expect(response.statusCode).toBe(200);
    // Verify the SQL includes space_key filter
    const sqlArg = mockQueryFn.mock.calls[0][0] as string;
    expect(sqlArg).toContain('space_key');
    expect(mockQueryFn.mock.calls[0][1]).toContain('DEV');
  });

  it('should return empty items when no pages exist', async () => {
    mockQueryFn.mockResolvedValueOnce({ rows: [] });

    const response = await app.inject({
      method: 'GET',
      url: '/api/pages/tree',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    expect(body.items).toHaveLength(0);
    expect(body.total).toBe(0);
  });

  it('should return pages with parent-child relationships', async () => {
    mockQueryFn.mockResolvedValueOnce({
      rows: [
        { confluence_id: 'root', space_key: 'DEV', title: 'Root', parent_id: null, labels: [], last_modified_at: null, embedding_dirty: true, embedding_status: 'not_embedded', embedded_at: null },
        { confluence_id: 'child-a', space_key: 'DEV', title: 'Child A', parent_id: 'root', labels: [], last_modified_at: null, embedding_dirty: true, embedding_status: 'not_embedded', embedded_at: null },
        { confluence_id: 'child-b', space_key: 'DEV', title: 'Child B', parent_id: 'root', labels: [], last_modified_at: null, embedding_dirty: true, embedding_status: 'not_embedded', embedded_at: null },
        { confluence_id: 'grandchild', space_key: 'DEV', title: 'Grandchild', parent_id: 'child-a', labels: [], last_modified_at: null, embedding_dirty: true, embedding_status: 'not_embedded', embedded_at: null },
      ],
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/pages/tree',
    });

    const body = JSON.parse(response.payload);
    expect(body.items).toHaveLength(4);

    const root = body.items.find((p: { id: string }) => p.id === 'root');
    const childA = body.items.find((p: { id: string }) => p.id === 'child-a');
    const grandchild = body.items.find((p: { id: string }) => p.id === 'grandchild');

    expect(root.parentId).toBeNull();
    expect(childA.parentId).toBe('root');
    expect(grandchild.parentId).toBe('child-a');
  });
});
