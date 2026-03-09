import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';

// Mock ollama-service
const mockListModels = vi.fn();
const mockCheckHealth = vi.fn();

const mockIsLlmVerifySslEnabled = vi.fn().mockReturnValue(true);
const mockGetLlmAuthType = vi.fn().mockReturnValue('bearer');

vi.mock('../services/ollama-service.js', () => {
  const listModels = (...args: unknown[]) => mockListModels(...args);
  const checkHealth = (...args: unknown[]) => mockCheckHealth(...args);
  const mockProvider = {
    name: 'ollama',
    listModels,
    checkHealth,
    streamChat: vi.fn(),
    chat: vi.fn(),
    generateEmbedding: vi.fn(),
  };
  return {
    listModels,
    checkHealth,
    isLlmVerifySslEnabled: (...args: unknown[]) => mockIsLlmVerifySslEnabled(...args),
    getLlmAuthType: (...args: unknown[]) => mockGetLlmAuthType(...args),
    streamChat: vi.fn(),
    chat: vi.fn(),
    getSystemPrompt: vi.fn(),
    generateEmbedding: vi.fn(),
    getActiveProviderType: vi.fn().mockReturnValue('ollama'),
    getProvider: vi.fn().mockReturnValue(mockProvider),
  };
});

vi.mock('../services/circuit-breaker.js', () => ({
  getOllamaCircuitBreakerStatus: vi.fn().mockReturnValue({
    chat: { state: 'CLOSED' },
    embed: { state: 'CLOSED' },
    list: { state: 'CLOSED' },
  }),
  ollamaBreakers: {
    chat: { execute: vi.fn((fn: () => unknown) => fn()) },
    embed: { execute: vi.fn((fn: () => unknown) => fn()) },
    list: { execute: vi.fn((fn: () => unknown) => fn()) },
  },
}));

vi.mock('../db/postgres.js', () => ({
  query: vi.fn().mockResolvedValue({ rows: [] }),
  runMigrations: vi.fn(),
  closePool: vi.fn(),
}));

vi.mock('../services/rag-service.js', () => ({
  hybridSearch: vi.fn(),
  buildRagContext: vi.fn(),
}));

vi.mock('../services/content-converter.js', () => ({
  htmlToMarkdown: vi.fn((html: string) => html),
}));

vi.mock('../services/embedding-service.js', () => ({
  getEmbeddingStatus: vi.fn(),
  processDirtyPages: vi.fn(),
  reEmbedAll: vi.fn(),
}));

vi.mock('../services/llm-cache.js', () => {
  class MockLlmCache {
    getCachedResponse = vi.fn().mockResolvedValue(null);
    setCachedResponse = vi.fn();
    clearAll = vi.fn();
  }
  return {
    LlmCache: MockLlmCache,
    buildLlmCacheKey: vi.fn(),
    buildRagCacheKey: vi.fn(),
  };
});

vi.mock('../services/audit-service.js', () => ({
  logAuditEvent: vi.fn(),
}));

vi.mock('../utils/sanitize-llm-input.js', () => ({
  sanitizeLlmInput: vi.fn((input: string) => ({ sanitized: input, warnings: [] })),
}));

import { llmRoutes } from './llm.js';

describe('Ollama status and models routes', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(sensible);

    // Decorate with mock auth and redis
    app.decorate('authenticate', async () => {});
    app.decorate('requireAdmin', async () => {});
    app.decorate('redis', {});
    app.decorateRequest('userId', '');
    app.addHook('onRequest', async (request) => {
      request.userId = 'test-user-123';
    });

    await app.register(llmRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /api/ollama/status', () => {
    it('should return connected status with ollamaBaseUrl', async () => {
      mockCheckHealth.mockResolvedValue({ connected: true });

      const response = await app.inject({
        method: 'GET',
        url: '/api/ollama/status',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.connected).toBe(true);
      expect(body.ollamaBaseUrl).toBeDefined();
      expect(typeof body.ollamaBaseUrl).toBe('string');
      expect(body.embeddingModel).toBeDefined();
      expect(typeof body.authConfigured).toBe('boolean');
    });

    it('should return disconnected status with error when Ollama is unreachable', async () => {
      mockCheckHealth.mockResolvedValue({ connected: false, error: 'fetch failed' });

      const response = await app.inject({
        method: 'GET',
        url: '/api/ollama/status',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.connected).toBe(false);
      expect(body.error).toBe('fetch failed');
      expect(body.ollamaBaseUrl).toBeDefined();
    });

    it('should return default ollamaBaseUrl when env var is not set', async () => {
      mockCheckHealth.mockResolvedValue({ connected: true });
      const originalUrl = process.env.OLLAMA_BASE_URL;
      delete process.env.OLLAMA_BASE_URL;

      const response = await app.inject({
        method: 'GET',
        url: '/api/ollama/status',
      });

      const body = JSON.parse(response.body);
      expect(body.ollamaBaseUrl).toBe('http://localhost:11434');

      // Restore
      if (originalUrl) process.env.OLLAMA_BASE_URL = originalUrl;
    });

    it('should return authConfigured=false when LLM_BEARER_TOKEN is not set', async () => {
      mockCheckHealth.mockResolvedValue({ connected: true });
      const originalToken = process.env.LLM_BEARER_TOKEN;
      delete process.env.LLM_BEARER_TOKEN;

      const response = await app.inject({
        method: 'GET',
        url: '/api/ollama/status',
      });

      const body = JSON.parse(response.body);
      expect(body.authConfigured).toBe(false);

      // Restore
      if (originalToken) process.env.LLM_BEARER_TOKEN = originalToken;
    });

    it('should return authConfigured=true when LLM_BEARER_TOKEN is set', async () => {
      mockCheckHealth.mockResolvedValue({ connected: true });
      const originalToken = process.env.LLM_BEARER_TOKEN;
      process.env.LLM_BEARER_TOKEN = 'test-token';

      const response = await app.inject({
        method: 'GET',
        url: '/api/ollama/status',
      });

      const body = JSON.parse(response.body);
      expect(body.authConfigured).toBe(true);

      // Restore
      if (originalToken) {
        process.env.LLM_BEARER_TOKEN = originalToken;
      } else {
        delete process.env.LLM_BEARER_TOKEN;
      }
    });

    it('should return authType and verifySsl in status response', async () => {
      mockCheckHealth.mockResolvedValue({ connected: true });
      mockGetLlmAuthType.mockReturnValue('bearer');
      mockIsLlmVerifySslEnabled.mockReturnValue(false);

      const response = await app.inject({
        method: 'GET',
        url: '/api/ollama/status',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.authType).toBe('bearer');
      expect(body.verifySsl).toBe(false);
    });

    it('should return verifySsl=true when SSL verification is enabled', async () => {
      mockCheckHealth.mockResolvedValue({ connected: true });
      mockIsLlmVerifySslEnabled.mockReturnValue(true);

      const response = await app.inject({
        method: 'GET',
        url: '/api/ollama/status',
      });

      const body = JSON.parse(response.body);
      expect(body.verifySsl).toBe(true);
    });

    it('should return authType=none when configured', async () => {
      mockCheckHealth.mockResolvedValue({ connected: true });
      mockGetLlmAuthType.mockReturnValue('none');

      const response = await app.inject({
        method: 'GET',
        url: '/api/ollama/status',
      });

      const body = JSON.parse(response.body);
      expect(body.authType).toBe('none');
    });
  });

  describe('GET /api/ollama/models', () => {
    it('should return list of models', async () => {
      mockListModels.mockResolvedValue([
        { name: 'qwen3.5', size: 4000000000, modifiedAt: new Date(), digest: 'abc123' },
        { name: 'llama3', size: 8000000000, modifiedAt: new Date(), digest: 'def456' },
      ]);

      const response = await app.inject({
        method: 'GET',
        url: '/api/ollama/models',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body).toHaveLength(2);
      expect(body[0].name).toBe('qwen3.5');
      expect(body[1].name).toBe('llama3');
    });

    it('should return 503 with error details when Ollama is unavailable', async () => {
      mockListModels.mockRejectedValue(new Error('Connection refused'));

      const response = await app.inject({
        method: 'GET',
        url: '/api/ollama/models',
      });

      expect(response.statusCode).toBe(503);
      const body = JSON.parse(response.body);
      expect(body.message).toContain('LLM server unavailable');
      expect(body.message).toContain('Connection refused');
    });
  });
});
