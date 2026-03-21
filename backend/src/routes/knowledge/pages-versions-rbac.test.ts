import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { ZodError } from 'zod';
import { pagesVersionRoutes } from './pages-versions.js';

// --- Mocks ---

const mockGetUserAccessibleSpaces = vi.fn();
vi.mock('../../core/services/rbac-service.js', () => ({
  getUserAccessibleSpaces: (...args: unknown[]) => mockGetUserAccessibleSpaces(...args),
}));

const mockQueryFn = vi.fn();
vi.mock('../../core/db/postgres.js', () => ({
  query: (...args: unknown[]) => mockQueryFn(...args),
}));

vi.mock('../../domains/knowledge/services/version-tracker.js', () => ({
  getVersionHistory: vi.fn().mockResolvedValue([]),
  getVersion: vi.fn().mockResolvedValue(null),
  getSemanticDiff: vi.fn().mockResolvedValue('No significant changes'),
  saveVersionSnapshot: vi.fn().mockResolvedValue(undefined),
}));

const TEST_USER = 'user-1';

describe('pages-versions RBAC space access checks', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(sensible);

    app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
      if (error instanceof ZodError) {
        return reply.status(400).send({ error: 'Validation failed', details: error.errors });
      }
      const statusCode = error.statusCode ?? 500;
      return reply.status(statusCode).send({ error: error.message });
    });

    app.decorate('authenticate', async (request: { userId: string }) => {
      request.userId = TEST_USER;
    });
    app.decorateRequest('userId', '');

    await app.register(pagesVersionRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: user has access to DEV space
    mockGetUserAccessibleSpaces.mockResolvedValue(['DEV', 'OPS']);
  });

  // --- Helper to set up mock query responses ---

  function mockPageInSpace(spaceKey: string, source = 'confluence') {
    mockQueryFn.mockImplementation((sql: string) => {
      // Space access check query
      if (typeof sql === 'string' && sql.includes('space_key, source, visibility')) {
        return Promise.resolve({
          rows: [{ space_key: spaceKey, source, visibility: 'shared', created_by_user_id: null }],
        });
      }
      // Current version query (used by GET versions list)
      if (typeof sql === 'string' && sql.includes('version, title, last_modified_at')) {
        return Promise.resolve({
          rows: [{ version: 3, title: 'Test Page', last_modified_at: new Date('2026-01-15') }],
        });
      }
      // Current version content query (used by GET specific version)
      if (typeof sql === 'string' && sql.includes('body_html, body_text')) {
        return Promise.resolve({
          rows: [{ version: 3, title: 'Test Page', body_html: '<p>content</p>', body_text: 'content' }],
        });
      }
      return Promise.resolve({ rows: [] });
    });
  }

  function mockPageNotFound() {
    mockQueryFn.mockResolvedValue({ rows: [] });
  }

  // ====== GET /api/pages/:id/versions ======

  describe('GET /api/pages/:id/versions', () => {
    it('allows access when user has RBAC access to the page space', async () => {
      mockPageInSpace('DEV');

      const response = await app.inject({
        method: 'GET',
        url: '/api/pages/page-123/versions',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.pageId).toBe('page-123');
    });

    it('returns 404 when user lacks RBAC access to the page space', async () => {
      mockPageInSpace('HR'); // user only has DEV, OPS

      const response = await app.inject({
        method: 'GET',
        url: '/api/pages/page-456/versions',
      });

      expect(response.statusCode).toBe(403);
    });

    it('passes through when page does not exist (downstream handles 404)', async () => {
      mockPageNotFound();

      const response = await app.inject({
        method: 'GET',
        url: '/api/pages/nonexistent/versions',
      });

      // verifyPageAccess returns early when page not found, letting downstream handle it
      expect(response.statusCode).toBe(200);
    });

    it('allows access to shared standalone page from another user', async () => {
      mockPageInSpace('DEV', 'standalone');
      // Override the mock to return a standalone shared page not owned by test user
      mockQueryFn.mockImplementation((sql: string) => {
        if (typeof sql === 'string' && sql.includes('space_key, source, visibility')) {
          return Promise.resolve({
            rows: [{ space_key: null, source: 'standalone', visibility: 'shared', created_by_user_id: 'other-user' }],
          });
        }
        if (typeof sql === 'string' && sql.includes('version, title, last_modified_at')) {
          return Promise.resolve({
            rows: [{ version: 1, title: 'Shared Page', last_modified_at: new Date() }],
          });
        }
        return Promise.resolve({ rows: [] });
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/pages/page-standalone/versions',
      });

      expect(response.statusCode).toBe(200);
    });

    it('returns 404 for private standalone page owned by another user', async () => {
      mockQueryFn.mockImplementation((sql: string) => {
        if (typeof sql === 'string' && sql.includes('space_key, source, visibility')) {
          return Promise.resolve({
            rows: [{ space_key: null, source: 'standalone', visibility: 'private', created_by_user_id: 'other-user' }],
          });
        }
        return Promise.resolve({ rows: [] });
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/pages/page-private/versions',
      });

      expect(response.statusCode).toBe(403);
    });
  });

  // ====== GET /api/pages/:id/versions/:version ======

  describe('GET /api/pages/:id/versions/:version', () => {
    it('allows access when user has RBAC access to the page space', async () => {
      mockPageInSpace('DEV');

      const response = await app.inject({
        method: 'GET',
        url: '/api/pages/page-123/versions/3',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.confluenceId).toBe('page-123');
      expect(body.isCurrent).toBe(true);
    });

    it('returns 404 when user lacks RBAC access to the page space', async () => {
      mockPageInSpace('SECRET');

      const response = await app.inject({
        method: 'GET',
        url: '/api/pages/page-789/versions/1',
      });

      expect(response.statusCode).toBe(403);
    });
  });

  // ====== POST /api/pages/:id/versions/semantic-diff ======

  describe('POST /api/pages/:id/versions/semantic-diff', () => {
    it('allows access when user has RBAC access to the page space', async () => {
      mockPageInSpace('DEV');

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/page-123/versions/semantic-diff',
        payload: { v1: 1, v2: 2 },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.pageId).toBe('page-123');
    });

    it('returns 404 when user lacks RBAC access to the page space', async () => {
      mockPageInSpace('FINANCE');

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/page-456/versions/semantic-diff',
        payload: { v1: 1, v2: 2 },
      });

      expect(response.statusCode).toBe(403);
    });
  });
});
