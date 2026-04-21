import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { ZodError } from 'zod';

// The route resolves the default provider by querying `llm_providers` + a
// per-`{usecase}` lookup via `resolveUsecase`, and calls `checkHealth` +
// `listModels` on `openai-compatible-client`. Mock all three at the module
// boundary.

const mockQuery = vi.fn();
vi.mock('../../core/db/postgres.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  runMigrations: vi.fn(),
  closePool: vi.fn(),
}));

const mockCheckHealth = vi.fn();
const mockListModels = vi.fn();
vi.mock('../../domains/llm/services/openai-compatible-client.js', () => ({
  checkHealth: (...args: unknown[]) => mockCheckHealth(...args),
  listModels: (...args: unknown[]) => mockListModels(...args),
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

vi.mock('../../core/services/circuit-breaker.js', () => ({
  listProviderBreakers: vi.fn().mockReturnValue([]),
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

describe('llm-models routes — /api/ollama/status', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(sensible);
    app.decorate('authenticate', async () => {});
    app.decorate('requireAdmin', async () => {});
    app.setErrorHandler((error, _req, reply) => {
      if (error instanceof ZodError) {
        reply.status(400).send({ error: 'ValidationError', statusCode: 400 });
        return;
      }
      reply.status(error.statusCode ?? 500).send({ message: error.message });
    });
    await app.register(llmModelRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckHealth.mockResolvedValue({ connected: true });
    mockListModels.mockResolvedValue([]);
    // Default provider row + name lookup.
    mockQuery.mockImplementation(async (sql: string) => {
      if (/is_default = TRUE/.test(sql)) return { rows: [DEFAULT_PROVIDER_ROW] };
      if (/FROM llm_providers WHERE id =/.test(sql)) return { rows: [{ name: DEFAULT_PROVIDER_ROW.name }] };
      return { rows: [] };
    });
  });

  it('returns connected + baseUrl + provider when a default provider is configured', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/ollama/status' });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.connected).toBe(true);
    expect(body.baseUrl).toBe('http://localhost:11434');
    expect(body.provider).toBe('ollama-local');
    expect(body.authType).toBe('bearer');
    expect(body.verifySsl).toBe(true);
    expect(body.authConfigured).toBe(false);
  });

  it('returns authConfigured=true when the provider row has an api_key', async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (/is_default = TRUE/.test(sql)) return { rows: [{ ...DEFAULT_PROVIDER_ROW, api_key: 'sk-xxxx' }] };
      if (/FROM llm_providers WHERE id =/.test(sql)) return { rows: [{ name: 'ollama-local' }] };
      return { rows: [] };
    });
    const r = await app.inject({ method: 'GET', url: '/api/ollama/status' });
    expect(r.json().authConfigured).toBe(true);
  });

  it('returns connected=false with error when upstream health check fails', async () => {
    mockCheckHealth.mockResolvedValue({ connected: false, error: 'fetch failed' });
    const r = await app.inject({ method: 'GET', url: '/api/ollama/status' });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.connected).toBe(false);
    expect(body.error).toBe('fetch failed');
  });

  it('returns the "no default provider" error when llm_providers is empty', async () => {
    mockQuery.mockImplementation(async () => ({ rows: [] }));
    const r = await app.inject({ method: 'GET', url: '/api/ollama/status' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({
      connected: false,
      error: 'No default provider configured',
    });
  });

  it('resolves via resolveUsecase when ?usecase=chat is passed', async () => {
    mockResolveUsecase.mockResolvedValue({
      config: {
        providerId: 'prov-2',
        name: 'openai-main',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-xxxx',
        authType: 'bearer',
        verifySsl: true,
      },
      model: 'gpt-4o-mini',
    });
    const r = await app.inject({ method: 'GET', url: '/api/ollama/status?usecase=chat' });
    expect(r.statusCode).toBe(200);
    expect(mockResolveUsecase).toHaveBeenCalledWith('chat');
    const body = r.json();
    expect(body.provider).toBe('openai-main');
    expect(body.baseUrl).toBe('https://api.openai.com/v1');
    expect(body.authConfigured).toBe(true);
  });

  it('rejects invalid usecase values with 400', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/ollama/status?usecase=not-a-usecase' });
    expect(r.statusCode).toBe(400);
  });
});
