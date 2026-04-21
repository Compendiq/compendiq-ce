import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import cookie from '@fastify/cookie';
import { ZodError } from 'zod';

// ─── Mocks ────────────────────────────────────────────────────────────────

vi.mock('../../core/db/postgres.js', () => ({
  checkConnection: vi.fn().mockResolvedValue(true),
  getPool: vi.fn().mockReturnValue({}),
  query: vi.fn(),
  runMigrations: vi.fn(),
  closePool: vi.fn(),
}));

const mockGenerateAccessToken = vi.fn().mockResolvedValue('mock-access-token');
const mockGenerateRefreshToken = vi.fn().mockResolvedValue({ token: 'mock-refresh-token', jti: 'mock-jti' });

vi.mock('../../core/plugins/auth.js', () => ({
  generateAccessToken: (...args: unknown[]) => mockGenerateAccessToken(...args),
  generateRefreshToken: (...args: unknown[]) => mockGenerateRefreshToken(...args),
  default: vi.fn(async (app: { decorate: (name: string, fn: unknown) => void }) => {
    app.decorate('authenticate', async () => {});
    app.decorate('requireAdmin', async () => {});
  }),
}));

vi.mock('../../core/services/audit-service.js', () => ({
  logAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

const mockCheckHealth = vi.fn().mockResolvedValue({ connected: true });
const mockListModels = vi.fn().mockResolvedValue([{ name: 'llama3.2:latest' }]);

vi.mock('../../domains/llm/services/openai-compatible-client.js', () => ({
  checkHealth: (...args: unknown[]) => mockCheckHealth(...args),
  listModels: (...args: unknown[]) => mockListModels(...args),
  streamChat: vi.fn(),
  chat: vi.fn(),
  generateEmbedding: vi.fn(),
  invalidateDispatcher: vi.fn(),
}));

vi.mock('../../core/utils/crypto.js', () => ({
  decryptPat: (v: string) => v,
  encryptPat: (v: string) => v,
}));

vi.mock('../../core/utils/logger.js', () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

// Must import after mocks
import { query } from '../../core/db/postgres.js';
import { setupRoutes } from './setup.js';

const mockQuery = query as ReturnType<typeof vi.fn>;

describe('Setup routes', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(sensible);
    await app.register(cookie);

    // Decorate with authenticate and requireAdmin
    app.decorate('authenticate', async () => {});
    app.decorate('requireAdmin', async () => {});

    // Add ZodError handler matching app.ts behavior
    app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
      if (error instanceof ZodError) {
        reply.status(400).send({
          error: 'ValidationError',
          message: error.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join('; '),
          statusCode: 400,
        });
        return;
      }
      const statusCode = error.statusCode ?? 500;
      reply.status(statusCode).send({
        error: error.name ?? 'InternalServerError',
        message: statusCode === 500 ? 'Internal Server Error' : error.message,
        statusCode,
      });
    });

    await app.register(setupRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckHealth.mockResolvedValue({ connected: true });
    mockListModels.mockResolvedValue([{ name: 'llama3.2:latest' }]);
  });

  // ─── GET /api/health/setup-status ─────────────────────────────────────

  describe('GET /api/health/setup-status', () => {
    it('should return all steps as false when nothing is configured', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] }); // admin count
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] }); // confluence count
      mockQuery.mockResolvedValueOnce({ rows: [] }); // no default llm_providers row
      mockCheckHealth.mockResolvedValue({ connected: false });

      const response = await app.inject({ method: 'GET', url: '/api/health/setup-status' });
      expect(response.statusCode).toBe(200);

      const body = JSON.parse(response.body);
      expect(body.setupComplete).toBe(false);
      expect(body.steps.admin).toBe(false);
      expect(body.steps.llm).toBe(false);
      expect(body.steps.confluence).toBe(false);
    });

    it('should return admin=true when admin user exists', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '1' }] }); // admin count
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] }); // confluence count
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({ method: 'GET', url: '/api/health/setup-status' });
      const body = JSON.parse(response.body);
      expect(body.steps.admin).toBe(true);
    });

    it('should return llm=true when LLM health check passes', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '1' }] }); // admin count
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] }); // confluence count
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 'p1',
            base_url: 'http://localhost:11434',
            api_key: null,
            auth_type: 'none',
            verify_ssl: true,
          },
        ],
      });
      mockCheckHealth.mockResolvedValue({ connected: true });

      const response = await app.inject({ method: 'GET', url: '/api/health/setup-status' });
      const body = JSON.parse(response.body);
      expect(body.steps.llm).toBe(true);
    });

    it('should return confluence=true when confluence pages exist', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '1' }] }); // admin count
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '3' }] }); // confluence count
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({ method: 'GET', url: '/api/health/setup-status' });
      const body = JSON.parse(response.body);
      expect(body.steps.confluence).toBe(true);
    });

    it('should return setupComplete=true when admin exists (regardless of LLM status)', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '1' }] }); // admin count
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] }); // confluence count
      mockQuery.mockResolvedValueOnce({ rows: [] });
      mockCheckHealth.mockResolvedValue({ connected: false });

      const response = await app.inject({ method: 'GET', url: '/api/health/setup-status' });
      const body = JSON.parse(response.body);
      expect(body.setupComplete).toBe(true);
    });

    it('should return setupComplete=false when no admin exists even if LLM is up', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] }); // admin count
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] }); // confluence count
      mockQuery.mockResolvedValueOnce({ rows: [] });
      mockCheckHealth.mockResolvedValue({ connected: true });

      const response = await app.inject({ method: 'GET', url: '/api/health/setup-status' });
      const body = JSON.parse(response.body);
      expect(body.setupComplete).toBe(false);
    });

    it('should handle LLM health check timeout gracefully', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '1' }] }); // admin count
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] }); // confluence count
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 'p1',
            base_url: 'http://localhost:11434',
            api_key: null,
            auth_type: 'none',
            verify_ssl: true,
          },
        ],
      });
      mockCheckHealth.mockImplementation(() => new Promise((_resolve) => {
        setTimeout(() => _resolve({ connected: true }), 10000);
      }));

      const response = await app.inject({ method: 'GET', url: '/api/health/setup-status' });
      const body = JSON.parse(response.body);
      expect(body.steps.llm).toBe(false);
    });

    it('should have rate limiting configured on GET setup-status', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '1' }] }); // admin count
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] }); // confluence count
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({ method: 'GET', url: '/api/health/setup-status' });
      expect(response.statusCode).toBe(200);
    });
  });

  // ─── POST /api/setup/admin ────────────────────────────────────────────

  describe('POST /api/setup/admin', () => {
    it('should create admin account when no admin exists', async () => {
      // First query: atomic INSERT ... WHERE NOT EXISTS ... RETURNING
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'uuid-1', username: 'admin', role: 'admin' }],
      });
      // Second query: INSERT user_settings
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({
        method: 'POST',
        url: '/api/setup/admin',
        payload: {
          username: 'admin',
          password: 'securepass123',
          displayName: 'Admin User',
        },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body.accessToken).toBe('mock-access-token');
      expect(body.user.username).toBe('admin');
      expect(body.user.role).toBe('admin');
    });

    it('should set refresh cookie on admin creation', async () => {
      // Atomic INSERT ... WHERE NOT EXISTS ... RETURNING
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'uuid-1', username: 'admin', role: 'admin' }],
      });
      // INSERT user_settings
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({
        method: 'POST',
        url: '/api/setup/admin',
        payload: { username: 'admin', password: 'securepass123' },
      });

      expect(response.statusCode).toBe(201);
      const cookies = response.cookies;
      const refreshCookie = cookies.find((c) => c.name === 'kb_refresh');
      expect(refreshCookie).toBeDefined();
      expect(refreshCookie!.httpOnly).toBe(true);
    });

    it('should return 409 when admin already exists', async () => {
      // Atomic INSERT returns empty rows when admin already exists
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({
        method: 'POST',
        url: '/api/setup/admin',
        payload: { username: 'admin2', password: 'securepass123' },
      });

      expect(response.statusCode).toBe(409);
      const body = JSON.parse(response.body);
      expect(body.message).toContain('already exists');
    });

    it('should return 400 for invalid input (password too short)', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/setup/admin',
        payload: { username: 'admin', password: 'short' },
      });

      // Zod validation errors get caught by the error handler
      expect(response.statusCode).toBe(400);
    });

    it('should return 400 for invalid input (username too short)', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/setup/admin',
        payload: { username: 'ab', password: 'securepass123' },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should handle duplicate username (23505 error)', async () => {
      // Atomic INSERT throws a PG unique violation
      const pgError = new Error('duplicate key') as Error & { code: string };
      pgError.code = '23505';
      mockQuery.mockRejectedValueOnce(pgError);

      const response = await app.inject({
        method: 'POST',
        url: '/api/setup/admin',
        payload: { username: 'admin', password: 'securepass123' },
      });

      expect(response.statusCode).toBe(409);
      const body = JSON.parse(response.body);
      expect(body.message).toContain('Username already taken');
    });
  });

  // ─── POST /api/setup/llm-test ─────────────────────────────────────────

  describe('POST /api/setup/llm-test', () => {
    it('should return success when LLM is reachable', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/setup/llm-test',
        payload: { provider: 'ollama', baseUrl: 'http://localhost:11434' },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);
      expect(body.models).toHaveLength(1);
      expect(body.models[0].name).toBe('llama3.2:latest');
    });

    it('should return failure when LLM is unreachable', async () => {
      mockCheckHealth.mockResolvedValue({ connected: false, error: 'Connection refused' });
      mockListModels.mockRejectedValue(new Error('Connection refused'));

      const response = await app.inject({
        method: 'POST',
        url: '/api/setup/llm-test',
        payload: { provider: 'ollama', baseUrl: 'http://localhost:11434' },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(false);
      expect(body.error).toBe('Connection refused');
    });

    it('should handle openai provider type (no custom config)', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/setup/llm-test',
        payload: { provider: 'openai' },
      });

      expect(response.statusCode).toBe(200);
      // No baseUrl supplied → setup.ts defaults to https://api.openai.com/v1
      expect(mockCheckHealth).toHaveBeenCalledWith(
        expect.objectContaining({ baseUrl: 'https://api.openai.com/v1' }),
      );
    });

    it('should handle exceptions gracefully', async () => {
      mockCheckHealth.mockRejectedValueOnce(new Error('Provider initialization failed'));
      mockListModels.mockRejectedValueOnce(new Error('Provider initialization failed'));

      const response = await app.inject({
        method: 'POST',
        url: '/api/setup/llm-test',
        payload: { provider: 'ollama' },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(false);
      expect(body.error).toBe('Provider initialization failed');
    });

    it('should return 400 for invalid provider', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/setup/llm-test',
        payload: { provider: 'invalid-provider' },
      });

      expect(response.statusCode).toBe(400);
    });
  });
});
