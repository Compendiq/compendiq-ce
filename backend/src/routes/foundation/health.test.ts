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
    it('should return 200 when PostgreSQL and Redis are healthy', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/health/ready' });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.status).toBe('ok');
      expect(body.services.postgres).toBe(true);
      expect(body.services.redis).toBe(true);
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
    it('should include llmProvider and llmAvailable in response', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/health/start' });
      const body = JSON.parse(response.body);
      expect(body.checks).toHaveProperty('llmAvailable');
      expect(body.checks).toHaveProperty('llmProvider');
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

    it('should report llmAvailable=false when LLM is unreachable', async () => {
      markStartupComplete();
      mockCheckHealth.mockResolvedValue({ connected: false, error: 'Connection refused' });

      const response = await app.inject({ method: 'GET', url: '/api/health/start' });
      const body = JSON.parse(response.body);
      expect(body.checks.llmAvailable).toBe(false);
    });

    it('should report correct llmProvider', async () => {
      mockQuery.mockResolvedValueOnce({
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
      const response = await app.inject({ method: 'GET', url: '/api/health/start' });
      const body = JSON.parse(response.body);
      expect(body.checks.llmProvider).toBe('openai');
    });
  });

  describe('GET /api/health (backward compat)', () => {
    it('should return full health status including LLM and live per-provider breakers', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/health' });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.status).toBe('ok');
      expect(body.services).toHaveProperty('postgres');
      expect(body.services).toHaveProperty('redis');
      expect(body.services).toHaveProperty('llm');
      expect(body).toHaveProperty('circuitBreakers');
      // New shape: circuitBreakers.providers is an array of live per-provider snapshots.
      expect(Array.isArray(body.circuitBreakers.providers)).toBe(true);
      // Dead legacy globals must no longer be reported here.
      expect(body.circuitBreakers).not.toHaveProperty('ollama');
      expect(body.circuitBreakers).not.toHaveProperty('openai');
      expect(body).toHaveProperty('llmProvider');
    });

    it('surfaces live per-provider breaker state enriched with provider names', async () => {
      mockListProviderBreakers.mockReturnValue([
        { providerId: 'uuid-a', state: 'closed', failureCount: 0, nextRetryTime: null },
        { providerId: 'uuid-b', state: 'open', failureCount: 3, nextRetryTime: 99 },
      ]);
      mockListProviders.mockResolvedValue([
        { id: 'uuid-a', name: 'Ollama Local' },
        { id: 'uuid-b', name: 'OpenAI' },
      ]);

      const response = await app.inject({ method: 'GET', url: '/api/health' });
      const body = JSON.parse(response.body);
      expect(body.circuitBreakers.providers).toEqual([
        { providerId: 'uuid-a', name: 'Ollama Local', state: 'closed', failures: 0 },
        { providerId: 'uuid-b', name: 'OpenAI', state: 'open', failures: 3 },
      ]);
    });

    it('tolerates a provider with a live breaker but no row (race during delete)', async () => {
      mockListProviderBreakers.mockReturnValue([
        { providerId: 'uuid-orphan', state: 'closed', failureCount: 0, nextRetryTime: null },
      ]);
      mockListProviders.mockResolvedValue([]);

      const response = await app.inject({ method: 'GET', url: '/api/health' });
      const body = JSON.parse(response.body);
      expect(body.circuitBreakers.providers).toEqual([
        { providerId: 'uuid-orphan', name: null, state: 'closed', failures: 0 },
      ]);
    });

    it('should report llm=false when LLM provider is unreachable', async () => {
      mockCheckHealth.mockResolvedValue({ connected: false, error: 'timeout' });

      const response = await app.inject({ method: 'GET', url: '/api/health' });
      const body = JSON.parse(response.body);
      expect(body.services.llm).toBe(false);
    });

    it('should use active provider for health check', async () => {
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

      const response = await app.inject({ method: 'GET', url: '/api/health' });
      const body = JSON.parse(response.body);
      expect(body.services.llm).toBe(true);
      expect(body.llmProvider).toBe('openai');
      expect(mockCheckHealth).toHaveBeenCalledWith(
        expect.objectContaining({ baseUrl: 'https://api.openai.com/v1' }),
      );
    });
  });
});
