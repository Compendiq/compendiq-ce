import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { ZodError } from 'zod';

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

// --- Mock: version-tracker ---
const mockGetVersionHistory = vi.fn();
const mockGetVersion = vi.fn();
const mockGetSemanticDiff = vi.fn();
const mockSaveVersionSnapshot = vi.fn();
vi.mock('../../domains/knowledge/services/version-tracker.js', () => ({
  getVersionHistory: (...args: unknown[]) => mockGetVersionHistory(...args),
  getVersion: (...args: unknown[]) => mockGetVersion(...args),
  getSemanticDiff: (...args: unknown[]) => mockGetSemanticDiff(...args),
  saveVersionSnapshot: (...args: unknown[]) => mockSaveVersionSnapshot(...args),
}));

import { pagesVersionRoutes } from './pages-versions.js';

const TEST_USER = 'test-user-id';

// =============================================================================
// Test Suite 1: Auth required
// =============================================================================

describe('pages-versions routes - auth required', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(sensible);

    app.decorate('authenticate', async () => {
      throw app.httpErrors.unauthorized('Missing or invalid token');
    });
    app.decorate('redis', {});

    await app.register(pagesVersionRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('should return 401 for GET /api/pages/:id/versions without auth', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/pages/page-1/versions',
    });

    expect(response.statusCode).toBe(401);
  });

  it('should return 401 for GET /api/pages/:id/versions/:version without auth', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/pages/page-1/versions/1',
    });

    expect(response.statusCode).toBe(401);
  });

  it('should return 401 for POST /api/pages/:id/versions/semantic-diff without auth', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/pages/page-1/versions/semantic-diff',
      payload: { v1: 1, v2: 2 },
    });

    expect(response.statusCode).toBe(401);
  });
});

// =============================================================================
// Test Suite 2: GET /api/pages/:id/versions - version history
// =============================================================================

describe('GET /api/pages/:id/versions', () => {
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
      request.userId = TEST_USER;
    });
    app.decorate('redis', {});
    app.decorateRequest('userId', '');

    await app.register(pagesVersionRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUserAccessibleSpaces.mockResolvedValue(['DEV', 'OPS']);
  });

  /** Mock verifyPageAccess to allow access (confluence page in DEV space) */
  function mockPageAccessible() {
    mockQueryFn.mockImplementation((sql: string) => {
      if (typeof sql === 'string' && sql.includes('space_key, source, visibility')) {
        return Promise.resolve({
          rows: [{ space_key: 'DEV', source: 'confluence', visibility: 'shared', created_by_user_id: null }],
        });
      }
      if (typeof sql === 'string' && sql.includes('version, title, last_modified_at')) {
        return Promise.resolve({
          rows: [{ version: 5, title: 'Test Article', last_modified_at: new Date('2026-03-01') }],
        });
      }
      return Promise.resolve({ rows: [] });
    });
  }

  it('should return version history with current version included', async () => {
    mockPageAccessible();
    mockGetVersionHistory.mockResolvedValue([
      { versionNumber: 4, title: 'Test Article v4', syncedAt: new Date('2026-02-15') },
      { versionNumber: 3, title: 'Test Article v3', syncedAt: new Date('2026-02-01') },
    ]);

    const response = await app.inject({
      method: 'GET',
      url: '/api/pages/page-1/versions',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.pageId).toBe('page-1');
    // Current version (5) + 2 historical versions
    expect(body.versions).toHaveLength(3);
    expect(body.versions[0].isCurrent).toBe(true);
    expect(body.versions[0].versionNumber).toBe(5);
    expect(body.versions[1].isCurrent).toBe(false);
  });

  it('should return RBAC forbidden for page in inaccessible space', async () => {
    mockQueryFn.mockImplementation((sql: string) => {
      if (typeof sql === 'string' && sql.includes('space_key, source, visibility')) {
        return Promise.resolve({
          rows: [{ space_key: 'HR', source: 'confluence', visibility: 'shared', created_by_user_id: null }],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/pages/restricted-page/versions',
    });

    expect(response.statusCode).toBe(403);
  });

  it('should allow access to own private standalone page', async () => {
    mockQueryFn.mockImplementation((sql: string) => {
      if (typeof sql === 'string' && sql.includes('space_key, source, visibility')) {
        return Promise.resolve({
          rows: [{ space_key: null, source: 'standalone', visibility: 'private', created_by_user_id: TEST_USER }],
        });
      }
      if (typeof sql === 'string' && sql.includes('version, title, last_modified_at')) {
        return Promise.resolve({
          rows: [{ version: 1, title: 'My Private Page', last_modified_at: new Date() }],
        });
      }
      return Promise.resolve({ rows: [] });
    });
    mockGetVersionHistory.mockResolvedValue([]);

    const response = await app.inject({
      method: 'GET',
      url: '/api/pages/my-page/versions',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.versions).toHaveLength(1);
    expect(body.versions[0].isCurrent).toBe(true);
  });
});

// =============================================================================
// Test Suite 3: GET /api/pages/:id/versions/:version - specific version
// =============================================================================

describe('GET /api/pages/:id/versions/:version', () => {
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
      request.userId = TEST_USER;
    });
    app.decorate('redis', {});
    app.decorateRequest('userId', '');

    await app.register(pagesVersionRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUserAccessibleSpaces.mockResolvedValue(['DEV']);
  });

  it('should return current version when version number matches', async () => {
    mockQueryFn.mockImplementation((sql: string) => {
      if (typeof sql === 'string' && sql.includes('space_key, source, visibility')) {
        return Promise.resolve({
          rows: [{ space_key: 'DEV', source: 'confluence', visibility: 'shared', created_by_user_id: null }],
        });
      }
      if (typeof sql === 'string' && sql.includes('body_html, body_text')) {
        return Promise.resolve({
          rows: [{ version: 3, title: 'Test Page', body_html: '<p>current</p>', body_text: 'current' }],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/pages/page-1/versions/3',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.isCurrent).toBe(true);
    expect(body.versionNumber).toBe(3);
    expect(body.bodyHtml).toBe('<p>current</p>');
  });

  it('should return historical version from version tracker', async () => {
    mockQueryFn.mockImplementation((sql: string) => {
      if (typeof sql === 'string' && sql.includes('space_key, source, visibility')) {
        return Promise.resolve({
          rows: [{ space_key: 'DEV', source: 'confluence', visibility: 'shared', created_by_user_id: null }],
        });
      }
      if (typeof sql === 'string' && sql.includes('body_html, body_text')) {
        return Promise.resolve({
          rows: [{ version: 5, title: 'Test Page', body_html: '<p>v5</p>', body_text: 'v5' }],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    mockGetVersion.mockResolvedValue({
      confluenceId: 'page-1',
      versionNumber: 2,
      title: 'Test Page v2',
      bodyHtml: '<p>old version</p>',
      bodyText: 'old version',
      syncedAt: new Date('2026-01-15'),
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/pages/page-1/versions/2',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.isCurrent).toBe(false);
    expect(body.versionNumber).toBe(2);
    expect(body.title).toBe('Test Page v2');
  });

  it('should return 404 when version does not exist', async () => {
    mockQueryFn.mockImplementation((sql: string) => {
      if (typeof sql === 'string' && sql.includes('space_key, source, visibility')) {
        return Promise.resolve({
          rows: [{ space_key: 'DEV', source: 'confluence', visibility: 'shared', created_by_user_id: null }],
        });
      }
      if (typeof sql === 'string' && sql.includes('body_html, body_text')) {
        return Promise.resolve({
          rows: [{ version: 5, title: 'Test Page', body_html: '<p>v5</p>', body_text: 'v5' }],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    mockGetVersion.mockResolvedValue(null);

    const response = await app.inject({
      method: 'GET',
      url: '/api/pages/page-1/versions/99',
    });

    expect(response.statusCode).toBe(404);
  });
});

// =============================================================================
// Test Suite 4: POST /api/pages/:id/versions/semantic-diff
// =============================================================================

describe('POST /api/pages/:id/versions/semantic-diff', () => {
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
      request.userId = TEST_USER;
    });
    app.decorate('redis', {});
    app.decorateRequest('userId', '');

    await app.register(pagesVersionRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUserAccessibleSpaces.mockResolvedValue(['DEV']);
  });

  it('should return semantic diff between two versions', async () => {
    mockQueryFn.mockImplementation((sql: string) => {
      if (typeof sql === 'string' && sql.includes('space_key, source, visibility')) {
        return Promise.resolve({
          rows: [{ space_key: 'DEV', source: 'confluence', visibility: 'shared', created_by_user_id: null }],
        });
      }
      if (typeof sql === 'string' && sql.includes('body_html, body_text')) {
        return Promise.resolve({
          rows: [{ version: 3, title: 'Page', body_html: '<p>v3</p>', body_text: 'v3' }],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    mockSaveVersionSnapshot.mockResolvedValue(undefined);
    mockGetSemanticDiff.mockResolvedValue('Section A was updated with new guidelines.');

    const response = await app.inject({
      method: 'POST',
      url: '/api/pages/page-1/versions/semantic-diff',
      payload: { v1: 1, v2: 2 },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.diff).toContain('updated');
    expect(body.v1).toBe(1);
    expect(body.v2).toBe(2);
    expect(body.pageId).toBe('page-1');
  });

  it('should return 400 when version numbers are missing', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/pages/page-1/versions/semantic-diff',
      payload: {},
    });

    expect(response.statusCode).toBe(400);
  });
});
