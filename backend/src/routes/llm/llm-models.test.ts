import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';

// --- Mock: ollama-service ---
const mockListModels = vi.fn();
const mockCheckHealth = vi.fn();
const mockIsLlmVerifySslEnabled = vi.fn().mockReturnValue(true);
const mockGetLlmAuthType = vi.fn().mockReturnValue('bearer');

vi.mock('../../domains/llm/services/ollama-service.js', () => {
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

// --- Mock: circuit-breaker ---
const mockGetOllamaCircuitBreakerStatus = vi.fn().mockReturnValue({
  chat: { state: 'CLOSED' },
  embed: { state: 'CLOSED' },
  list: { state: 'CLOSED' },
});
const mockGetOpenaiCircuitBreakerStatus = vi.fn().mockReturnValue({
  chat: { state: 'CLOSED' },
  embed: { state: 'CLOSED' },
  list: { state: 'CLOSED' },
});

vi.mock('../../core/services/circuit-breaker.js', () => ({
  getOllamaCircuitBreakerStatus: (...args: unknown[]) => mockGetOllamaCircuitBreakerStatus(...args),
  getOpenaiCircuitBreakerStatus: (...args: unknown[]) => mockGetOpenaiCircuitBreakerStatus(...args),
  ollamaBreakers: {
    chat: { execute: vi.fn((fn: () => unknown) => fn()) },
    embed: { execute: vi.fn((fn: () => unknown) => fn()) },
    list: { execute: vi.fn((fn: () => unknown) => fn()) },
  },
}));

// --- Mock: postgres ---
vi.mock('../../core/db/postgres.js', () => ({
  query: vi.fn().mockResolvedValue({ rows: [] }),
  runMigrations: vi.fn(),
  closePool: vi.fn(),
}));

// --- Mock: logger ---
vi.mock('../../core/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// --- Mock: admin-settings-service ---
const mockGetSharedLlmSettings = vi.fn().mockResolvedValue({
  llmProvider: 'ollama',
  ollamaModel: 'qwen3.5',
  openaiBaseUrl: null,
  hasOpenaiApiKey: false,
  openaiModel: null,
  embeddingModel: 'nomic-embed-text',
});

vi.mock('../../core/services/admin-settings-service.js', () => ({
  getSharedLlmSettings: (...args: unknown[]) => mockGetSharedLlmSettings(...args),
}));

import { llmModelRoutes } from './llm-models.js';

// =============================================================================
// Test Suite 1: Auth-required tests
// =============================================================================

describe('llm-models routes - auth required', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(sensible);

    app.decorate('authenticate', async () => {
      throw app.httpErrors.unauthorized('Missing or invalid token');
    });
    app.decorate('requireAdmin', async () => {});
    app.decorate('redis', {});

    await app.register(llmModelRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('should return 401 for GET /api/ollama/models without auth', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/ollama/models',
    });

    expect(response.statusCode).toBe(401);
  });

  it('should return 401 for GET /api/ollama/status without auth', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/ollama/status',
    });

    expect(response.statusCode).toBe(401);
  });

  it('should return 401 for GET /api/ollama/circuit-breaker-status without auth', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/ollama/circuit-breaker-status',
    });

    expect(response.statusCode).toBe(401);
  });
});

// =============================================================================
// Test Suite 2: Model listing and status
// =============================================================================

describe('llm-models routes - models and status', () => {
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

    await app.register(llmModelRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSharedLlmSettings.mockResolvedValue({
      llmProvider: 'ollama',
      ollamaModel: 'qwen3.5',
      openaiBaseUrl: null,
      hasOpenaiApiKey: false,
      openaiModel: null,
      embeddingModel: 'nomic-embed-text',
    });
  });

  // --- GET /api/ollama/models ---

  it('should return a list of available models', async () => {
    mockListModels.mockResolvedValue([
      { name: 'qwen3.5', size: 4_000_000_000, modifiedAt: new Date(), digest: 'abc123' },
      { name: 'llama3', size: 8_000_000_000, modifiedAt: new Date(), digest: 'def456' },
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

  it('should return empty list when LLM provider is unavailable (graceful degradation)', async () => {
    mockListModels.mockRejectedValue(new Error('Connection refused'));

    const response = await app.inject({
      method: 'GET',
      url: '/api/ollama/models',
    });

    // Graceful degradation: returns 200 with empty array instead of 503
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toEqual([]);
  });

  it('should return empty list when LLM throws timeout error', async () => {
    mockListModels.mockRejectedValue(new Error('request timed out'));

    const response = await app.inject({
      method: 'GET',
      url: '/api/ollama/models',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toEqual([]);
  });

  // --- GET /api/ollama/circuit-breaker-status ---

  it('should return circuit breaker status for both providers', async () => {
    mockGetOllamaCircuitBreakerStatus.mockReturnValue({
      chat: { state: 'CLOSED' },
      embed: { state: 'CLOSED' },
      list: { state: 'CLOSED' },
    });
    mockGetOpenaiCircuitBreakerStatus.mockReturnValue({
      chat: { state: 'OPEN' },
      embed: { state: 'CLOSED' },
      list: { state: 'CLOSED' },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/ollama/circuit-breaker-status',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.ollama).toBeDefined();
    expect(body.openai).toBeDefined();
    expect(body.ollama.chat.state).toBe('CLOSED');
    expect(body.openai.chat.state).toBe('OPEN');
  });

  // --- GET /api/ollama/status ---

  it('should return connected status with provider info', async () => {
    mockCheckHealth.mockResolvedValue({ connected: true });

    const response = await app.inject({
      method: 'GET',
      url: '/api/ollama/status',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.connected).toBe(true);
    expect(body.provider).toBe('ollama');
    expect(body.ollamaBaseUrl).toBeDefined();
    expect(body.embeddingModel).toBe('nomic-embed-text');
    expect(typeof body.authConfigured).toBe('boolean');
    expect(typeof body.verifySsl).toBe('boolean');
    expect(body.authType).toBeDefined();
  });

  it('should return disconnected status with error', async () => {
    mockCheckHealth.mockResolvedValue({ connected: false, error: 'ECONNREFUSED' });

    const response = await app.inject({
      method: 'GET',
      url: '/api/ollama/status',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.connected).toBe(false);
    expect(body.error).toBe('ECONNREFUSED');
  });
});
