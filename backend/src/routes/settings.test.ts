import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { ZodError } from 'zod';

// Mock undici request
const mockUndiciRequest = vi.fn();
vi.mock('undici', () => ({
  request: (...args: unknown[]) => mockUndiciRequest(...args),
}));

// Mock TLS config
vi.mock('../utils/tls-config.js', () => ({
  confluenceDispatcher: undefined,
  buildConnectOptions: vi.fn().mockReturnValue(undefined),
}));

// Hoisted query mock so we can reference it in tests
const mockQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });

// Mock external dependencies
vi.mock('../db/postgres.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  getPool: vi.fn().mockReturnValue({}),
  runMigrations: vi.fn(),
  closePool: vi.fn(),
}));

vi.mock('../utils/crypto.js', () => ({
  encryptPat: vi.fn().mockReturnValue('encrypted-pat'),
}));

vi.mock('../services/audit-service.js', () => ({
  logAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('../services/ollama-service.js', () => ({
  setActiveProvider: vi.fn(),
}));

import { settingsRoutes } from './settings.js';

describe('Settings routes – test-confluence', () => {
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

    // Mock auth decorator
    app.decorate('authenticate', async (request: { userId: string; username: string; userRole: string }) => {
      request.userId = 'test-user-id';
      request.username = 'testuser';
      request.userRole = 'user';
    });

    await app.register(settingsRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return success when Confluence responds OK', async () => {
    mockUndiciRequest.mockResolvedValue({
      statusCode: 200,
      body: { dump: vi.fn().mockResolvedValue(undefined) },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/settings/test-confluence',
      payload: { url: 'https://confluence.example.com', pat: 'test-pat' },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(true);
    expect(body.message).toBe('Connection successful');

    // Verify undici was called with correct URL and auth header
    expect(mockUndiciRequest).toHaveBeenCalledWith(
      'https://confluence.example.com/rest/api/space?limit=1',
      expect.objectContaining({
        method: 'GET',
        headers: { Authorization: 'Bearer test-pat' },
      }),
    );
  });

  it('should return failure with HTTP status on non-2xx response', async () => {
    mockUndiciRequest.mockResolvedValue({
      statusCode: 401,
      body: { dump: vi.fn().mockResolvedValue(undefined) },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/settings/test-confluence',
      payload: { url: 'https://confluence.example.com', pat: 'bad-pat' },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(false);
    expect(body.message).toBe('HTTP 401');
  });

  it('should return detailed error message including cause', async () => {
    const fetchError = new TypeError('fetch failed');
    (fetchError as Error & { cause: Error }).cause = new Error('unable to verify the first certificate');
    mockUndiciRequest.mockRejectedValue(fetchError);

    const response = await app.inject({
      method: 'POST',
      url: '/api/settings/test-confluence',
      payload: { url: 'https://confluence.example.com', pat: 'test-pat' },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(false);
    expect(body.message).toContain('fetch failed');
    expect(body.message).toContain('unable to verify the first certificate');
  });

  it('should return error message without duplicate when cause matches message', async () => {
    mockUndiciRequest.mockRejectedValue(new Error('Connection refused'));

    const response = await app.inject({
      method: 'POST',
      url: '/api/settings/test-confluence',
      payload: { url: 'https://confluence.example.com', pat: 'test-pat' },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(false);
    expect(body.message).toBe('Connection refused');
  });

  it('should block SSRF attempts to private networks', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/settings/test-confluence',
      payload: { url: 'https://192.168.1.1', pat: 'test-pat' },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(false);
    expect(body.message).toContain('URL blocked');
    expect(mockUndiciRequest).not.toHaveBeenCalled();
  });

  it('should reject invalid payload (missing url)', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/settings/test-confluence',
      payload: { pat: 'test-pat' },
    });

    expect(response.statusCode).toBe(400);
  });
});

describe('Settings routes – chunk size and overlap', () => {
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

    // Provide a fake redis for the invalidateUserData helper (never called in these tests)
    app.decorate('redis', {
      scan: vi.fn().mockResolvedValue({ cursor: '0', keys: [] }),
      del: vi.fn().mockResolvedValue(undefined),
    });

    await app.register(settingsRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it('GET /settings returns embeddingChunkSize and embeddingChunkOverlap from DB', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        confluence_url: null,
        confluence_pat: null,
        selected_spaces: [],
        ollama_model: 'qwen3.5',
        llm_provider: 'ollama',
        openai_base_url: null,
        openai_api_key: null,
        openai_model: null,
        theme: 'glass-dark',
        sync_interval_min: 15,
        show_space_home_content: true,
        embedding_chunk_size: 256,
        embedding_chunk_overlap: 32,
      }],
    });

    const response = await app.inject({ method: 'GET', url: '/api/settings' });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.embeddingChunkSize).toBe(256);
    expect(body.embeddingChunkOverlap).toBe(32);
  });

  it('GET /settings returns defaults when no row exists', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // no settings row
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // INSERT

    const response = await app.inject({ method: 'GET', url: '/api/settings' });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.embeddingChunkSize).toBe(500);
    expect(body.embeddingChunkOverlap).toBe(50);
  });

  it('PUT /settings rejects overlap > 25% of chunk size', async () => {
    // First query: read current chunk settings for validation
    mockQuery.mockResolvedValueOnce({
      rows: [{ embedding_chunk_size: 500, embedding_chunk_overlap: 50 }],
    });

    const response = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { embeddingChunkSize: 400, embeddingChunkOverlap: 150 },
    });

    // 150 > 400 * 0.25 (100) → should be rejected
    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error).toContain('Chunk overlap');
  });

  it('PUT /settings accepts overlap exactly at 25% boundary', async () => {
    // Validation query: current settings (not needed since both values provided)
    // UPDATE query
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE user_settings
    // Mark pages dirty
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // UPDATE cached_pages

    const response = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { embeddingChunkSize: 400, embeddingChunkOverlap: 100 },
    });

    // 100 == 400 * 0.25 → exactly at boundary → accepted
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.message).toBe('Settings updated');
  });

  it('PUT /settings marks all user pages dirty when chunk size changes', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE user_settings
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 5 }); // UPDATE cached_pages dirty

    await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { embeddingChunkSize: 256, embeddingChunkOverlap: 32 },
    });

    const dirtyCalls = mockQuery.mock.calls.filter(
      (call) => typeof call[0] === 'string' && (call[0] as string).includes('embedding_dirty = TRUE') && (call[0] as string).includes('cached_pages'),
    );
    expect(dirtyCalls).toHaveLength(1);
    expect(dirtyCalls[0][1]).toContain('test-user-id');
  });

  it('PUT /settings marks all user pages dirty when chunk overlap changes', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE user_settings
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 3 }); // UPDATE cached_pages dirty

    await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { embeddingChunkOverlap: 25 },
    });

    const dirtyCalls = mockQuery.mock.calls.filter(
      (call) => typeof call[0] === 'string' && (call[0] as string).includes('embedding_dirty = TRUE') && (call[0] as string).includes('cached_pages'),
    );
    expect(dirtyCalls).toHaveLength(1);
  });

  it('PUT /settings does not mark pages dirty when only unrelated settings change', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE user_settings

    await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { ollamaModel: 'llama3' },
    });

    const dirtyCalls = mockQuery.mock.calls.filter(
      (call) => typeof call[0] === 'string' && (call[0] as string).includes('embedding_dirty = TRUE') && (call[0] as string).includes('cached_pages'),
    );
    expect(dirtyCalls).toHaveLength(0);
  });

  it('PUT /settings fetches current settings when only overlap is provided (for validation)', async () => {
    // Fetch current chunk size for validation
    mockQuery.mockResolvedValueOnce({
      rows: [{ embedding_chunk_size: 500, embedding_chunk_overlap: 50 }],
    });
    // UPDATE user_settings
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    // Mark pages dirty
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const response = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { embeddingChunkOverlap: 100 },
    });

    // 100 <= 500 * 0.25 (125) → valid
    expect(response.statusCode).toBe(200);

    // Verify the SELECT was made to fetch current chunk size
    const selectCalls = mockQuery.mock.calls.filter(
      (call) => typeof call[0] === 'string' && (call[0] as string).includes('embedding_chunk_size') && (call[0] as string).includes('user_settings'),
    );
    expect(selectCalls.length).toBeGreaterThan(0);
  });
});
