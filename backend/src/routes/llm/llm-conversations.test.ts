import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { ZodError } from 'zod';

const CONV_1 = '5f0e8f9a-1b2c-4d3e-8f4a-5b6c7d8e9f0a';
const CONV_2 = '6a1f9f0b-2c3d-4e4f-9a5b-6c7d8e9f0a1b';

// --- Mock: postgres query ---
const mockQuery = vi.fn();

vi.mock('../../core/db/postgres.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  runMigrations: vi.fn(),
  closePool: vi.fn(),
}));

// --- Mock: redis-cache ---
vi.mock('../../core/services/redis-cache.js', () => ({
  RedisCache: class MockRedisCache {
    get = vi.fn().mockResolvedValue(null);
    set = vi.fn().mockResolvedValue(undefined);
    invalidate = vi.fn().mockResolvedValue(undefined);
  },
}));

// --- Mock: content-converter ---
vi.mock('../../core/services/content-converter.js', () => ({
  confluenceToHtml: vi.fn(),
  htmlToConfluence: vi.fn(),
  htmlToText: vi.fn(),
  markdownToHtml: vi.fn(),
}));

// --- Mock: sync-service ---
vi.mock('../../domains/confluence/services/sync-service.js', () => ({
  getClientForUser: vi.fn().mockResolvedValue(null),
}));

// --- Mock: audit-service ---
vi.mock('../../core/services/audit-service.js', () => ({
  logAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

// --- Mock: logger ---
vi.mock('../../core/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { llmConversationRoutes } from './llm-conversations.js';

// =============================================================================
// Test Suite 1: Auth-required tests
// =============================================================================

describe('llm-conversations routes - auth required', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(sensible);

    app.decorate('authenticate', async () => {
      throw app.httpErrors.unauthorized('Missing or invalid token');
    });
    app.decorate('requireAdmin', async () => {});
    app.decorate('redis', {});

    await app.register(llmConversationRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('should return 401 for GET /api/llm/conversations without auth', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/llm/conversations',
    });

    expect(response.statusCode).toBe(401);
  });

  it('should return 401 for GET /api/llm/conversations/:id without auth', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/llm/conversations/conv-1',
    });

    expect(response.statusCode).toBe(401);
  });

  it('should return 401 for DELETE /api/llm/conversations/:id without auth', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: '/api/llm/conversations/conv-1',
    });

    expect(response.statusCode).toBe(401);
  });

  it('should return 401 for GET /api/llm/improvements without auth', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/llm/improvements',
    });

    expect(response.statusCode).toBe(401);
  });
});

// =============================================================================
// Test Suite 2: Conversation CRUD
// =============================================================================

describe('llm-conversations routes - CRUD', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(sensible);

    app.decorate('authenticate', async () => {});
    app.decorate('requireAdmin', async () => {});
    app.decorate('redis', {});
    app.decorateRequest('userId', '');
    app.addHook('onRequest', async (request) => {
      request.userId = 'test-user-123';
    });

    // Mirror the production app's Zod error handling (ZodError → 400) — the
    // .uuid() id params (#1361) must answer 400, not 500.
    app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
      if (error instanceof ZodError) {
        return reply.status(400).send({ error: 'ValidationError', statusCode: 400 });
      }
      return reply.status(error.statusCode ?? 500).send({
        error: error.name,
        message: error.message,
        statusCode: error.statusCode ?? 500,
      });
    });

    await app.register(llmConversationRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --- GET /api/llm/conversations ---

  it('returns { items, nextCursor } with page chip data and ISO timestamps (#1361)', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { id: CONV_1, title: 'First conversation', title_source: 'question', model: 'llama3', page_ref: 42, page_title: 'Runbook',
          created_at: new Date('2026-01-01T10:00:00Z'), updated_at: new Date('2026-01-01T11:00:00Z') },
        { id: CONV_2, title: 'Second conversation', title_source: 'user', model: 'qwen3:32b', page_ref: null, page_title: null,
          created_at: new Date('2026-01-02T10:00:00Z'), updated_at: new Date('2026-01-02T12:00:00Z') },
      ],
    });
    const response = await app.inject({ method: 'GET', url: '/api/llm/conversations' });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.items).toHaveLength(2);
    expect(body.items[0]).toEqual({
      id: CONV_1, title: 'First conversation', titleSource: 'question', model: 'llama3', pageId: 42, pageTitle: 'Runbook',
      createdAt: '2026-01-01T10:00:00.000Z', updatedAt: '2026-01-01T11:00:00.000Z',
    });
    expect(body.items[1].pageId).toBeNull();
    expect(body.nextCursor).toBeNull(); // 2 rows < limit + 1
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('LEFT JOIN pages p ON p.id = c.page_ref AND p.deleted_at IS NULL');
    expect(sql).toContain("COALESCE(NULLIF(trim(c.title), ''), 'Untitled conversation')");
    expect(sql).toContain('ORDER BY c.updated_at DESC, c.id DESC');
    expect(params).toEqual(['test-user-123', null, null, 51]);
  });

  it('pages with a keyset cursor: limit + 1 rows → nextCursor, and the cursor round-trips into $2/$3', async () => {
    const rows = [0, 1, 2].map((n) => ({
      id: [CONV_1, CONV_2, '7b2a0a1c-3d4e-4f50-8b6c-7d8e9f0a1b2c'][n], title: `c${n}`, title_source: 'question', model: 'm', page_ref: null, page_title: null,
      created_at: new Date('2026-01-01T00:00:00Z'), updated_at: new Date(`2026-01-0${3 - n}T00:00:00Z`),
    }));
    mockQuery.mockResolvedValueOnce({ rows });
    const first = await app.inject({ method: 'GET', url: '/api/llm/conversations?limit=2' });
    const page1 = JSON.parse(first.body);
    expect(page1.items).toHaveLength(2);
    expect(typeof page1.nextCursor).toBe('string');

    mockQuery.mockResolvedValueOnce({ rows: [rows[2]] });
    const second = await app.inject({ method: 'GET', url: `/api/llm/conversations?limit=2&cursor=${encodeURIComponent(page1.nextCursor)}` });
    expect(second.statusCode).toBe(200);
    const [, params] = mockQuery.mock.calls[1] as [string, unknown[]];
    expect(params).toEqual(['test-user-123', '2026-01-02T00:00:00.000Z', CONV_2, 3]);
    expect(JSON.parse(second.body).nextCursor).toBeNull();
  });

  it('answers 400 for a garbage cursor and for limit > 100', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/llm/conversations?cursor=not-base64-json' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/llm/conversations?limit=101' })).statusCode).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('returns an empty page when the user has no conversations', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const response = await app.inject({ method: 'GET', url: '/api/llm/conversations' });
    expect(JSON.parse(response.body)).toEqual({ items: [], nextCursor: null });
  });

  it('answers 400 for a non-uuid id on GET and DELETE (#1361)', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/llm/conversations/conv-1' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'DELETE', url: '/api/llm/conversations/conv-1' })).statusCode).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  // --- GET /api/llm/conversations/:id ---

  it('should return a specific conversation by ID', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: CONV_1,
        model: 'llama3',
        title: 'Docker questions',
        messages: [
          { role: 'user', content: 'What is Docker?' },
          { role: 'assistant', content: 'Docker is a container platform.' },
        ],
        created_at: new Date('2026-01-01T10:00:00Z'),
      }],
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/llm/conversations/${CONV_1}`,
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.id).toBe(CONV_1);
    expect(body.model).toBe('llama3');
    expect(body.title).toBe('Docker questions');
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe('user');
    expect(body.messages[1].role).toBe('assistant');
  });

  it('should return 404 for a non-existent conversation', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const response = await app.inject({
      method: 'GET',
      url: `/api/llm/conversations/${CONV_2}`,
    });

    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.body);
    expect(body.message).toContain('Conversation not found');
  });

  // --- DELETE /api/llm/conversations/:id ---

  it('should delete a conversation and return success message', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/llm/conversations/${CONV_1}`,
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.message).toBe('Conversation deleted');

    // Verify DELETE query included user_id scope
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM llm_conversations WHERE id = $1 AND user_id = $2'),
      [CONV_1, 'test-user-123'],
    );
  });

  it('should return 200 even when deleting a non-existent conversation (idempotent)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/llm/conversations/${CONV_2}`,
    });

    // The route does not check rowCount, just deletes — idempotent
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.message).toBe('Conversation deleted');
  });

  // --- GET /api/llm/improvements ---

  it('should return improvement history for user', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 'imp-1',
          confluence_id: 'page-abc',
          improvement_type: 'grammar',
          model: 'llama3',
          status: 'completed',
          created_at: new Date('2026-01-01T10:00:00Z'),
        },
      ],
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/llm/improvements',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe('imp-1');
    expect(body[0].confluenceId).toBe('page-abc');
    expect(body[0].type).toBe('grammar');
    expect(body[0].model).toBe('llama3');
    expect(body[0].status).toBe('completed');
  });

  it('should filter improvements by pageId when provided', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const response = await app.inject({
      method: 'GET',
      url: '/api/llm/improvements?pageId=page-abc',
    });

    expect(response.statusCode).toBe(200);

    // Verify the query includes the pageId filter
    const queryCall = mockQuery.mock.calls[0];
    expect(queryCall[0]).toContain('p.confluence_id = $2');
    expect(queryCall[1]).toContain('page-abc');
  });
});
