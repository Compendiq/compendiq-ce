import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { ZodError } from 'zod';
import { pagesCrudRoutes } from './pages-crud.js';

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
  getClientForUser: vi.fn().mockResolvedValue(null),
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

vi.mock('../../core/services/rbac-service.js', () => ({
  getUserAccessibleSpaces: vi.fn().mockResolvedValue(['DEV', 'OPS']),
  invalidateRbacCache: vi.fn().mockResolvedValue(undefined),
}));

const mockQueryFn = vi.fn();
vi.mock('../../core/db/postgres.js', () => ({
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

    await app.register(pagesCrudRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return all pages with minimal fields and numeric IDs', async () => {
    // First query: local spaces lookup
    mockQueryFn.mockResolvedValueOnce({ rows: [] });
    // Second query: tree pages
    mockQueryFn.mockResolvedValueOnce({
      rows: [
        {
          id: 10,
          confluence_id: 'root-1',
          space_key: 'DEV',
          title: 'Root Page',
          parent_numeric_id: null,
          labels: ['architecture'],
          last_modified_at: new Date('2026-03-01'),
          embedding_dirty: false,
          embedding_status: 'embedded',
          embedded_at: new Date('2026-03-01'),
        },
        {
          id: 20,
          confluence_id: 'child-1',
          space_key: 'DEV',
          title: 'Child Page',
          parent_numeric_id: 10,
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
      id: '10',
      spaceKey: 'DEV',
      title: 'Root Page',
      pageType: 'page',
      parentId: null,
      labels: ['architecture'],
      lastModifiedAt: '2026-03-01T00:00:00.000Z',
      embeddingDirty: false,
      embeddingStatus: 'embedded',
      embeddedAt: '2026-03-01T00:00:00.000Z',
    });
    expect(body.items[1].parentId).toBe('10');
  });

  it('should filter by spaceKey', async () => {
    // Local spaces lookup
    mockQueryFn.mockResolvedValueOnce({ rows: [] });
    // Tree pages
    mockQueryFn.mockResolvedValueOnce({ rows: [] });

    const response = await app.inject({
      method: 'GET',
      url: '/api/pages/tree?spaceKey=DEV',
    });

    expect(response.statusCode).toBe(200);
    // Verify the SQL includes space_key filter (second query after local spaces lookup)
    const sqlArg = mockQueryFn.mock.calls[1][0] as string;
    expect(sqlArg).toContain('space_key');
    expect(mockQueryFn.mock.calls[1][1]).toContain('DEV');
  });

  it('should return empty items when no pages exist', async () => {
    // Local spaces lookup
    mockQueryFn.mockResolvedValueOnce({ rows: [] });
    // Tree pages
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

  it('should return pages with parent-child relationships using numeric IDs', async () => {
    // Local spaces lookup
    mockQueryFn.mockResolvedValueOnce({ rows: [] });
    // Tree pages
    mockQueryFn.mockResolvedValueOnce({
      rows: [
        { id: 1, confluence_id: 'root', space_key: 'DEV', title: 'Root', parent_numeric_id: null, labels: [], last_modified_at: null, embedding_dirty: true, embedding_status: 'not_embedded', embedded_at: null },
        { id: 2, confluence_id: 'child-a', space_key: 'DEV', title: 'Child A', parent_numeric_id: 1, labels: [], last_modified_at: null, embedding_dirty: true, embedding_status: 'not_embedded', embedded_at: null },
        { id: 3, confluence_id: 'child-b', space_key: 'DEV', title: 'Child B', parent_numeric_id: 1, labels: [], last_modified_at: null, embedding_dirty: true, embedding_status: 'not_embedded', embedded_at: null },
        { id: 4, confluence_id: 'grandchild', space_key: 'DEV', title: 'Grandchild', parent_numeric_id: 2, labels: [], last_modified_at: null, embedding_dirty: true, embedding_status: 'not_embedded', embedded_at: null },
      ],
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/pages/tree',
    });

    const body = JSON.parse(response.payload);
    expect(body.items).toHaveLength(4);

    const root = body.items.find((p: { id: string }) => p.id === '1');
    const childA = body.items.find((p: { id: string }) => p.id === '2');
    const grandchild = body.items.find((p: { id: string }) => p.id === '4');

    expect(root.parentId).toBeNull();
    expect(childA.parentId).toBe('1');
    expect(grandchild.parentId).toBe('2');
  });

  it('should include local space pages in the tree (#527/#528)', async () => {
    // Local spaces lookup returns a local space
    mockQueryFn.mockResolvedValueOnce({
      rows: [{ space_key: 'MY_NOTES' }],
    });
    // Tree pages (includes pages from both RBAC spaces and local spaces)
    mockQueryFn.mockResolvedValueOnce({
      rows: [
        { id: 1, confluence_id: null, space_key: 'MY_NOTES', title: 'Local Note', page_type: 'page', parent_numeric_id: null, labels: [], last_modified_at: null, embedding_dirty: false, embedding_status: 'not_embedded', embedded_at: null, embedding_error: null },
        { id: 2, confluence_id: 'conf-1', space_key: 'DEV', title: 'Dev Page', page_type: 'page', parent_numeric_id: null, labels: [], last_modified_at: null, embedding_dirty: false, embedding_status: 'not_embedded', embedded_at: null, embedding_error: null },
      ],
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/pages/tree',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    expect(body.items).toHaveLength(2);

    const spaceKeys = body.items.map((p: { spaceKey: string }) => p.spaceKey);
    expect(spaceKeys).toContain('MY_NOTES');
    expect(spaceKeys).toContain('DEV');

    // Verify the tree query received merged space keys (RBAC + local)
    const treeQueryArgs = mockQueryFn.mock.calls[1][1] as unknown[];
    const spaceKeysArg = treeQueryArgs[0] as string[];
    expect(spaceKeysArg).toContain('MY_NOTES');
    expect(spaceKeysArg).toContain('DEV');
    expect(spaceKeysArg).toContain('OPS');
  });
});
