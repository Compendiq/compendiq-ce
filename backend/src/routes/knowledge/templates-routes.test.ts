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

// --- Mock: audit ---
const mockLogAuditEvent = vi.fn().mockResolvedValue(undefined);
vi.mock('../../core/services/audit-service.js', () => ({
  logAuditEvent: (...args: unknown[]) => mockLogAuditEvent(...args),
}));

import { templateRoutes } from './templates.js';

const TEST_USER_ID = 'user-123';
const TEST_ADMIN_ID = 'admin-456';
const OTHER_USER_ID = 'other-789';

const CREATE_PAYLOAD = {
  title: 'My Template',
  description: 'A template',
  category: 'docs',
  icon: '📄',
  bodyJson: '{"type":"doc","content":[]}',
  bodyHtml: '<p>empty</p>',
};

function templateRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    title: 'My Template',
    description: 'A template',
    category: 'docs',
    icon: '📄',
    body_json: '{"type":"doc","content":[]}',
    body_html: '<p>empty</p>',
    variables: [],
    created_by: TEST_USER_ID,
    is_global: false,
    space_key: null,
    use_count: 0,
    created_at: new Date('2025-01-01'),
    updated_at: new Date('2025-01-01'),
    ...overrides,
  };
}

async function buildApp(opts: { authed: boolean; userId?: string; userRole?: 'user' | 'admin' }) {
  const app = Fastify({ logger: false });
  await app.register(sensible);

  if (!opts.authed) {
    app.decorate('authenticate', async () => {
      throw app.httpErrors.unauthorized('Missing or invalid token');
    });
  } else {
    const userId = opts.userId ?? TEST_USER_ID;
    const userRole = opts.userRole ?? 'user';
    app.decorate('authenticate', async (request: { userId: string; userRole: string }) => {
      request.userId = userId;
      request.userRole = userRole;
    });
  }
  app.decorateRequest('userId', '');
  app.decorateRequest('userRole', '');

  await app.register(templateRoutes, { prefix: '/api' });
  await app.ready();
  return app;
}

// =============================================================================
// Auth-required tests
// =============================================================================

describe('Template routes - auth required', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = await buildApp({ authed: false });
  });

  afterAll(async () => {
    await app.close();
  });

  it('should return 401 for GET /api/templates without auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/templates' });
    expect(res.statusCode).toBe(401);
  });

  it('should return 401 for GET /api/templates/:id without auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/templates/1' });
    expect(res.statusCode).toBe(401);
  });

  it('should return 401 for POST /api/templates without auth', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/templates', payload: CREATE_PAYLOAD });
    expect(res.statusCode).toBe(401);
  });

  it('should return 401 for PUT /api/templates/:id without auth', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/templates/1', payload: { title: 'X' } });
    expect(res.statusCode).toBe(401);
  });

  it('should return 401 for DELETE /api/templates/:id without auth', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/templates/1' });
    expect(res.statusCode).toBe(401);
  });
});

// =============================================================================
// Happy-path tests (authenticated user)
// =============================================================================

describe('Template routes - authenticated', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = await buildApp({ authed: true, userId: TEST_USER_ID, userRole: 'user' });
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

  // ── GET /api/templates/:id ────────────────────────────────────────────

  it('should get a visible template by id', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [templateRow()] });

    const res = await app.inject({ method: 'GET', url: '/api/templates/1' });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.id).toBe(1);
    expect(body.title).toBe('My Template');
    expect(body.bodyJson).toBe('{"type":"doc","content":[]}');
    expect(body.bodyHtml).toBe('<p>empty</p>');
    expect(body.isGlobal).toBe(false);
    expect(body.createdBy).toBe(TEST_USER_ID);
  });

  it('should return 404 for GET /api/templates/:id when not visible', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await app.inject({ method: 'GET', url: '/api/templates/999' });
    expect(res.statusCode).toBe(404);
  });

  // ── POST /api/templates ───────────────────────────────────────────────

  it('should create a personal template and force isGlobal false', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [templateRow()] });

    const res = await app.inject({
      method: 'POST',
      url: '/api/templates',
      payload: { ...CREATE_PAYLOAD, isGlobal: false },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.title).toBe('My Template');
    expect(body.isGlobal).toBe(false);

    const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(params[7]).toBe(TEST_USER_ID);
    expect(params[8]).toBe(false);

    expect(mockLogAuditEvent).toHaveBeenCalledWith(
      TEST_USER_ID,
      'TEMPLATE_CREATED',
      'template',
      '1',
      { title: 'My Template', isGlobal: false },
      expect.anything(),
    );
  });

  it('should ignore omitted isGlobal and create a personal template', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [templateRow()] });

    const res = await app.inject({
      method: 'POST',
      url: '/api/templates',
      payload: CREATE_PAYLOAD,
    });

    expect(res.statusCode).toBe(201);
    const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(params[8]).toBe(false);
  });

  it('should return 403 when a non-admin creates with isGlobal true', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/templates',
      payload: { ...CREATE_PAYLOAD, isGlobal: true },
    });

    expect(res.statusCode).toBe(403);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockLogAuditEvent).not.toHaveBeenCalled();
  });

  // ── PUT /api/templates/:id ────────────────────────────────────────────

  it('should let the owner update their template', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [templateRow()] })
      .mockResolvedValueOnce({ rows: [templateRow({ title: 'Renamed' })] });

    const res = await app.inject({
      method: 'PUT',
      url: '/api/templates/1',
      payload: { title: 'Renamed' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().title).toBe('Renamed');
    expect(mockLogAuditEvent).toHaveBeenCalledWith(
      TEST_USER_ID,
      'TEMPLATE_UPDATED',
      'template',
      '1',
      expect.objectContaining({ title: 'Renamed' }),
      expect.anything(),
    );
  });

  it('should return 403 when owner tries to set isGlobal true', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [templateRow()] });

    const res = await app.inject({
      method: 'PUT',
      url: '/api/templates/1',
      payload: { isGlobal: true },
    });

    expect(res.statusCode).toBe(403);
    expect(mockLogAuditEvent).not.toHaveBeenCalled();
  });

  it('should return 404 when another user updates a template', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [templateRow({ created_by: OTHER_USER_ID, is_global: true })],
    });

    const res = await app.inject({
      method: 'PUT',
      url: '/api/templates/1',
      payload: { title: 'Hijack' },
    });

    expect(res.statusCode).toBe(404);
    expect(mockLogAuditEvent).not.toHaveBeenCalled();
  });

  it('should return 404 when updating a missing template', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await app.inject({
      method: 'PUT',
      url: '/api/templates/999',
      payload: { title: 'Nope' },
    });

    expect(res.statusCode).toBe(404);
  });

  // ── DELETE /api/templates/:id ─────────────────────────────────────────

  it('should let the owner delete their template', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [templateRow()] })
      .mockResolvedValueOnce({ rowCount: 1 });

    const res = await app.inject({ method: 'DELETE', url: '/api/templates/1' });
    expect(res.statusCode).toBe(204);
    expect(mockLogAuditEvent).toHaveBeenCalledWith(
      TEST_USER_ID,
      'TEMPLATE_DELETED',
      'template',
      '1',
      { title: 'My Template', isGlobal: false },
      expect.anything(),
    );
  });

  it('should return 404 when another user deletes a template', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [templateRow({ created_by: OTHER_USER_ID, is_global: true })],
    });

    const res = await app.inject({ method: 'DELETE', url: '/api/templates/1' });
    expect(res.statusCode).toBe(404);
    expect(mockLogAuditEvent).not.toHaveBeenCalled();
  });

  it('should return 404 when deleting a missing template', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await app.inject({ method: 'DELETE', url: '/api/templates/999' });
    expect(res.statusCode).toBe(404);
  });

  // ── POST /api/templates/:id/use ─────────────────────────────────────

  it('should use a template and increment count', async () => {
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

// =============================================================================
// Admin tests
// =============================================================================

describe('Template routes - admin', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = await buildApp({ authed: true, userId: TEST_ADMIN_ID, userRole: 'admin' });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should create a global template', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [templateRow({ created_by: TEST_ADMIN_ID, is_global: true })],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/templates',
      payload: { ...CREATE_PAYLOAD, isGlobal: true },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().isGlobal).toBe(true);

    const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(params[7]).toBe(TEST_ADMIN_ID);
    expect(params[8]).toBe(true);

    expect(mockLogAuditEvent).toHaveBeenCalledWith(
      TEST_ADMIN_ID,
      'TEMPLATE_CREATED',
      'template',
      '1',
      { title: 'My Template', isGlobal: true },
      expect.anything(),
    );
  });

  it('should update a global template including isGlobal', async () => {
    const globalRow = templateRow({
      created_by: '00000000-0000-0000-0000-000000000000',
      is_global: true,
      title: 'Meeting Notes',
    });
    mockQuery
      .mockResolvedValueOnce({ rows: [globalRow] })
      .mockResolvedValueOnce({ rows: [{ ...globalRow, title: 'Meeting Notes v2', is_global: true }] });

    const res = await app.inject({
      method: 'PUT',
      url: '/api/templates/1',
      payload: { title: 'Meeting Notes v2', isGlobal: true },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().title).toBe('Meeting Notes v2');
    expect(mockLogAuditEvent).toHaveBeenCalledWith(
      TEST_ADMIN_ID,
      'TEMPLATE_UPDATED',
      'template',
      '1',
      expect.objectContaining({ isGlobal: true }),
      expect.anything(),
    );
  });

  it('should delete a global template', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [templateRow({
          created_by: '00000000-0000-0000-0000-000000000000',
          is_global: true,
        })],
      })
      .mockResolvedValueOnce({ rowCount: 1 });

    const res = await app.inject({ method: 'DELETE', url: '/api/templates/1' });
    expect(res.statusCode).toBe(204);
    expect(mockLogAuditEvent).toHaveBeenCalledWith(
      TEST_ADMIN_ID,
      'TEMPLATE_DELETED',
      'template',
      '1',
      { title: 'My Template', isGlobal: true },
      expect.anything(),
    );
  });
});
