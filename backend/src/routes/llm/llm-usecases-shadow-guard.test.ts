import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { ZodError } from 'zod';

// #1116 review r1: while a shadow migration is in flight, the embedding
// use-case assignment is load-bearing state — the dual-write and the swap's
// prev-capture both read it. PUT /admin/llm-usecases must refuse to repoint
// it until the migration swaps, rolls back or cleans up.

const clientQuery = vi.hoisted(() => vi.fn(async () => ({ rows: [] })));
vi.mock('../../core/db/postgres.js', () => ({
  query: vi.fn(async () => ({ rows: [] })),
  getPool: () => ({
    connect: async () => ({ query: clientQuery, release: vi.fn() }),
  }),
}));
vi.mock('../../domains/llm/services/llm-provider-resolver.js', () => ({
  resolveUsecase: vi.fn(async () => {
    throw new Error('not configured');
  }),
  resolveRerankUsecase: vi.fn(async () => null),
  // #1114 — the route reads the pair behind each confidence basis before and
  // after the save. Nothing is configured in this file, so it RESOLVES to no
  // pair (review r2: that is a different answer from "the resolver failed"),
  // which is also what makes the calibration warning stay silent here — the
  // pair did not move.
  resolveConfidenceBasisPair: vi.fn(async () => ({ resolved: true, pair: null })),
}));
vi.mock('../../domains/llm/services/cache-bus.js', () => ({
  bumpProviderCacheVersion: vi.fn(async () => {}),
}));
vi.mock('../../domains/llm/services/llm-audit-hook.js', () => ({
  emitLlmAudit: vi.fn(),
}));
vi.mock('../../core/services/rate-limit-service.js', () => ({
  getRateLimits: vi.fn(async () => ({ admin: { max: 1000 } })),
}));
vi.mock('../../domains/llm/services/model-capabilities.js', () => ({
  getVisionCapability: vi.fn(async () => null),
  refreshVisionCapability: vi.fn(async () => {}),
  readVisionCapabilityDetail: vi.fn(async () => null),
}));
const shadowStateMock = vi.hoisted(() => vi.fn(async (): Promise<object | null> => null));
vi.mock('../../domains/llm/services/shadow-migration-service.js', () => ({
  getShadowMigrationState: () => shadowStateMock(),
}));

const { llmUsecaseRoutes } = await import('./llm-usecases.js');

describe('PUT /admin/llm-usecases shadow-migration guard (#1116)', () => {
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
    await app.register(llmUsecaseRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    shadowStateMock.mockResolvedValue(null);
  });

  it('refuses to repoint the embedding assignment while a migration is active', async () => {
    shadowStateMock.mockResolvedValue({ status: 'active' });

    const res = await app.inject({
      method: 'PUT',
      url: '/api/admin/llm-usecases',
      payload: { embedding: { providerId: '2c0c8a92-98a8-4f8c-a6a1-000000000001', model: 'other-model' } },
    });

    expect(res.statusCode).toBe(409);
    expect(clientQuery).not.toHaveBeenCalled(); // nothing was written
  });

  it('still accepts saves that do not touch the embedding assignment', async () => {
    shadowStateMock.mockResolvedValue({ status: 'active' });

    const res = await app.inject({
      method: 'PUT',
      url: '/api/admin/llm-usecases',
      payload: { summary: { providerId: '2c0c8a92-98a8-4f8c-a6a1-000000000001', model: 'm' } },
    });

    expect(res.statusCode).toBe(200);
  });

  it('accepts embedding changes when no migration exists', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/admin/llm-usecases',
      payload: { embedding: { providerId: '2c0c8a92-98a8-4f8c-a6a1-000000000001', model: 'm' } },
    });

    expect(res.statusCode).toBe(200);
  });
});
