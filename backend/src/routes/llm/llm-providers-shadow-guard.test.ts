import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { ZodError } from 'zod';

// #1116 review r2: when the embedding use case INHERITS the default provider,
// repointing the default (set-default, or patching a provider's defaultModel)
// changes the live embedding model just like an assignment edit would — so it
// must be refused while a shadow migration runs, mirroring the
// PUT /admin/llm-usecases pin.

const dbQuery = vi.hoisted(() => vi.fn(async (): Promise<{ rows: unknown[] }> => ({ rows: [] })));
vi.mock('../../core/db/postgres.js', () => ({
  query: (...a: unknown[]) => dbQuery(...(a as [])),
  getPool: () => ({ connect: async () => ({ query: vi.fn(async () => ({ rows: [] })), release: vi.fn() }) }),
}));
const svc = vi.hoisted(() => ({
  setDefault: vi.fn(async () => {}),
  update: vi.fn(async () => ({ id: 'p1' })),
  getById: vi.fn(async () => null),
}));
vi.mock('../../domains/llm/services/llm-provider-service.js', () => ({
  listProviders: vi.fn(async () => []),
  createProvider: vi.fn(),
  updateProvider: (...a: unknown[]) => svc.update(...(a as [])),
  deleteProvider: vi.fn(),
  setDefaultProvider: (...a: unknown[]) => svc.setDefault(...(a as [])),
  getProviderById: (...a: unknown[]) => svc.getById(...(a as [])),
}));
vi.mock('../../domains/llm/services/openai-compatible-client.js', () => ({
  checkHealth: vi.fn(async () => ({ connected: true })),
  listModels: vi.fn(async () => []),
  invalidateBreaker: vi.fn(),
  invalidateDispatcher: vi.fn(),
}));
vi.mock('../../domains/llm/services/llm-audit-hook.js', () => ({ emitLlmAudit: vi.fn() }));
vi.mock('../../core/utils/ssrf-guard.js', () => ({
  allowPrivateOrigin: vi.fn(async () => {}),
  revokePrivateOrigin: vi.fn(async () => {}),
  assertPublicHttpUrl: vi.fn(async () => {}),
}));
vi.mock('../../core/services/rate-limit-service.js', () => ({
  getRateLimits: vi.fn(async () => ({ admin: { max: 1000 } })),
}));
const shadowStateMock = vi.hoisted(() => vi.fn(async (): Promise<object | null> => null));
vi.mock('../../domains/llm/services/shadow-migration-service.js', () => ({
  getShadowMigrationState: () => shadowStateMock(),
}));

const { llmProviderRoutes } = await import('./llm-providers.js');

const PROVIDER_ID = '2c0c8a92-98a8-4f8c-a6a1-000000000001';

describe('provider default repoint guard during shadow migration (#1116 r2)', () => {
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
    shadowStateMock.mockResolvedValue(null);
    dbQuery.mockResolvedValue({ rows: [] }); // embedding assignment absent = inherits default
  });

  it('refuses set-default while a migration runs and embedding inherits the default', async () => {
    shadowStateMock.mockResolvedValue({ status: 'active' });

    const res = await app.inject({ method: 'POST', url: `/api/admin/llm-providers/${PROVIDER_ID}/set-default` });

    expect(res.statusCode).toBe(409);
    expect(svc.setDefault).not.toHaveBeenCalled();
  });

  it('allows set-default when the embedding assignment is explicit', async () => {
    shadowStateMock.mockResolvedValue({ status: 'active' });
    dbQuery.mockResolvedValue({ rows: [{ provider_id: PROVIDER_ID }] });

    const res = await app.inject({ method: 'POST', url: `/api/admin/llm-providers/${PROVIDER_ID}/set-default` });

    expect(res.statusCode).toBe(200);
    expect(svc.setDefault).toHaveBeenCalled();
  });

  it('refuses a defaultModel patch under the same conditions', async () => {
    shadowStateMock.mockResolvedValue({ status: 'active' });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/admin/llm-providers/${PROVIDER_ID}`,
      payload: { defaultModel: 'other-embedder' },
    });

    expect(res.statusCode).toBe(409);
    expect(svc.update).not.toHaveBeenCalled();
  });

  it('refuses a defaultModel patch when embedding is {provider: this, model: NULL} (review r3)', async () => {
    shadowStateMock.mockResolvedValue({ status: 'active' });
    dbQuery.mockResolvedValue({ rows: [{ provider_id: PROVIDER_ID, model: null }] });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/admin/llm-providers/${PROVIDER_ID}`,
      payload: { defaultModel: 'other-embedder' },
    });

    expect(res.statusCode).toBe(409);
  });

  it('allows a defaultModel patch on an UNRELATED provider when embedding pins another explicitly', async () => {
    shadowStateMock.mockResolvedValue({ status: 'active' });
    dbQuery.mockResolvedValue({ rows: [{ provider_id: 'ffffffff-0000-4000-8000-000000000009', model: null }] });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/admin/llm-providers/${PROVIDER_ID}`,
      payload: { defaultModel: 'chat-model' },
    });

    expect(res.statusCode).toBe(200);
  });

  it('refuses deleting the migration target or rollback provider (review r3)', async () => {
    shadowStateMock.mockResolvedValue({ status: 'swapped', providerId: PROVIDER_ID, prev: { providerId: 'ffffffff-0000-4000-8000-000000000009' } });

    let res = await app.inject({ method: 'DELETE', url: `/api/admin/llm-providers/${PROVIDER_ID}` });
    expect(res.statusCode).toBe(409);
    res = await app.inject({ method: 'DELETE', url: '/api/admin/llm-providers/ffffffff-0000-4000-8000-000000000009' });
    expect(res.statusCode).toBe(409);
    // An uninvolved provider stays deletable.
    res = await app.inject({ method: 'DELETE', url: '/api/admin/llm-providers/eeeeeeee-0000-4000-8000-000000000001' });
    expect(res.statusCode).toBe(200);
  });

  it('allows unrelated provider patches during a migration', async () => {
    shadowStateMock.mockResolvedValue({ status: 'active' });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/admin/llm-providers/${PROVIDER_ID}`,
      payload: { name: 'renamed provider' },
    });

    expect(res.statusCode).toBe(200);
  });
});
