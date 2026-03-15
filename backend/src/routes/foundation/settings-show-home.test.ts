import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { ZodError } from 'zod';

const mockQuery = vi.fn();

vi.mock('../../core/db/postgres.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  getPool: vi.fn().mockReturnValue({}),
  runMigrations: vi.fn(),
  closePool: vi.fn(),
}));

vi.mock('../../core/utils/crypto.js', () => ({
  encryptPat: vi.fn().mockReturnValue('encrypted-pat'),
}));

vi.mock('../../core/services/audit-service.js', () => ({
  logAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../core/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../core/services/rbac-service.js', () => ({
  getUserAccessibleSpaces: vi.fn().mockResolvedValue([]),
  invalidateRbacCache: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('undici', () => ({
  request: vi.fn(),
}));

vi.mock('../../core/utils/tls-config.js', () => ({
  confluenceDispatcher: { isMockDispatcher: true },
  buildConnectOptions: vi.fn().mockReturnValue(undefined),
}));

import { settingsRoutes } from './settings.js';

describe('Settings routes – showSpaceHomeContent', () => {
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

    await app.register(settingsRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('GET /settings returns showSpaceHomeContent=true by default for new users', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // INSERT default

    const response = await app.inject({ method: 'GET', url: '/api/settings' });
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    expect(body.showSpaceHomeContent).toBe(true);
  });

  it('GET /settings returns showSpaceHomeContent from DB row', async () => {
    // Query 1: user_settings
    mockQuery.mockResolvedValueOnce({
      rows: [{
        confluence_url: null,
        confluence_pat: null,
        ollama_model: 'qwen3.5',
        llm_provider: 'ollama',
        openai_base_url: null,
        openai_api_key: null,
        openai_model: null,
        theme: 'glass-dark',
        sync_interval_min: 15,
        show_space_home_content: false,
      }],
      rowCount: 1,
    });
    // getUserAccessibleSpaces is mocked

    const response = await app.inject({ method: 'GET', url: '/api/settings' });
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    expect(body.showSpaceHomeContent).toBe(false);
  });

  it('PUT /settings updates showSpaceHomeContent', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const response = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { showSpaceHomeContent: false },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.message).toBe('Settings updated');

    // Verify the SQL update included show_space_home_content
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('show_space_home_content'),
      expect.arrayContaining([false, 'test-user-id']),
    );
  });
});
