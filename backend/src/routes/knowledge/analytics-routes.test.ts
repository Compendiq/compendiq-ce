import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';

// --- Mock: postgres query ---
const mockQuery = vi.fn();
vi.mock('../../core/db/postgres.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

import { analyticsRoutes } from './analytics.js';

const ADMIN_USER_ID = 'admin-user-id';

// =============================================================================
// Auth + admin required
// =============================================================================

describe('Search analytics routes - auth required', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(sensible);

    app.decorate('authenticate', async () => {
      throw app.httpErrors.unauthorized('Missing token');
    });
    app.decorate('requireAdmin', async () => {
      throw app.httpErrors.forbidden('Admin required');
    });
    app.decorateRequest('userId', '');
    app.decorateRequest('userRole', '');

    await app.register(analyticsRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('should return 403 for GET /api/analytics/knowledge-gaps without admin', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/analytics/knowledge-gaps' });
    expect(res.statusCode).toBe(403);
  });

  it('should return 403 for GET /api/analytics/search-trends without admin', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/analytics/search-trends' });
    expect(res.statusCode).toBe(403);
  });
});

// =============================================================================
// Happy-path tests (admin user)
// =============================================================================

describe('Search analytics routes - admin', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(sensible);

    app.decorate('authenticate', async (request: { userId: string; userRole: string }) => {
      request.userId = ADMIN_USER_ID;
      request.userRole = 'admin';
    });
    app.decorate('requireAdmin', async (request: { userId: string; userRole: string }) => {
      request.userId = ADMIN_USER_ID;
      request.userRole = 'admin';
    });
    app.decorateRequest('userId', '');
    app.decorateRequest('userRole', '');

    await app.register(analyticsRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── GET /api/analytics/knowledge-gaps ─────────────────────────────

  it('should return knowledge gaps', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          query_text: 'kubernetes deployment',
          occurrence_count: '5',
          last_searched: new Date('2025-06-01'),
          avg_max_score: 0.1,
        },
      ],
    });

    const res = await app.inject({ method: 'GET', url: '/api/analytics/knowledge-gaps' });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.gaps).toHaveLength(1);
    expect(body.gaps[0].query).toBe('kubernetes deployment');
    expect(body.gaps[0].occurrences).toBe(5);
    expect(body.total).toBe(1);
    expect(body.periodDays).toBe(30); // default
  });

  it('should accept custom days and minOccurrences', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await app.inject({
      method: 'GET',
      url: '/api/analytics/knowledge-gaps?days=7&minOccurrences=3',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().periodDays).toBe(7);
  });

  it('should return empty gaps when no data', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await app.inject({ method: 'GET', url: '/api/analytics/knowledge-gaps' });
    expect(res.statusCode).toBe(200);
    expect(res.json().gaps).toHaveLength(0);
    expect(res.json().total).toBe(0);
  });

  // ── GET /api/analytics/search-trends ──────────────────────────────

  it('should return search trends', async () => {
    // Top queries
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          query_text: 'docker setup',
          search_count: '15',
          avg_results: '3.5',
          avg_score: 0.7,
        },
      ],
    });
    // Daily volume
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          day: '2025-06-01',
          total_searches: '42',
          zero_result_searches: '5',
        },
      ],
    });

    const res = await app.inject({ method: 'GET', url: '/api/analytics/search-trends' });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.topQueries).toHaveLength(1);
    expect(body.topQueries[0].query).toBe('docker setup');
    expect(body.topQueries[0].searchCount).toBe(15);
    expect(body.dailyVolume).toHaveLength(1);
    expect(body.dailyVolume[0].totalSearches).toBe(42);
    expect(body.periodDays).toBe(30);
  });

  it('should accept custom days param for trends', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await app.inject({
      method: 'GET',
      url: '/api/analytics/search-trends?days=14',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().periodDays).toBe(14);
  });
});
