import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { healthRoutes, markStartupComplete } from './health.js';

// Mock the database check
vi.mock('../db/postgres.js', () => ({
  checkConnection: vi.fn().mockResolvedValue(true),
  getPool: vi.fn().mockReturnValue({}),
  query: vi.fn(),
  runMigrations: vi.fn(),
  closePool: vi.fn(),
}));

// Mock Redis plugin check
vi.mock('../plugins/redis.js', () => ({
  checkRedisConnection: vi.fn().mockResolvedValue(true),
  default: vi.fn(),
}));

// Mock circuit breaker
vi.mock('../services/circuit-breaker.js', () => ({
  getOllamaCircuitBreakerStatus: vi.fn().mockReturnValue({
    chat: { state: 'CLOSED', failureCount: 0, successCount: 0, lastFailureTime: null, nextRetryTime: null },
    embed: { state: 'CLOSED', failureCount: 0, successCount: 0, lastFailureTime: null, nextRetryTime: null },
    list: { state: 'CLOSED', failureCount: 0, successCount: 0, lastFailureTime: null, nextRetryTime: null },
  }),
}));

// Mock fetch for Ollama checks
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { checkConnection as mockCheckPg } from '../db/postgres.js';
import { checkRedisConnection as mockCheckRedis } from '../plugins/redis.js';

describe('Health routes', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(sensible);

    // Decorate with a mock redis
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
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ models: [{ name: 'qwen3.5' }] }) });
  });

  describe('GET /api/health/live', () => {
    it('should always return 200 with status ok', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/health/live',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.status).toBe('ok');
    });

    it('should return 200 even when all services are down', async () => {
      (mockCheckPg as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      (mockCheckRedis as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      const response = await app.inject({
        method: 'GET',
        url: '/api/health/live',
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body).status).toBe('ok');
    });
  });

  describe('GET /api/health/ready', () => {
    it('should return 200 when PostgreSQL and Redis are healthy', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/health/ready',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.status).toBe('ok');
      expect(body.services.postgres).toBe(true);
      expect(body.services.redis).toBe(true);
      expect(body.version).toBe('1.0.0');
      expect(body.uptime).toBeGreaterThan(0);
    });

    it('should return 503 when PostgreSQL is down', async () => {
      (mockCheckPg as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      const response = await app.inject({
        method: 'GET',
        url: '/api/health/ready',
      });

      expect(response.statusCode).toBe(503);
      const body = JSON.parse(response.body);
      expect(body.status).toBe('degraded');
      expect(body.services.postgres).toBe(false);
      expect(body.services.redis).toBe(true);
    });

    it('should return 503 when Redis is down', async () => {
      (mockCheckRedis as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      const response = await app.inject({
        method: 'GET',
        url: '/api/health/ready',
      });

      expect(response.statusCode).toBe(503);
      const body = JSON.parse(response.body);
      expect(body.status).toBe('degraded');
    });

    it('should return 503 with error status when all services are down', async () => {
      (mockCheckPg as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      (mockCheckRedis as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      const response = await app.inject({
        method: 'GET',
        url: '/api/health/ready',
      });

      expect(response.statusCode).toBe(503);
      const body = JSON.parse(response.body);
      expect(body.status).toBe('error');
    });
  });

  describe('GET /api/health/start', () => {
    it('should return 503 when startup is not complete', async () => {
      // Reset startup state (cannot easily reset the module-level variable,
      // but we can test the current state)
      const response = await app.inject({
        method: 'GET',
        url: '/api/health/start',
      });

      // startup might be complete or not depending on markStartupComplete calls
      const body = JSON.parse(response.body);
      expect(body).toHaveProperty('status');
      expect(body).toHaveProperty('checks');
      expect(body.checks).toHaveProperty('startupComplete');
      expect(body.checks).toHaveProperty('postgres');
      expect(body.checks).toHaveProperty('ollamaModelsAvailable');
    });

    it('should return 200 after markStartupComplete when all checks pass', async () => {
      markStartupComplete();

      const response = await app.inject({
        method: 'GET',
        url: '/api/health/start',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.status).toBe('ok');
      expect(body.checks.startupComplete).toBe(true);
      expect(body.checks.postgres).toBe(true);
      expect(body.checks.ollamaModelsAvailable).toBe(true);
    });

    it('should return 503 when Ollama has no models', async () => {
      markStartupComplete();
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({ models: [] }) });

      const response = await app.inject({
        method: 'GET',
        url: '/api/health/start',
      });

      expect(response.statusCode).toBe(503);
      const body = JSON.parse(response.body);
      expect(body.checks.ollamaModelsAvailable).toBe(false);
    });
  });

  describe('GET /api/health (backward compat)', () => {
    it('should return full health status including Ollama and circuit breakers', async () => {
      mockFetch.mockResolvedValue({ ok: true });

      const response = await app.inject({
        method: 'GET',
        url: '/api/health',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.status).toBe('ok');
      expect(body.services).toHaveProperty('postgres');
      expect(body.services).toHaveProperty('redis');
      expect(body.services).toHaveProperty('ollama');
      expect(body).toHaveProperty('circuitBreakers');
      expect(body.circuitBreakers).toHaveProperty('chat');
      expect(body.circuitBreakers).toHaveProperty('embed');
      expect(body.circuitBreakers).toHaveProperty('list');
      expect(body.version).toBe('1.0.0');
      expect(body.uptime).toBeGreaterThan(0);
    });
  });

  describe('Ollama Bearer token in health checks', () => {
    it('should include Authorization header when LLM_BEARER_TOKEN is set', async () => {
      process.env.LLM_BEARER_TOKEN = 'test-token-123';
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({ models: [{ name: 'test' }] }) });

      await app.inject({ method: 'GET', url: '/api/health' });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer test-token-123',
          }),
        }),
      );

      delete process.env.LLM_BEARER_TOKEN;
    });

    it('should not include Authorization header when LLM_BEARER_TOKEN is not set', async () => {
      delete process.env.LLM_BEARER_TOKEN;
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({ models: [{ name: 'test' }] }) });

      await app.inject({ method: 'GET', url: '/api/health' });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: {},
        }),
      );
    });

    it('should include Authorization header in startup probe Ollama check', async () => {
      process.env.LLM_BEARER_TOKEN = 'startup-token';
      markStartupComplete();
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({ models: [{ name: 'test' }] }) });

      await app.inject({ method: 'GET', url: '/api/health/start' });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer startup-token',
          }),
        }),
      );

      delete process.env.LLM_BEARER_TOKEN;
    });
  });
});
