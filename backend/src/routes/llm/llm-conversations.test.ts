import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';

// --- Mock: postgres query ---
const mockQuery = vi.fn();

vi.mock('../../core/db/postgres.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  runMigrations: vi.fn(),
  closePool: vi.fn(),
}));

// --- Mock: ollama-service ---
vi.mock('../../domains/llm/services/ollama-service.js', () => ({
  listModels: vi.fn(),
  checkHealth: vi.fn(),
  streamChat: vi.fn(),
  chat: vi.fn(),
  getSystemPrompt: vi.fn().mockReturnValue('system prompt'),
  generateEmbedding: vi.fn(),
  ChatMessage: {},
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

  it('should return a list of conversations', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 'conv-1',
          model: 'llama3',
          title: 'First conversation',
          created_at: new Date('2026-01-01T10:00:00Z'),
          updated_at: new Date('2026-01-01T11:00:00Z'),
        },
        {
          id: 'conv-2',
          model: 'qwen3:32b',
          title: 'Second conversation',
          created_at: new Date('2026-01-02T10:00:00Z'),
          updated_at: new Date('2026-01-02T12:00:00Z'),
        },
      ],
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/llm/conversations',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toHaveLength(2);
    expect(body[0].id).toBe('conv-1');
    expect(body[0].model).toBe('llama3');
    expect(body[0].title).toBe('First conversation');
    expect(body[0].createdAt).toBeDefined();
    expect(body[0].updatedAt).toBeDefined();
    expect(body[1].id).toBe('conv-2');

    // Verify the query used the correct user_id
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('SELECT id, model, title, created_at, updated_at FROM llm_conversations'),
      ['test-user-123'],
    );
  });

  it('should return an empty list when user has no conversations', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const response = await app.inject({
      method: 'GET',
      url: '/api/llm/conversations',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toEqual([]);
  });

  // --- GET /api/llm/conversations/:id ---

  it('should return a specific conversation by ID', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'conv-1',
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
      url: '/api/llm/conversations/conv-1',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.id).toBe('conv-1');
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
      url: '/api/llm/conversations/nonexistent-id',
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
      url: '/api/llm/conversations/conv-1',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.message).toBe('Conversation deleted');

    // Verify DELETE query included user_id scope
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM llm_conversations WHERE id = $1 AND user_id = $2'),
      ['conv-1', 'test-user-123'],
    );
  });

  it('should return 200 even when deleting a non-existent conversation (idempotent)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/llm/conversations/nonexistent-id',
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
