import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { ZodError } from 'zod';
import { searchRoutes } from './search.js';

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

describe('Search Routes', () => {
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

    await app.register(searchRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /api/search', () => {
    it('should return search results with facets', async () => {
      mockQueryFn.mockImplementation((sql: string) => {
        if (typeof sql === 'string' && sql.includes('UNION ALL')) {
          return {
            rows: [
              { facet: 'space', value: 'DEV', count: '1' },
              { facet: 'space', value: 'OPS', count: '1' },
              { facet: 'author', value: 'Alice', count: '1' },
              { facet: 'author', value: 'Bob', count: '1' },
              { facet: 'tag', value: 'howto', count: '1' },
              { facet: 'tag', value: 'architecture', count: '1' },
            ],
          };
        }
        if (typeof sql === 'string' && sql.includes('COUNT(*)')) {
          return { rows: [{ count: '2' }] };
        }
        if (typeof sql === 'string' && sql.includes('ts_rank')) {
          return {
            rows: [
              {
                id: 1,
                confluence_id: 'page-1',
                title: 'Redis Guide',
                space_key: 'DEV',
                author: 'Alice',
                last_modified_at: new Date('2025-01-15'),
                labels: ['howto'],
                rank: 0.85,
                snippet: 'How to use <mark>Redis</mark> caching',
              },
              {
                id: 2,
                confluence_id: 'page-2',
                title: 'Redis Config',
                space_key: 'OPS',
                author: 'Bob',
                last_modified_at: new Date('2025-02-10'),
                labels: ['architecture'],
                rank: 0.72,
                snippet: 'Configure <mark>Redis</mark> for production',
              },
            ],
          };
        }
        return { rows: [], rowCount: 0 };
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/search?q=Redis',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.items).toHaveLength(2);
      expect(body.total).toBe(2);
      expect(body.page).toBe(1);
      expect(body.limit).toBe(20);
      expect(body.totalPages).toBe(1);
      expect(body.facets.spaces).toHaveLength(2);
      expect(body.facets.authors).toHaveLength(2);
      expect(body.facets.tags).toHaveLength(2);
      expect(body.items[0].title).toBe('Redis Guide');
      expect(body.items[0].snippet).toContain('<mark>');
    });

    it('should require query parameter', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/search',
      });

      expect(response.statusCode).toBe(400);
    });

    it('should filter by spaceKey', async () => {
      mockQueryFn.mockResolvedValue({ rows: [{ count: '0' }] });

      await app.inject({
        method: 'GET',
        url: '/api/search?q=test&spaceKey=DEV',
      });

      const countCall = mockQueryFn.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('COUNT(*)'),
      );
      expect(countCall).toBeDefined();
      expect(countCall![0] as string).toContain('cp.space_key = $');
      expect(countCall![1] as unknown[]).toContain('DEV');
    });

    it('should filter by author', async () => {
      mockQueryFn.mockResolvedValue({ rows: [{ count: '0' }] });

      await app.inject({
        method: 'GET',
        url: '/api/search?q=test&author=Alice',
      });

      const countCall = mockQueryFn.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('COUNT(*)'),
      );
      expect(countCall![0] as string).toContain('cp.author = $');
      expect(countCall![1] as unknown[]).toContain('Alice');
    });

    it('should filter by date range', async () => {
      mockQueryFn.mockResolvedValue({ rows: [{ count: '0' }] });

      await app.inject({
        method: 'GET',
        url: '/api/search?q=test&dateFrom=2025-01-01&dateTo=2025-12-31',
      });

      const countCall = mockQueryFn.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('COUNT(*)'),
      );
      expect(countCall![0] as string).toContain('cp.last_modified_at >=');
      expect(countCall![0] as string).toContain('cp.last_modified_at <=');
      expect(countCall![1] as unknown[]).toContain('2025-01-01');
      expect(countCall![1] as unknown[]).toContain('2025-12-31');
    });

    it('should filter by tags', async () => {
      mockQueryFn.mockResolvedValue({ rows: [{ count: '0' }] });

      await app.inject({
        method: 'GET',
        url: '/api/search?q=test&tags=howto,architecture',
      });

      const countCall = mockQueryFn.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('COUNT(*)'),
      );
      expect(countCall![0] as string).toContain('cp.labels @>');
      expect(countCall![1] as unknown[]).toContainEqual(['howto', 'architecture']);
    });

    it('should support sort by modified date', async () => {
      mockQueryFn.mockImplementation((sql: string) => {
        if (typeof sql === 'string' && sql.includes('COUNT(*)')) {
          return { rows: [{ count: '0' }] };
        }
        return { rows: [] };
      });

      await app.inject({
        method: 'GET',
        url: '/api/search?q=test&sort=modified',
      });

      const dataCall = mockQueryFn.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('ts_rank'),
      );
      expect(dataCall).toBeDefined();
      expect(dataCall![0] as string).toContain('cp.last_modified_at DESC');
    });

    it('should paginate results correctly', async () => {
      mockQueryFn.mockImplementation((sql: string) => {
        if (typeof sql === 'string' && sql.includes('COUNT(*)')) {
          return { rows: [{ count: '50' }] };
        }
        if (typeof sql === 'string' && sql.includes('ts_rank')) {
          return { rows: [] };
        }
        return { rows: [] };
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/search?q=test&page=2&limit=10',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.total).toBe(50);
      expect(body.page).toBe(2);
      expect(body.limit).toBe(10);
      expect(body.totalPages).toBe(5);

      // Verify OFFSET was calculated correctly (page 2 with limit 10 = offset 10)
      const dataCall = mockQueryFn.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('OFFSET'),
      );
      expect(dataCall).toBeDefined();
      const params = dataCall![1] as unknown[];
      // Last two params should be limit and offset
      expect(params[params.length - 2]).toBe(10); // limit
      expect(params[params.length - 1]).toBe(10); // offset = (2-1)*10
    });
  });

  describe('POST /api/search/log', () => {
    it('should log a search query', async () => {
      mockQueryFn.mockResolvedValue({ rows: [], rowCount: 1 });

      const response = await app.inject({
        method: 'POST',
        url: '/api/search/log',
        payload: { query: 'kubernetes deployment', resultCount: 0 },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.success).toBe(true);

      expect(mockQueryFn).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO search_analytics'),
        ['test-user-id', 'kubernetes deployment', 0],
      );
    });

    it('should reject empty query', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/search/log',
        payload: { query: '', resultCount: 0 },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('GET /api/search/suggestions', () => {
    it('should return autocomplete suggestions', async () => {
      mockQueryFn.mockResolvedValue({
        rows: [
          { query_text: 'redis caching', frequency: '15' },
          { query_text: 'redis configuration', frequency: '8' },
        ],
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/search/suggestions?q=redis',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.suggestions).toHaveLength(2);
      expect(body.suggestions[0].query).toBe('redis caching');
      expect(body.suggestions[0].frequency).toBe(15);
    });

    it('should require q parameter', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/search/suggestions',
      });

      expect(response.statusCode).toBe(400);
    });
  });
});
