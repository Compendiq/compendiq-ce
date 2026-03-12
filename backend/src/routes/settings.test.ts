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
  decryptPat: vi.fn().mockReturnValue('decrypted-stored-pat'),
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

const mockGetSyncOverview = vi.fn();
vi.mock('../services/sync-overview-service.js', () => ({
  getSyncOverview: (...args: unknown[]) => mockGetSyncOverview(...args),
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

  it('should use stored PAT when pat is omitted', async () => {
    // DB returns a stored encrypted PAT
    mockQuery.mockResolvedValueOnce({
      rows: [{ confluence_pat: 'v0:aabbcc:ddeeff:112233' }],
    });
    mockUndiciRequest.mockResolvedValue({
      statusCode: 200,
      body: { dump: vi.fn().mockResolvedValue(undefined) },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/settings/test-confluence',
      payload: { url: 'https://confluence.example.com' },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(true);
    // Should have used the decrypted stored PAT
    expect(mockUndiciRequest).toHaveBeenCalledWith(
      'https://confluence.example.com/rest/api/space?limit=1',
      expect.objectContaining({
        headers: { Authorization: 'Bearer decrypted-stored-pat' },
      }),
    );
  });

  it('should return error when pat is omitted and none is stored', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ confluence_pat: null }] });

    const response = await app.inject({
      method: 'POST',
      url: '/api/settings/test-confluence',
      payload: { url: 'https://confluence.example.com' },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(false);
    expect(body.message).toContain('No PAT saved');
    expect(mockUndiciRequest).not.toHaveBeenCalled();
  });
});

describe('Settings routes – GET/PUT settings (shared tables)', () => {
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

  it('GET /settings returns settings from DB with selected spaces from user_space_selections', async () => {
    // Query 1: user_settings
    mockQuery.mockResolvedValueOnce({
      rows: [{
        confluence_url: 'https://confluence.example.com',
        confluence_pat: 'encrypted',
        ollama_model: 'qwen3.5',
        llm_provider: 'ollama',
        openai_base_url: null,
        openai_api_key: null,
        openai_model: null,
        theme: 'glass-dark',
        sync_interval_min: 15,
        show_space_home_content: true,
      }],
    });
    // Query 2: user_space_selections
    mockQuery.mockResolvedValueOnce({ rows: [{ space_key: 'DEV' }, { space_key: 'DOCS' }] });

    const response = await app.inject({ method: 'GET', url: '/api/settings' });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.selectedSpaces).toEqual(['DEV', 'DOCS']);
    expect(body.confluenceUrl).toBe('https://confluence.example.com');
    expect(body.confluenceConnected).toBe(true);
  });

  it('GET /settings/sync-overview returns sync overview payload', async () => {
    mockGetSyncOverview.mockResolvedValueOnce({
      sync: { userId: 'test-user-id', status: 'syncing', progress: { current: 2, total: 5, space: 'OPS' } },
      totals: {
        selectedSpaces: 1,
        totalPages: 3,
        pagesWithAssets: 2,
        pagesWithIssues: 1,
        healthyPages: 2,
        images: { expected: 4, cached: 3, missing: 1 },
        drawio: { expected: 1, cached: 1, missing: 0 },
      },
      spaces: [{
        spaceKey: 'OPS',
        spaceName: 'Operations',
        status: 'syncing',
        lastSynced: '2026-03-11T10:00:00.000Z',
        pageCount: 3,
        pagesWithAssets: 2,
        pagesWithIssues: 1,
        images: { expected: 4, cached: 3, missing: 1 },
        drawio: { expected: 1, cached: 1, missing: 0 },
      }],
      issues: [{
        pageId: 'page-1',
        pageTitle: 'Runbook',
        spaceKey: 'OPS',
        missingImages: 1,
        missingDrawio: 0,
        missingFiles: ['missing.png'],
      }],
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/settings/sync-overview',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.sync.status).toBe('syncing');
    expect(body.totals.images.missing).toBe(1);
    expect(body.issues[0].missingFiles).toEqual(['missing.png']);
    expect(mockGetSyncOverview).toHaveBeenCalledWith('test-user-id');
  });

  it('GET /settings returns defaults when no row exists', async () => {
    // Query 1: user_settings → no row
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // Query 2: INSERT default settings
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const response = await app.inject({ method: 'GET', url: '/api/settings' });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.selectedSpaces).toEqual([]);
    expect(body.ollamaModel).toBe('qwen3.5');
    expect(body.theme).toBe('glass-dark');
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

  it('PUT /settings updates selectedSpaces via user_space_selections', async () => {
    // UPDATE user_settings (no other fields change here)
    // DELETE old spaces
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // INSERT new space
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const response = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { selectedSpaces: ['DEV'] },
    });

    expect(response.statusCode).toBe(200);

    const deleteCalls = mockQuery.mock.calls.filter(
      (call) => typeof call[0] === 'string' && (call[0] as string).includes('DELETE FROM user_space_selections'),
    );
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0][1]).toContain('test-user-id');
  });

  it('GET /settings returns customPrompts from DB', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        confluence_url: null, confluence_pat: null, ollama_model: 'qwen3.5',
        llm_provider: 'ollama', openai_base_url: null, openai_api_key: null,
        openai_model: null, theme: 'glass-dark', sync_interval_min: 15,
        show_space_home_content: true,
        custom_prompts: { improve_grammar: 'Fix grammar pls' },
      }],
    });
    mockQuery.mockResolvedValueOnce({ rows: [] }); // spaces

    const response = await app.inject({ method: 'GET', url: '/api/settings' });
    const body = JSON.parse(response.body);

    expect(body.customPrompts).toEqual({ improve_grammar: 'Fix grammar pls' });
  });

  it('GET /settings returns empty customPrompts when no row exists', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [] }); // spaces (queried before the empty check)

    const response = await app.inject({ method: 'GET', url: '/api/settings' });
    const body = JSON.parse(response.body);

    expect(body.customPrompts).toEqual({});
  });

  it('PUT /settings persists customPrompts as JSON', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE

    const response = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { customPrompts: { improve_clarity: 'Be clear!' } },
    });

    expect(response.statusCode).toBe(200);

    const updateCalls = mockQuery.mock.calls.filter(
      (call) => typeof call[0] === 'string' && (call[0] as string).includes('custom_prompts'),
    );
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0][1]).toContain(JSON.stringify({ improve_clarity: 'Be clear!' }));
  });
});
