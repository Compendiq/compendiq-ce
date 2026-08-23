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
vi.mock('../../domains/llm/eval/production-benchmark.js', async () => {
  // The REAL class, not a local stand-in (r3). The route maps this 409 by
  // `instanceof`, so a factory-defined `class extends Error {}` tested the
  // test's own type: the production module re-exports
  // `BenchmarkRunSlotBusyError`, and a throw of the real one would have been
  // rethrown as a 500 while the suite stayed green. It also carries the `kind`
  // the wording now reads.
  const lifecycle = await vi.importActual<
    typeof import('../../domains/llm/eval/benchmark-run-lifecycle.js')
  >('../../domains/llm/eval/benchmark-run-lifecycle.js');
  return {
    createProductionBenchmarkRun: mockCreate,
    getActiveProductionBenchmark: mockActive,
    getProductionBenchmarkRun: mockGet,
    runProductionBenchmark: mockRun,
    ProductionBenchmarkAlreadyRunningError: lifecycle.BenchmarkRunSlotBusyError,
  };
});

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
    // `kind: null` is the production benchmark — its own id, so the card may
    // adopt it. (The real `getActiveProductionBenchmark` always reports the
    // holder's kind; the fixture says so too.)
    mockActive.mockResolvedValue({ id: '22222222-2222-4222-8222-222222222222', kind: null });

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

  it('withholds the run id when a #1260 shadow COMPARISON holds the shared slot', async () => {
    // The slot is shared by design, but `GET /admin/retrieval-benchmark/:id`
    // is kind-guarded and 404s a comparison's id, so handing it back would
    // let this card adopt an id its own poll refuses. The message is
    // deliberately unchanged (the #1260 owner decision keeps the benchmark's
    // wording in both directions); only the id is withheld.
    mockActive.mockResolvedValue({
      id: '33333333-3333-4333-8333-333333333333',
      kind: 'shadow-compare',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/retrieval-benchmark',
      payload: {},
    });

    expect(response.statusCode).toBe(409);
    const body = response.json();
    expect(body.error).toBe('benchmark_in_progress');
    // Worded by the HOLDER, not by the route that was asked (r3). The fixed
    // sentence told the operator a production benchmark was running when the
    // slot was held by a #1260 comparison — a run that does not exist, on the
    // one surface consulted to find out what is holding the slot, and toasted
    // verbatim by the Retrieval tab.
    expect(body.message).toMatch(/comparison is already running/i);
    expect(body.message).not.toMatch(/production retrieval benchmark/i);
    expect(body).not.toHaveProperty('runId');
  });

  it('a benchmark holding the slot keeps the benchmark sentence', async () => {
    // The other half of the same rule: the holder's kind decides, so the
    // ordinary case must be untouched by the fix above.
    mockActive.mockResolvedValue({ id: '44444444-4444-4444-8444-444444444444', kind: null });
    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/retrieval-benchmark',
      payload: {},
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().message).toMatch(/production retrieval benchmark is already running/i);
  });

  it('a create losing the unique-index race to a COMPARISON is worded by the winner too', async () => {
    // `ProductionBenchmarkAlreadyRunningError.message` is the class's fixed
    // benchmark sentence, so echoing `err.message` re-introduced the same lie
    // one layer down, on the path that only fires under a real race.
    mockActive.mockResolvedValue(null);
    const { BenchmarkRunSlotBusyError } = await import(
      '../../domains/llm/eval/benchmark-run-lifecycle.js'
    );
    mockCreate.mockRejectedValue(
      new BenchmarkRunSlotBusyError('55555555-5555-4555-8555-555555555555', 'shadow-compare'),
    );
    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/retrieval-benchmark',
      payload: {},
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().message).toMatch(/comparison is already running/i);
    expect(response.json().message).not.toMatch(/production retrieval benchmark/i);
    expect(response.json()).not.toHaveProperty('runId');
  });

  it('returns a persisted run for polling, scoped to the admin who started it (r2)', async () => {
    // `fetchBenchmarkRun`'s own doc states why `requestedBy` exists: the report
    // carries page TITLES retrieved under the starting admin's ACL
    // (`visiblePagesPredicate` admits their private standalone pages), so an
    // unscoped read hands admin B titles admin A can see and B cannot. This was
    // the ONE caller of the shared lifecycle module that omitted it — the
    // compare side has passed it since #1260 — so the module's argument was
    // silently contradicted by the caller beside it.
    mockGet.mockResolvedValue({ id: '11111111-1111-4111-8111-111111111111', status: 'completed', result: null });

    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/retrieval-benchmark/11111111-1111-4111-8111-111111111111',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('completed');
    expect(mockGet).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111', 'admin-user');
  });
});
