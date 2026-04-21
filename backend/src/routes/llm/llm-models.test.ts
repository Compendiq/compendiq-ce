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

  it('returns 401 for GET /api/llm/circuit-breaker-status without auth', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/llm/circuit-breaker-status' });
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

  // --- GET /api/llm/circuit-breaker-status (canonical) + /api/ollama/circuit-breaker-status (deprecated alias, issue #266) ---

  it('GET /api/llm/circuit-breaker-status returns the provider-keyed flat map with no deprecation headers', async () => {
    mockListProviderBreakers.mockReturnValue([
      { providerId: 'p1', state: 'closed', failureCount: 0, nextRetryTime: null },
      { providerId: 'p2', state: 'open',   failureCount: 3, nextRetryTime: 123 },
    ]);
    const r = await app.inject({ method: 'GET', url: '/api/llm/circuit-breaker-status' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({
      p1: { state: 'closed', failureCount: 0, nextRetryTime: null },
      p2: { state: 'open',   failureCount: 3, nextRetryTime: 123 },
    });
    expect(r.headers['deprecation']).toBeUndefined();
    expect(r.headers['sunset']).toBeUndefined();
    expect(r.headers['link']).toBeUndefined();
  });

  it('GET /api/ollama/circuit-breaker-status is a deprecated alias with RFC 9745 / 8594 headers and parity payload', async () => {
    mockListProviderBreakers.mockReturnValue([
      { providerId: 'p1', state: 'closed', failureCount: 0, nextRetryTime: null },
    ]);
    const r = await app.inject({ method: 'GET', url: '/api/ollama/circuit-breaker-status' });
    expect(r.statusCode).toBe(200);
    // Payload parity with the canonical route.
    expect(r.json()).toEqual({
      p1: { state: 'closed', failureCount: 0, nextRetryTime: null },
    });
    // RFC 9745 Structured Item — `@`-prefixed Unix epoch. NOT "true".
    expect(r.headers['deprecation']).toMatch(/^@\d+$/);
    expect(r.headers['deprecation']).not.toBe('true');
    // RFC 8594 IMF-fixdate.
    expect(r.headers['sunset']).toMatch(
      /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/,
    );
    // RFC 9745 §2 successor-version link pointing at the canonical path.
    expect(r.headers['link']).toBe('</api/llm/circuit-breaker-status>; rel="successor-version"');
  });

  it('Sunset date is strictly after Deprecation date on the deprecated alias (RFC 9745 constraint)', async () => {
    mockListProviderBreakers.mockReturnValue([]);
    const r = await app.inject({ method: 'GET', url: '/api/ollama/circuit-breaker-status' });
    expect(r.statusCode).toBe(200);
    const depEpochMs = parseInt((r.headers['deprecation'] as string).slice(1), 10) * 1000;
    const sunsetEpochMs = new Date(r.headers['sunset'] as string).getTime();
    expect(Number.isFinite(sunsetEpochMs)).toBe(true);
    expect(sunsetEpochMs).toBeGreaterThan(depEpochMs);
  });
});
