import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';

const { mockQuery, mockRun, mockCreate, mockActive, mockGet } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockRun: vi.fn().mockResolvedValue(undefined),
  mockCreate: vi.fn().mockResolvedValue('11111111-1111-4111-8111-111111111111'),
  mockActive: vi.fn().mockResolvedValue(null),
  mockGet: vi.fn(),
}));

vi.mock('../../core/db/postgres.js', () => ({ query: mockQuery }));
vi.mock('../../core/services/mcp-docs-settings.js', () => ({
  getMcpDocsSettings: vi.fn(),
  upsertMcpDocsSettings: vi.fn(),
}));
vi.mock('../../core/services/mcp-docs-client.js', () => ({
  testConnection: vi.fn(),
  fetchDocumentation: vi.fn(),
  searchDocumentation: vi.fn(),
}));
vi.mock('../../core/services/audit-service.js', () => ({ logAuditEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../core/services/rate-limit-service.js', () => ({ getRateLimits: vi.fn().mockResolvedValue({ admin: { max: 20 } }) }));
vi.mock('../../core/utils/logger.js', () => ({ logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('../../domains/llm/services/llm-cache.js', () => ({
  LlmCache: class { clearAll = vi.fn().mockResolvedValue(0); },
}));
vi.mock('../../domains/llm/eval/production-benchmark.js', () => ({
  createProductionBenchmarkRun: mockCreate,
  getActiveProductionBenchmark: mockActive,
  getProductionBenchmarkRun: mockGet,
  runProductionBenchmark: mockRun,
  ProductionBenchmarkAlreadyRunningError: class extends Error {},
}));

import { llmAdminRoutes } from './llm-admin.js';

describe('production retrieval benchmark admin routes', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(sensible);
    app.decorate('authenticate', async (request: { userId: string; userRole: string }) => {
      request.userId = 'admin-user';
      request.userRole = 'admin';
    });
    app.decorate('requireAdmin', async (request: { userId: string; userRole: string }) => {
      request.userId = 'admin-user';
      request.userRole = 'admin';
    });
    app.decorate('redis', {});
    app.decorateRequest('userId', '');
    await app.register(llmAdminRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => app.close());

  beforeEach(() => {
    vi.clearAllMocks();
    mockActive.mockResolvedValue(null);
    mockCreate.mockResolvedValue('11111111-1111-4111-8111-111111111111');
    mockRun.mockResolvedValue(undefined);
  });

  it('queues a bounded recent-query benchmark and returns its id', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/retrieval-benchmark',
      payload: { source: 'recent-queries', days: 7, limit: 10, topK: 5 },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      runId: '11111111-1111-4111-8111-111111111111',
      status: 'queued',
    });
    expect(mockCreate).toHaveBeenCalledWith('admin-user', {
      source: 'recent-queries', days: 7, limit: 10, topK: 5,
    });
    expect(mockRun).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111', 'admin-user');
  });

  it('does not start a second run while one is active', async () => {
    mockActive.mockResolvedValue({ id: '22222222-2222-4222-8222-222222222222' });

    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/retrieval-benchmark',
      payload: {},
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'benchmark_in_progress', runId: '22222222-2222-4222-8222-222222222222' });
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('returns a persisted run for polling', async () => {
    mockGet.mockResolvedValue({ id: '11111111-1111-4111-8111-111111111111', status: 'completed', result: null });

    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/retrieval-benchmark/11111111-1111-4111-8111-111111111111',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('completed');
  });
});
