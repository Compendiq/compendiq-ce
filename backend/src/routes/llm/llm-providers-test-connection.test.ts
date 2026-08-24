import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { ZodError } from 'zod';
import { LlmHttpError } from '../../domains/llm/services/llm-http-error.js';

vi.mock('../../core/db/postgres.js', () => ({
  query: vi.fn(async () => ({ rows: [] })),
  getPool: () => ({ connect: async () => ({ query: vi.fn(async () => ({ rows: [] })), release: vi.fn() }) }),
}));

const svc = vi.hoisted(() => ({
  getById: vi.fn(async () => null),
}));
vi.mock('../../domains/llm/services/llm-provider-service.js', () => ({
  listProviders: vi.fn(async () => []),
  createProvider: vi.fn(),
  updateProvider: vi.fn(),
  deleteProvider: vi.fn(),
  setDefaultProvider: vi.fn(),
  getProviderById: (...a: unknown[]) => svc.getById(...(a as [])),
}));

const llm = vi.hoisted(() => ({
  checkHealth: vi.fn(async () => ({ connected: true })),
  listModels: vi.fn(async () => [{ name: 'gpt-4o' }]),
}));
vi.mock('../../domains/llm/services/openai-compatible-client.js', () => ({
  checkHealth: (...a: unknown[]) => llm.checkHealth(...(a as [])),
  listModels: (...a: unknown[]) => llm.listModels(...(a as [])),
  invalidateBreaker: vi.fn(),
  invalidateDispatcher: vi.fn(),
}));

vi.mock('../../domains/llm/services/llm-audit-hook.js', () => ({ emitLlmAudit: vi.fn() }));
vi.mock('../../core/services/rate-limit-service.js', () => ({
  getRateLimits: vi.fn(async () => ({ admin: { max: 1000 } })),
}));
vi.mock('../../domains/llm/services/shadow-migration-service.js', () => ({
  getShadowMigrationState: vi.fn(async () => null),
}));

const { llmProviderRoutes } = await import('./llm-providers.js');

const PROVIDER_ID = '2c0c8a92-98a8-4f8c-a6a1-000000000001';

describe('POST /api/admin/llm-providers/test', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(sensible);
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof ZodError) {
        reply.status(400).send({ error: 'ValidationError', statusCode: 400 });
        return;
      }
      reply.status(error.statusCode ?? 500).send({ error: error.name, statusCode: error.statusCode ?? 500 });
    });
    app.decorate('authenticate', async (request: { userId: string }) => {
      request.userId = 'admin-1';
    });
    app.decorate('requireAdmin', async () => {});
    await app.register(llmProviderRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    llm.listModels.mockResolvedValue([{ name: 'gpt-4o' }, { name: 'gpt-4.1-mini' }]);
    llm.checkHealth.mockResolvedValue({ connected: true });
    svc.getById.mockResolvedValue(null);
  });

  it('returns connected + listed models for a draft hosted provider', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/llm-providers/test',
      payload: {
        baseUrl: 'https://api.openai.com/v1',
        authType: 'bearer',
        verifySsl: true,
        apiKey: 'sk-dummy-not-a-real-key',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      connected: true,
      models: ['gpt-4o', 'gpt-4.1-mini'],
      sampleModelsCount: 2,
    });
    expect(JSON.stringify(res.json())).not.toMatch(/sk-/);
    expect(llm.listModels).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-dummy-not-a-real-key',
        authType: 'bearer',
      }),
    );
    const draftId = llm.listModels.mock.calls[0]?.[0] as { providerId: string };
    expect(draftId.providerId).toMatch(/^probe:/);
    expect(draftId.providerId).not.toBe('probe:https://api.openai.com/v1');
  });

  it('gives each draft probe a unique breaker id so 401s do not open a shared breaker', async () => {
    llm.listModels.mockRejectedValue(new LlmHttpError('listModels', 401, 'bad key'));
    const payload = {
      baseUrl: 'https://api.openai.com/v1',
      authType: 'bearer' as const,
      verifySsl: true,
      apiKey: 'sk-dummy-not-a-real-key',
    };
    await app.inject({ method: 'POST', url: '/api/admin/llm-providers/test', payload });
    await app.inject({ method: 'POST', url: '/api/admin/llm-providers/test', payload });
    llm.listModels.mockResolvedValue([{ name: 'gpt-4o' }]);
    const third = await app.inject({ method: 'POST', url: '/api/admin/llm-providers/test', payload });
    expect(third.statusCode).toBe(200);
    expect(third.json().connected).toBe(true);
    const ids = llm.listModels.mock.calls.map((c) => (c[0] as { providerId: string }).providerId);
    expect(new Set(ids).size).toBe(3);
    expect(ids.every((id) => id.startsWith('probe:') && id !== 'probe:https://api.openai.com/v1')).toBe(true);
    const { invalidateBreaker } = await import('../../domains/llm/services/openai-compatible-client.js');
    expect(vi.mocked(invalidateBreaker).mock.calls.map((c) => c[0])).toEqual(ids);
  });

  it('sanitizes a 401 as a bad key and never echoes the secret or upstream body', async () => {
    llm.listModels.mockRejectedValue(
      new LlmHttpError('listModels', 401, 'incorrect API key provided: sk-dummy-not-a-real-key'),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/llm-providers/test',
      payload: {
        baseUrl: 'https://api.openai.com/v1',
        authType: 'bearer',
        verifySsl: true,
        apiKey: 'sk-dummy-not-a-real-key',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.connected).toBe(false);
    expect(body.error).toMatch(/api key was rejected/i);
    expect(JSON.stringify(body)).not.toMatch(/sk-/);
    expect(JSON.stringify(body)).not.toMatch(/incorrect API key/i);
  });

  it('sanitizes a timeout as unreachable', async () => {
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    llm.listModels.mockRejectedValue(err);
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/llm-providers/test',
      payload: {
        baseUrl: 'http://127.0.0.1:9/v1',
        authType: 'none',
        verifySsl: true,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().connected).toBe(false);
    expect(res.json().error).toMatch(/did not respond in time/i);
  });

  it('uses the stored key when providerId is given and the draft key is omitted', async () => {
    svc.getById.mockResolvedValue({
      id: PROVIDER_ID,
      baseUrl: 'https://api.mistral.ai/v1',
      apiKey: 'sk-stored-secret',
      authType: 'bearer',
      verifySsl: true,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/llm-providers/test',
      payload: {
        providerId: PROVIDER_ID,
        baseUrl: 'https://api.mistral.ai/v1',
        authType: 'bearer',
        verifySsl: true,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().connected).toBe(true);
    expect(llm.listModels).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: PROVIDER_ID, apiKey: 'sk-stored-secret' }),
    );
    expect(JSON.stringify(res.json())).not.toMatch(/sk-/);
  });

  it('keeps POST /:id/test on the same probe path (sampleModelsCount + models)', async () => {
    svc.getById.mockResolvedValue({
      id: PROVIDER_ID,
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-stored',
      authType: 'bearer',
      verifySsl: true,
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/admin/llm-providers/${PROVIDER_ID}/test`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      connected: true,
      sampleModelsCount: 2,
      models: ['gpt-4o', 'gpt-4.1-mini'],
    });
    expect(JSON.stringify(res.json())).not.toMatch(/sk-/);
  });

  it('does not write use-case assignments', async () => {
    const { query } = await import('../../core/db/postgres.js');
    await app.inject({
      method: 'POST',
      url: '/api/admin/llm-providers/test',
      payload: {
        baseUrl: 'https://api.deepseek.com/v1',
        authType: 'bearer',
        verifySsl: true,
        apiKey: 'sk-dummy',
      },
    });
    const sql = vi.mocked(query).mock.calls.map((c) => String(c[0]));
    expect(sql.some((s) => /llm_usecase_assignments/i.test(s))).toBe(false);
  });
});
