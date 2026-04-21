import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';

// The route resolves the default provider by querying `llm_providers` (+ a
// per-`{usecase}` lookup via `resolveUsecase`), and calls `listModels` /
// `checkHealth` on `openai-compatible-client`. All three are mocked here.

const mockQuery = vi.fn();
vi.mock('../../core/db/postgres.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  runMigrations: vi.fn(),
  closePool: vi.fn(),
}));

const mockListModels = vi.fn();
const mockCheckHealth = vi.fn();
vi.mock('../../domains/llm/services/openai-compatible-client.js', () => ({
  listModels: (...args: unknown[]) => mockListModels(...args),
  checkHealth: (...args: unknown[]) => mockCheckHealth(...args),
  streamChat: vi.fn(),
  chat: vi.fn(),
  generateEmbedding: vi.fn(),
  invalidateDispatcher: vi.fn(),
}));

const mockResolveUsecase = vi.fn();
vi.mock('../../domains/llm/services/llm-provider-resolver.js', () => ({
  resolveUsecase: (...args: unknown[]) => mockResolveUsecase(...args),
}));

vi.mock('../../core/utils/crypto.js', () => ({
  decryptPat: (v: string) => v,
  encryptPat: (v: string) => v,
}));

const mockListProviderBreakers = vi.fn().mockReturnValue([]);
vi.mock('../../core/services/circuit-breaker.js', () => ({
  listProviderBreakers: (...args: unknown[]) => mockListProviderBreakers(...args),
}));

vi.mock('../../core/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { llmModelRoutes } from './llm-models.js';

const DEFAULT_PROVIDER_ROW = {
  id: 'prov-1',
  name: 'ollama-local',
  base_url: 'http://localhost:11434',
  api_key: null,
  auth_type: 'bearer',
  verify_ssl: true,
};

function stubDefaultProviderQuery() {
  mockQuery.mockImplementation(async (sql: string) => {
    if (/is_default = TRUE/.test(sql)) return { rows: [DEFAULT_PROVIDER_ROW] };
    if (/FROM llm_providers WHERE id =/.test(sql)) return { rows: [{ name: DEFAULT_PROVIDER_ROW.name }] };
    return { rows: [] };
  });
}

describe('llm-models routes — auth required', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(sensible);
    app.decorate('authenticate', async () => {
      throw app.httpErrors.unauthorized('Missing or invalid token');
    });
    app.decorate('requireAdmin', async () => {});
    await app.register(llmModelRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 401 for GET /api/ollama/models without auth', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/ollama/models' });
    expect(r.statusCode).toBe(401);
  });

  it('returns 401 for GET /api/ollama/status without auth', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/ollama/status' });
    expect(r.statusCode).toBe(401);
  });

  it('returns 401 for GET /api/ollama/circuit-breaker-status without auth', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/ollama/circuit-breaker-status' });
    expect(r.statusCode).toBe(401);
  });
});

describe('llm-models routes — models + status', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(sensible);
    app.decorate('authenticate', async () => {});
    app.decorate('requireAdmin', async () => {});
    await app.register(llmModelRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    stubDefaultProviderQuery();
    mockCheckHealth.mockResolvedValue({ connected: true });
    mockListModels.mockResolvedValue([]);
  });

  // --- GET /api/ollama/models ---

  it('returns a list of models from the default provider', async () => {
    mockListModels.mockResolvedValue([{ name: 'qwen3.5' }, { name: 'llama3' }]);
    const r = await app.inject({ method: 'GET', url: '/api/ollama/models' });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body).toHaveLength(2);
    expect(body[0].name).toBe('qwen3.5');
    expect(body[1].name).toBe('llama3');
  });

  it('resolves via resolveUsecase when ?usecase=embedding is passed', async () => {
    mockResolveUsecase.mockResolvedValue({
      config: {
        providerId: 'prov-2',
        baseUrl: 'http://localhost:11434',
        apiKey: null,
        authType: 'none',
        verifySsl: true,
      },
      model: 'bge-m3',
    });
    mockListModels.mockResolvedValue([{ name: 'bge-m3' }]);
    const r = await app.inject({ method: 'GET', url: '/api/ollama/models?usecase=embedding' });
    expect(r.statusCode).toBe(200);
    expect(mockResolveUsecase).toHaveBeenCalledWith('embedding');
    expect(r.json()).toEqual([{ name: 'bge-m3' }]);
  });

  it('returns [] when the default provider is unreachable (graceful degradation)', async () => {
    mockListModels.mockRejectedValue(new Error('Connection refused'));
    const r = await app.inject({ method: 'GET', url: '/api/ollama/models' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual([]);
  });

  it('returns [] when no default provider is configured', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const r = await app.inject({ method: 'GET', url: '/api/ollama/models' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual([]);
  });

  // --- GET /api/ollama/circuit-breaker-status ---

  it('returns a flat map keyed by providerId', async () => {
    mockListProviderBreakers.mockReturnValue([
      { providerId: 'prov-1', state: 'closed', failureCount: 0, nextRetryTime: null },
      { providerId: 'prov-2', state: 'open', failureCount: 3, nextRetryTime: 1_700_000_000_000 },
    ]);
    const r = await app.inject({ method: 'GET', url: '/api/ollama/circuit-breaker-status' });
    expect(r.statusCode).toBe(200);
    const body = r.json() as Record<string, { state: string; failureCount: number; nextRetryTime: number | null }>;
    // Flat Record<providerId, {…}> — no more `{ ollama, openai }` wrapper.
    expect(body).not.toHaveProperty('ollama');
    expect(body).not.toHaveProperty('openai');
    expect(body['prov-1']).toEqual({ state: 'closed', failureCount: 0, nextRetryTime: null });
    expect(body['prov-2']).toEqual({
      state: 'open',
      failureCount: 3,
      nextRetryTime: 1_700_000_000_000,
    });
  });

  it('returns an empty object when no provider breakers have booted yet', async () => {
    mockListProviderBreakers.mockReturnValue([]);
    const r = await app.inject({ method: 'GET', url: '/api/ollama/circuit-breaker-status' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({});
  });
});
