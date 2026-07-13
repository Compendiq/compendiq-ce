import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { healthRoutes, markStartupComplete } from './health.js';

// `checkLlm` reads the default provider from `llm_providers`. We intercept
// `query` at the module boundary and hand back a stub row.
const mockQuery = vi.fn().mockResolvedValue({
  rows: [
    {
      id: 'prov-1',
      name: 'ollama',
      base_url: 'http://localhost:11434',
      api_key: null,
      auth_type: 'none',
      verify_ssl: true,
    },
  ],
});

vi.mock('../../core/db/postgres.js', () => ({
  checkConnection: vi.fn().mockResolvedValue(true),
  getPool: vi.fn().mockReturnValue({}),
  query: (...args: unknown[]) => mockQuery(...args),
  runMigrations: vi.fn(),
  closePool: vi.fn(),
}));

vi.mock('../../core/plugins/redis.js', () => ({
  checkRedisConnection: vi.fn().mockResolvedValue(true),
  default: vi.fn(),
}));

const mockListProviderBreakers = vi.fn().mockReturnValue([]);
vi.mock('../../core/services/circuit-breaker.js', () => ({
  listProviderBreakers: (...args: unknown[]) => mockListProviderBreakers(...args),
}));

const mockListProviders = vi.fn().mockResolvedValue([]);
vi.mock('../../domains/llm/services/llm-provider-service.js', () => ({
  listProviders: (...args: unknown[]) => mockListProviders(...args),
}));

// Provider-aware health check now lives in `openai-compatible-client.ts`.
const mockCheckHealth = vi.fn().mockResolvedValue({ connected: true });
vi.mock('../../domains/llm/services/openai-compatible-client.js', () => ({
  checkHealth: (...args: unknown[]) => mockCheckHealth(...args),
  streamChat: vi.fn(),
  chat: vi.fn(),
  generateEmbedding: vi.fn(),
  listModels: vi.fn(),
  invalidateDispatcher: vi.fn(),
}));

// decryptPat is called on any non-null api_key in the provider row.
vi.mock('../../core/utils/crypto.js', () => ({
  decryptPat: (v: string) => v,
  encryptPat: (v: string) => v,
}));

vi.mock('../../core/utils/logger.js', () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock('../../domains/llm/services/llm-queue.js', () => ({
  getMetrics: () => ({ queueDepth: 0, active: 0, total: 0, errors: 0 }),
}));

vi.mock('../../core/services/queue-service.js', () => ({
  getQueueMetrics: () => ({}),
  isBullMQEnabled: () => false,
}));

import { checkConnection as mockCheckPg } from '../../core/db/postgres.js';
import { checkRedisConnection as mockCheckRedis } from '../../core/plugins/redis.js';

describe('Health routes', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(sensible);
    app.decorate('redis', {});
    // #1052: /api/health reuses `fastify.authenticate` to tier its response.
    // Stub it so anonymous callers get the coarse body, `Bearer admin-tok`
    // gets full detail, and `Bearer user-tok` (authenticated non-admin) gets
    // the coarse body. The stub throws on anything else, which the handler's
    // swallow-try treats as anonymous.
    app.decorate(
      'authenticate',
      async (request: {
        headers: { authorization?: string };
        userId: string;
        username: string;
        userRole: string;
      }) => {
        const authHeader = request.headers.authorization;
        if (authHeader === 'Bearer admin-tok') {
          request.userId = 'admin-1';
          request.username = 'admin';
          request.userRole = 'admin';
          return;
        }
        if (authHeader === 'Bearer user-tok') {
          request.userId = 'user-1';
          request.username = 'user';
          request.userRole = 'user';
          return;
        }
        throw new Error('Unauthorized');
      },
    );
    await app.register(healthRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    (mockCheckPg as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (mockCheckRedis as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    mockCheckHealth.mockResolvedValue({ connected: true });
    mockListProviderBreakers.mockReturnValue([]);
    mockListProviders.mockResolvedValue([]);
    mockQuery.mockResolvedValue({
      rows: [
        {
          id: 'prov-1',
          name: 'ollama',
          base_url: 'http://localhost:11434',
          api_key: null,
          auth_type: 'none',
          verify_ssl: true,
        },
      ],
    });
  });

  describe('GET /api/health/live', () => {
    it('should always return 200 with status ok', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/health/live' });
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body).status).toBe('ok');
    });

    it('should return 200 even when all services are down', async () => {
      (mockCheckPg as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      (mockCheckRedis as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      const response = await app.inject({ method: 'GET', url: '/api/health/live' });
      expect(response.statusCode).toBe(200);
    });
  });

  describe('GET /api/health/ready', () => {
    it('should return 200 with a coarse status when PostgreSQL and Redis are healthy', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/health/ready' });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body).toEqual({ status: 'ok' });
      // #1052: the public readiness probe must not leak telemetry.
      expect(body).not.toHaveProperty('services');
      expect(body).not.toHaveProperty('version');
      expect(body).not.toHaveProperty('edition');
      expect(body).not.toHaveProperty('uptime');
    });

    it('should return 503 when PostgreSQL is down', async () => {
      (mockCheckPg as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      const response = await app.inject({ method: 'GET', url: '/api/health/ready' });
      expect(response.statusCode).toBe(503);
      expect(JSON.parse(response.body).status).toBe('degraded');
    });

    it('should return 503 when Redis is down', async () => {
      (mockCheckRedis as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      const response = await app.inject({ method: 'GET', url: '/api/health/ready' });
      expect(response.statusCode).toBe(503);
    });

    it('should return 503 with error status when all services are down', async () => {
      (mockCheckPg as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      (mockCheckRedis as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      const response = await app.inject({ method: 'GET', url: '/api/health/ready' });
      expect(response.statusCode).toBe(503);
      expect(JSON.parse(response.body).status).toBe('error');
    });
  });

  describe('GET /api/health/start', () => {
    it('should return only the coarse startup checks (no LLM telemetry)', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/health/start' });
      const body = JSON.parse(response.body);
      expect(body.checks).toHaveProperty('startupComplete');
      expect(body.checks).toHaveProperty('postgres');
      // #1052: the LLM probe (and its provider-name leak) is dropped entirely.
      expect(body.checks).not.toHaveProperty('llmAvailable');
      expect(body.checks).not.toHaveProperty('llmProvider');
      expect(body).not.toHaveProperty('version');
      expect(body).not.toHaveProperty('edition');
    });

    it('should return 200 after markStartupComplete when postgres is healthy', async () => {
      markStartupComplete();
      const response = await app.inject({ method: 'GET', url: '/api/health/start' });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.status).toBe('ok');
      expect(body.checks.startupComplete).toBe(true);
      expect(body.checks.postgres).toBe(true);
    });

    it('should return 503 with starting status when postgres is down', async () => {
      markStartupComplete();
      (mockCheckPg as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      const response = await app.inject({ method: 'GET', url: '/api/health/start' });
      expect(response.statusCode).toBe(503);
      const body = JSON.parse(response.body);
      expect(body.status).toBe('starting');
      expect(body.checks.postgres).toBe(false);
    });
  });

  describe('GET /api/health (backward compat)', () => {
    // #1052: anonymous callers get ONLY a coarse `{ status }`.
    it('returns ONLY { status } to anonymous callers — no telemetry leaks', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/health' });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body).toEqual({ status: 'ok' });
      // The deployment-fingerprinting fields from #1052 must all be absent.
      expect(body).not.toHaveProperty('version');
      expect(body).not.toHaveProperty('edition');
      expect(body).not.toHaveProperty('uptime');
      expect(body).not.toHaveProperty('services');
      expect(body).not.toHaveProperty('llmProvider');
      expect(body).not.toHaveProperty('commit');
      expect(body).not.toHaveProperty('ceCommit');
      expect(body).not.toHaveProperty('builtAt');
    });

    it('returns a coarse { status } to authenticated NON-admin callers', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/health',
        headers: { authorization: 'Bearer user-tok' },
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body).toEqual({ status: 'ok' });
      expect(body).not.toHaveProperty('services');
      expect(body).not.toHaveProperty('version');
    });

    it('exposes full detail (status/services/llmProvider/version/commit) to admins', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/health',
        headers: { authorization: 'Bearer admin-tok' },
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.status).toBe('ok');
      expect(body.services).toHaveProperty('postgres');
      expect(body.services).toHaveProperty('redis');
      expect(body.services).toHaveProperty('llm');
      expect(body).toHaveProperty('llmProvider');
      expect(body).toHaveProperty('version');
      expect(body).toHaveProperty('commit');
      expect(body).toHaveProperty('uptime');
    });

    it('does NOT leak internal operational telemetry even to admins (#818)', async () => {
      // Live per-provider breakers + queue depth would be exposed if the leak regressed.
      mockListProviderBreakers.mockReturnValue([
        { providerId: 'uuid-b', state: 'open', failureCount: 3, nextRetryTime: 99 },
      ]);
      mockListProviders.mockResolvedValue([{ id: 'uuid-b', name: 'OpenAI' }]);

      const response = await app.inject({
        method: 'GET',
        url: '/api/health',
        headers: { authorization: 'Bearer admin-tok' },
      });
      const body = JSON.parse(response.body);
      expect(body).not.toHaveProperty('circuitBreakers');
      expect(body).not.toHaveProperty('llmQueue');
      expect(body).not.toHaveProperty('queues');
    });

    it('does NOT run the LLM probe for anonymous callers', async () => {
      await app.inject({ method: 'GET', url: '/api/health' });
      expect(mockCheckHealth).not.toHaveBeenCalled();
    });

    it('should report llm=false when LLM provider is unreachable (admin)', async () => {
      mockCheckHealth.mockResolvedValue({ connected: false, error: 'timeout' });

      const response = await app.inject({
        method: 'GET',
        url: '/api/health',
        headers: { authorization: 'Bearer admin-tok' },
      });
      const body = JSON.parse(response.body);
      expect(body.services.llm).toBe(false);
    });

    it('should use active provider for health check (admin)', async () => {
      mockQuery.mockResolvedValue({
        rows: [
          {
            id: 'prov-openai',
            name: 'openai',
            base_url: 'https://api.openai.com/v1',
            api_key: 'sk-xxxx',
            auth_type: 'bearer',
            verify_ssl: true,
          },
        ],
      });
      mockCheckHealth.mockResolvedValue({ connected: true });

      const response = await app.inject({
        method: 'GET',
        url: '/api/health',
        headers: { authorization: 'Bearer admin-tok' },
      });
      const body = JSON.parse(response.body);
      expect(body.services.llm).toBe(true);
      expect(body.llmProvider).toBe('openai');
      expect(mockCheckHealth).toHaveBeenCalledWith(
        expect.objectContaining({ baseUrl: 'https://api.openai.com/v1' }),
      );
    });
  });
});
