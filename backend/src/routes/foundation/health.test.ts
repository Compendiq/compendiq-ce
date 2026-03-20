import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { healthRoutes, markStartupComplete } from './health.js';

// Mock the database check
vi.mock('../../core/db/postgres.js', () => ({
  checkConnection: vi.fn().mockResolvedValue(true),
  getPool: vi.fn().mockReturnValue({}),
  query: vi.fn(),
  runMigrations: vi.fn(),
  closePool: vi.fn(),
}));

// Mock Redis plugin check
vi.mock('../../core/plugins/redis.js', () => ({
  checkRedisConnection: vi.fn().mockResolvedValue(true),
  default: vi.fn(),
}));

// Mock circuit breakers
vi.mock('../../core/services/circuit-breaker.js', () => {
  const closedBreaker = { state: 'CLOSED', failureCount: 0, successCount: 0, lastFailureTime: null, nextRetryTime: null };
  return {
    getOllamaCircuitBreakerStatus: vi.fn().mockReturnValue({
      chat: closedBreaker, embed: closedBreaker, list: closedBreaker,
    }),
    getOpenaiCircuitBreakerStatus: vi.fn().mockReturnValue({
      chat: closedBreaker, embed: closedBreaker, list: closedBreaker,
    }),
  };
});

// Mock the LLM service (provider-aware health check)
const mockCheckHealth = vi.fn().mockResolvedValue({ connected: true });
const mockGetProvider = vi.fn().mockReturnValue({ checkHealth: (...args: unknown[]) => mockCheckHealth(...args) });

vi.mock('../../domains/llm/services/ollama-service.js', () => ({
  getProvider: (...args: unknown[]) => mockGetProvider(...args),
}));

const mockGetSharedLlmSettings = vi.fn().mockResolvedValue({
  llmProvider: 'ollama',
});
vi.mock('../../core/services/admin-settings-service.js', () => ({
  getSharedLlmSettings: (...args: unknown[]) => mockGetSharedLlmSettings(...args),
}));

vi.mock('../../core/utils/logger.js', () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
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
    mockGetSharedLlmSettings.mockResolvedValue({ llmProvider: 'ollama' });
    mockGetProvider.mockReturnValue({ checkHealth: (...args: unknown[]) => mockCheckHealth(...args) });
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
      mockGetSharedLlmSettings.mockResolvedValueOnce({ llmProvider: 'openai' });
      const response = await app.inject({ method: 'GET', url: '/api/health/start' });
      const body = JSON.parse(response.body);
      expect(body.checks.llmProvider).toBe('openai');
    });
  });

  describe('GET /api/health (backward compat)', () => {
    it('should return full health status including LLM and circuit breakers', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/health' });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.status).toBe('ok');
      expect(body.services).toHaveProperty('postgres');
      expect(body.services).toHaveProperty('redis');
      expect(body.services).toHaveProperty('llm');
      expect(body).toHaveProperty('circuitBreakers');
      expect(body.circuitBreakers).toHaveProperty('ollama');
      expect(body.circuitBreakers).toHaveProperty('openai');
      expect(body).toHaveProperty('llmProvider');
    });

    it('should report llm=false when LLM provider is unreachable', async () => {
      mockCheckHealth.mockResolvedValue({ connected: false, error: 'timeout' });

      const response = await app.inject({ method: 'GET', url: '/api/health' });
      const body = JSON.parse(response.body);
      expect(body.services.llm).toBe(false);
    });

    it('should use active provider for health check', async () => {
      mockGetSharedLlmSettings.mockResolvedValue({ llmProvider: 'openai' });
      mockCheckHealth.mockResolvedValue({ connected: true });

      const response = await app.inject({ method: 'GET', url: '/api/health' });
      const body = JSON.parse(response.body);
      expect(body.services.llm).toBe(true);
      expect(body.llmProvider).toBe('openai');
      expect(mockGetProvider).toHaveBeenCalledWith('openai');
    });
  });
});
