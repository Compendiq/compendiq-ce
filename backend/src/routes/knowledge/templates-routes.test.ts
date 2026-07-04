import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';

// --- Mock: postgres query ---
const mockQuery = vi.fn();
vi.mock('../../core/db/postgres.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

// --- Mock: logger ---
vi.mock('../../core/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { templateRoutes } from './templates.js';

// =============================================================================
// Auth-required tests
// =============================================================================

describe('Template routes - auth required', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(sensible);

    app.decorate('authenticate', async () => {
      throw app.httpErrors.unauthorized('Missing or invalid token');
    });
    app.decorateRequest('userId', '');
    app.decorateRequest('userRole', '');

    await app.register(templateRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('should return 401 for GET /api/templates without auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/templates' });
    expect(res.statusCode).toBe(401);
  });
});

// =============================================================================
// Happy-path tests (authenticated user)
// =============================================================================

describe('Template routes - authenticated', () => {
  let app: ReturnType<typeof Fastify>;
  const TEST_USER_ID = 'user-123';

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(sensible);

    app.decorate('authenticate', async (request: { userId: string; userRole: string }) => {
      request.userId = TEST_USER_ID;
      request.userRole = 'user';
    });
    app.decorateRequest('userId', '');
    app.decorateRequest('userRole', '');

    await app.register(templateRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── GET /api/templates ────────────────────────────────────────────────

  it('should list templates for user', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 1,
          title: 'My Template',
          description: 'A template',
          category: 'docs',
          icon: '📄',
          is_global: false,
          use_count: 3,
          created_by: TEST_USER_ID,
          created_at: new Date('2025-01-01'),
        },
      ],
    });

    const res = await app.inject({ method: 'GET', url: '/api/templates' });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body).toHaveLength(1);
    expect(body[0].title).toBe('My Template');
    expect(body[0].isGlobal).toBe(false);
    expect(body[0].useCount).toBe(3);
  });

  it('should filter templates by scope=global', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await app.inject({ method: 'GET', url: '/api/templates?scope=global' });
    expect(res.statusCode).toBe(200);

    // Verify query includes is_global filter
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('is_global = TRUE');
  });

  it('should filter templates by scope=mine', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await app.inject({ method: 'GET', url: '/api/templates?scope=mine' });
    expect(res.statusCode).toBe(200);

    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('created_by');
  });

  it('should filter templates by category', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await app.inject({ method: 'GET', url: '/api/templates?category=engineering' });
    expect(res.statusCode).toBe(200);

    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('category');
  });

  // ── POST /api/templates/:id/use ─────────────────────────────────────

  it('should use a template and increment count', async () => {
    // First call: find the template
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 1,
        title: 'My Template',
        body_json: '{"type":"doc"}',
        body_html: '<p>hello</p>',
        is_global: false,
        created_by: TEST_USER_ID,
      }],
    });
    // Second call: increment use_count
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    const res = await app.inject({
      method: 'POST',
      url: '/api/templates/1/use',
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.title).toBe('My Template');
    expect(body.bodyJson).toBe('{"type":"doc"}');
  });

  it('should return 404 when using non-existent template', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await app.inject({
      method: 'POST',
      url: '/api/templates/999/use',
      payload: {},
    });

    expect(res.statusCode).toBe(404);
  });
});
