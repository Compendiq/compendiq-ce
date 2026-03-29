import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';

// --- Mock: postgres query ---
const mockQuery = vi.fn();
vi.mock('../../core/db/postgres.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

import { contentAnalyticsRoutes } from './content-analytics.js';

const TEST_USER_ID = 'user-abc';

// =============================================================================
// Auth-required tests
// =============================================================================

describe('Content analytics routes - auth required', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(sensible);

    app.decorate('authenticate', async () => {
      throw app.httpErrors.unauthorized('Missing token');
    });
    app.decorateRequest('userId', '');

    await app.register(contentAnalyticsRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('should return 401 for POST /api/pages/:id/feedback without auth', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/pages/1/feedback',
      payload: { isHelpful: true },
    });
    expect(res.statusCode).toBe(401);
  });

  it('should return 401 for GET /api/analytics/trending without auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/analytics/trending' });
    expect(res.statusCode).toBe(401);
  });
});

// =============================================================================
// Happy-path tests
// =============================================================================

describe('Content analytics routes - authenticated', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(sensible);

    app.decorate('authenticate', async (request: { userId: string }) => {
      request.userId = TEST_USER_ID;
    });
    app.decorateRequest('userId', '');

    await app.register(contentAnalyticsRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── POST /api/pages/:id/feedback ──────────────────────────────────

  it('should submit feedback', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 1 }] });

    const res = await app.inject({
      method: 'POST',
      url: '/api/pages/42/feedback',
      payload: { isHelpful: true, comment: 'Great article!' },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().id).toBe(1);
    expect(mockQuery).toHaveBeenCalledOnce();
    // Verify the upsert SQL
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('ON CONFLICT');
  });

  it('should submit negative feedback without comment', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 2 }] });

    const res = await app.inject({
      method: 'POST',
      url: '/api/pages/42/feedback',
      payload: { isHelpful: false },
    });

    expect(res.statusCode).toBe(201);
  });

  it('should reject feedback with invalid pageId', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/pages/-1/feedback',
      payload: { isHelpful: true },
    });

    // Zod validation error — 500 without custom app error handler
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('should reject feedback without isHelpful field', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/pages/1/feedback',
      payload: {},
    });

    // Zod validation error — 500 without custom app error handler
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  // ── GET /api/pages/:id/feedback ───────────────────────────────────

  it('should get feedback summary for a page', async () => {
    // Summary query
    mockQuery.mockResolvedValueOnce({
      rows: [{ helpful_count: '5', not_helpful_count: '2', total_count: '7' }],
    });
    // User vote query
    mockQuery.mockResolvedValueOnce({
      rows: [{ is_helpful: true, comment: 'Nice' }],
    });

    const res = await app.inject({ method: 'GET', url: '/api/pages/42/feedback' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.helpful).toBe(5);
    expect(body.notHelpful).toBe(2);
    expect(body.total).toBe(7);
    expect(body.userVote).toEqual({ isHelpful: true, comment: 'Nice' });
  });

  it('should return null userVote when user has not voted', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ helpful_count: '0', not_helpful_count: '0', total_count: '0' }],
    });
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await app.inject({ method: 'GET', url: '/api/pages/42/feedback' });

    expect(res.statusCode).toBe(200);
    expect(res.json().userVote).toBeNull();
  });

  // ── POST /api/pages/:id/view ──────────────────────────────────────

  it('should record a page view', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    const res = await app.inject({
      method: 'POST',
      url: '/api/pages/42/view',
      payload: {},
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().recorded).toBe(true);
  });

  it('should deduplicate views within 30 minutes', async () => {
    // Recent view found
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 1 }] });

    const res = await app.inject({
      method: 'POST',
      url: '/api/pages/42/view',
      payload: { sessionId: 'session-1' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().recorded).toBe(false);
    expect(res.json().reason).toBe('duplicate');
  });

  it('should record new view with session when no recent duplicate', async () => {
    // No recent view found
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // Insert view
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    const res = await app.inject({
      method: 'POST',
      url: '/api/pages/42/view',
      payload: { sessionId: 'session-new' },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().recorded).toBe(true);
  });

  // ── GET /api/analytics/trending ───────────────────────────────────

  it('should return trending articles', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          page_id: 1,
          view_count: '42',
          unique_viewers: '10',
          title: 'Popular Article',
          space_key: 'DEV',
          confluence_id: 'page-1',
        },
      ],
    });

    const res = await app.inject({ method: 'GET', url: '/api/analytics/trending' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.articles).toHaveLength(1);
    expect(body.articles[0].viewCount).toBe(42);
    expect(body.articles[0].uniqueViewers).toBe(10);
    expect(body.periodDays).toBe(7); // default
  });

  it('should accept custom days and limit params', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await app.inject({ method: 'GET', url: '/api/analytics/trending?days=30&limit=5' });

    expect(res.statusCode).toBe(200);
    expect(res.json().periodDays).toBe(30);
  });

  // ── GET /api/analytics/content-quality ─────────────────────────────

  it('should return content quality report', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          page_id: 1,
          confluence_id: 'page-1',
          title: 'Needs Work',
          space_key: 'DEV',
          last_modified_at: new Date('2024-01-01'),
          helpful_count: '1',
          not_helpful_count: '5',
          total_feedback: '6',
          view_count: '3',
        },
      ],
    });

    const res = await app.inject({ method: 'GET', url: '/api/analytics/content-quality' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.pages).toHaveLength(1);
    expect(body.pages[0].notHelpful).toBe(5);
    expect(body.pages[0].viewCount).toBe(3);
  });

  // ── GET /api/analytics/content-gaps ────────────────────────────────

  it('should return content gaps', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          query_text: 'kubernetes deployment',
          occurrence_count: '5',
          last_searched: new Date('2025-06-01'),
          avg_max_score: 0.15,
        },
      ],
    });

    const res = await app.inject({ method: 'GET', url: '/api/analytics/content-gaps' });

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
      url: '/api/analytics/content-gaps?days=7&minOccurrences=5',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().periodDays).toBe(7);
  });
});
