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

  it('should return 401 for POST /api/templates without auth', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/templates',
      payload: { title: 'test', bodyJson: '{}', bodyHtml: '<p></p>' },
    });
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

  // ── GET /api/templates/:id ──────────────────────────────────────────

  it('should get a single template by id', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 1,
        title: 'Test',
        description: null,
        category: null,
        icon: null,
        body_json: '{"type":"doc"}',
        body_html: '<p>test</p>',
        variables: [],
        created_by: TEST_USER_ID,
        is_global: false,
        space_key: null,
        use_count: 0,
        created_at: new Date(),
        updated_at: new Date(),
      }],
    });

    const res = await app.inject({ method: 'GET', url: '/api/templates/1' });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.title).toBe('Test');
    expect(body.bodyJson).toBe('{"type":"doc"}');
  });

  it('should return 404 for non-existent template', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await app.inject({ method: 'GET', url: '/api/templates/999' });
    expect(res.statusCode).toBe(404);
  });

  it('should reject invalid id param', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/templates/-1' });
    // Zod validation error — 500 without the custom app error handler
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  // ── POST /api/templates ─────────────────────────────────────────────

  it('should create a template', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 10, created_at: new Date('2025-06-01') }],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/templates',
      payload: {
        title: 'New Template',
        bodyJson: '{"type":"doc","content":[]}',
        bodyHtml: '<p>content</p>',
        category: 'engineering',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toBe(10);
  });

  it('should reject creating global template as non-admin', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/templates',
      payload: {
        title: 'Global Attempt',
        bodyJson: '{}',
        bodyHtml: '<p></p>',
        isGlobal: true,
      },
    });

    expect(res.statusCode).toBe(403);
  });

  it('should reject template with empty title', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/templates',
      payload: {
        title: '',
        bodyJson: '{}',
        bodyHtml: '<p></p>',
      },
    });

    // Zod validation error — 500 without custom app error handler
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
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

  // ── PATCH /api/templates/:id ────────────────────────────────────────

  it('should update a template', async () => {
    // First call: check ownership
    mockQuery.mockResolvedValueOnce({ rows: [{ created_by: TEST_USER_ID }] });
    // Second call: actual update
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 1, updated_at: new Date() }] });

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/templates/1',
      payload: { title: 'Updated Title' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe(1);
  });

  it('should reject update by non-owner non-admin', async () => {
    // Template owned by someone else
    mockQuery.mockResolvedValueOnce({ rows: [{ created_by: 'other-user' }] });

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/templates/1',
      payload: { title: 'Hijack' },
    });

    expect(res.statusCode).toBe(403);
  });

  it('should return 404 when updating non-existent template', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/templates/999',
      payload: { title: 'Ghost' },
    });

    expect(res.statusCode).toBe(404);
  });

  it('should reject update with no fields', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ created_by: TEST_USER_ID }] });

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/templates/1',
      payload: {},
    });

    expect(res.statusCode).toBe(400);
  });

  it('should reject setting isGlobal as non-admin', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ created_by: TEST_USER_ID }] });

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/templates/1',
      payload: { isGlobal: true },
    });

    expect(res.statusCode).toBe(403);
  });

  // ── DELETE /api/templates/:id ───────────────────────────────────────

  it('should delete own template', async () => {
    // Check ownership
    mockQuery.mockResolvedValueOnce({ rows: [{ created_by: TEST_USER_ID }] });
    // Actual delete
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    const res = await app.inject({ method: 'DELETE', url: '/api/templates/1' });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.message).toBe('Template deleted');
  });

  it('should reject delete by non-owner non-admin', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ created_by: 'other-user' }] });

    const res = await app.inject({ method: 'DELETE', url: '/api/templates/1' });
    expect(res.statusCode).toBe(403);
  });

  it('should return 404 when deleting non-existent template', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await app.inject({ method: 'DELETE', url: '/api/templates/999' });
    expect(res.statusCode).toBe(404);
  });
});

// =============================================================================
// Admin user tests
// =============================================================================

describe('Template routes - admin user', () => {
  let app: ReturnType<typeof Fastify>;
  const ADMIN_USER_ID = 'admin-123';

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(sensible);

    app.decorate('authenticate', async (request: { userId: string; userRole: string }) => {
      request.userId = ADMIN_USER_ID;
      request.userRole = 'admin';
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

  it('should allow admin to create global template', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 20, created_at: new Date() }],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/templates',
      payload: {
        title: 'Global Template',
        bodyJson: '{}',
        bodyHtml: '<p></p>',
        isGlobal: true,
      },
    });

    expect(res.statusCode).toBe(201);
  });

  it('should allow admin to update any template', async () => {
    // Template owned by someone else
    mockQuery.mockResolvedValueOnce({ rows: [{ created_by: 'other-user' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 1, updated_at: new Date() }] });

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/templates/1',
      payload: { title: 'Admin Updated' },
    });

    expect(res.statusCode).toBe(200);
  });

  it('should allow admin to delete any template', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ created_by: 'other-user' }] });
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    const res = await app.inject({ method: 'DELETE', url: '/api/templates/1' });
    expect(res.statusCode).toBe(200);
  });

  it('should allow admin to set isGlobal flag on update', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ created_by: ADMIN_USER_ID }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 1, updated_at: new Date() }] });

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/templates/1',
      payload: { isGlobal: true },
    });

    expect(res.statusCode).toBe(200);
  });
});
