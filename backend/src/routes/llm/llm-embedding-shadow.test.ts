import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { ZodError } from 'zod';

// #1116 route surface for the shadow migration. Minimal Fastify instance
// (full-app tests need Redis, unavailable locally); the service module is
// mocked at its boundary — its own behavior is covered by
// shadow-migration-service.integration.test.ts against real Postgres.

const svc = vi.hoisted(() => ({
  start: vi.fn(),
  status: vi.fn(),
  swap: vi.fn(),
  rollback: vi.fn(),
  cleanup: vi.fn(),
  rerun: vi.fn(),
}));
vi.mock('../../domains/llm/services/shadow-migration-service.js', () => ({
  // The route narrows on this class, so the test must throw the very same
  // constructor the route imports — i.e. this one.
  ShadowProbeError: class ShadowProbeError extends Error {
    constructor(public readonly detail: string) {
      super(`Probe failed before the provider answered: ${detail}`);
      this.name = 'ShadowProbeError';
    }
  },
  startShadowMigration: (...a: unknown[]) => svc.start(...a),
  getShadowMigrationStatus: (...a: unknown[]) => svc.status(...a),
  performShadowSwap: (...a: unknown[]) => svc.swap(...a),
  rollbackShadowMigration: (...a: unknown[]) => svc.rollback(...a),
  cleanupShadowMigration: (...a: unknown[]) => svc.cleanup(...a),
  rerunShadowBackfill: (...a: unknown[]) => svc.rerun(...a),
}));

vi.mock('../../core/services/rate-limit-service.js', () => ({
  getRateLimits: vi.fn(async () => ({ admin: { max: 1000 } })),
}));

// #1260 — the comparison run + judgements. Same boundary discipline: the
// service is mocked here, its behavior lives in
// shadow-compare-service.integration.test.ts against real Postgres.
const compareSvc = vi.hoisted(() => ({
  create: vi.fn(),
  get: vi.fn(),
  run: vi.fn(async () => undefined),
  judge: vi.fn(),
  judgements: vi.fn(),
}));
vi.mock('../../domains/llm/services/shadow-compare-service.js', () => ({
  createShadowCompareRun: (...a: unknown[]) => compareSvc.create(...a),
  getShadowCompareRun: (...a: unknown[]) => compareSvc.get(...a),
  runShadowCompare: (...a: unknown[]) => compareSvc.run(...a),
  recordShadowCompareJudgement: (...a: unknown[]) => compareSvc.judge(...a),
  getShadowCompareJudgements: (...a: unknown[]) => compareSvc.judgements(...a),
}));

const benchmarkGuard = vi.hoisted(() => ({
  active: vi.fn(async (): Promise<{ id: string } | null> => null),
}));
vi.mock('../../domains/llm/eval/production-benchmark.js', () => ({
  getActiveProductionBenchmark: (...a: unknown[]) => benchmarkGuard.active(...(a as [])),
  ProductionBenchmarkAlreadyRunningError: class ProductionBenchmarkAlreadyRunningError extends Error {
    constructor(public readonly activeRunId: string) {
      super('A production retrieval benchmark is already running');
    }
  },
}));

const auditMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../../core/services/audit-service.js', () => ({
  logAuditEvent: (...a: unknown[]) => auditMock(...(a as [])),
}));

const { llmEmbeddingShadowRoutes } = await import('./llm-embedding-shadow.js');
const { LlmHttpError } = await import('../../domains/llm/services/llm-http-error.js');
const { ShadowProbeError } = await import('../../domains/llm/services/shadow-migration-service.js');

let isAdmin = true;

describe('#1116 shadow-migration routes', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(sensible);
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof ZodError) {
        reply.status(400).send({ error: 'ValidationError', statusCode: 400 });
        return;
      }
      const statusCode = error.statusCode ?? 500;
      reply.status(statusCode).send({
        error: statusCode === 500 ? 'InternalServerError' : error.name,
        message: statusCode === 500 ? 'Internal Server Error' : error.message,
        statusCode,
      });
    });
    app.decorate('authenticate', async (request: { userId: string }) => {
      request.userId = 'test-admin';
    });
    app.decorate('requireAdmin', async () => {
      if (!isAdmin) {
        const err = new Error('admin required') as Error & { statusCode: number };
        err.statusCode = 403;
        throw err;
      }
    });
    await app.register(llmEmbeddingShadowRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    isAdmin = true;
  });

  it('start: probes and answers the measured dimension', async () => {
    svc.start.mockResolvedValue({ dimensions: 2560, columnType: 'halfvec(2560)', pageCount: 42, jobId: 'shadow-reembed' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/embedding/shadow-migration',
      payload: { providerId: '2c0c8a92-98a8-4f8c-a6a1-000000000001', model: 'qwen3-embedding:4b' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ dimensions: 2560, pageCount: 42 });
    expect(svc.start).toHaveBeenCalledWith({
      providerId: '2c0c8a92-98a8-4f8c-a6a1-000000000001',
      model: 'qwen3-embedding:4b',
    });
  });

  it('start: 409 when a migration is already active', async () => {
    svc.start.mockRejectedValue(new Error('A shadow migration is already active — swap, roll it back or clean it up first'));
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/embedding/shadow-migration',
      payload: { providerId: '2c0c8a92-98a8-4f8c-a6a1-000000000001', model: 'm' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('start: 404 when the provider does not exist', async () => {
    svc.start.mockRejectedValue(new Error('Provider not found'));
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/embedding/shadow-migration',
      payload: { providerId: '2c0c8a92-98a8-4f8c-a6a1-000000000001', model: 'm' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('start: 422 when the probe yields an unusable dimension', async () => {
    svc.start.mockRejectedValue(new Error('Probe returned an unusable dimension (0)'));
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/embedding/shadow-migration',
      payload: { providerId: '2c0c8a92-98a8-4f8c-a6a1-000000000001', model: 'm' },
    });
    expect(res.statusCode).toBe(422);
  });

  it('start: a probe failure answers 502 with an admin-actionable message, not a masked 500 (review r2)', async () => {
    svc.start.mockRejectedValue(new LlmHttpError('generateEmbedding', 401, 'unauthorized body'));
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/embedding/shadow-migration',
      payload: { providerId: '2c0c8a92-98a8-4f8c-a6a1-000000000001', model: 'typo-model' },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toContain('typo-model');
    // The provider's raw body must stay out of the response (#1185 policy).
    expect(JSON.stringify(res.json())).not.toContain('unauthorized body');
  });

  it('start: a provider that never answers is 502, not a masked 500 (review r5)', async () => {
    // No HTTP response means no LlmHttpError — the wrong port / stopped
    // service / open breaker case, which is the one an admin can actually fix.
    svc.start.mockRejectedValue(new ShadowProbeError('fetch failed'));

    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/embedding/shadow-migration',
      payload: { providerId: '2c0c8a92-98a8-4f8c-a6a1-000000000001', model: 'nomic-embed-text' },
    });

    expect(res.statusCode).toBe(502);
    expect(res.json().error).toContain('fetch failed');
    expect(res.json().error).toContain('nomic-embed-text');
  });

  it('start/swap: an org-policy refusal is a 409 carrying its remedy (review r6)', async () => {
    const msg =
      'An organization LLM policy pins the embedding use case, and it outranks the assignment a swap writes — the corpus would be re-embedded with one model while every query resolves another. Point the policy at the new model (or disable it) before migrating (#1116).';
    svc.start.mockRejectedValue(new Error(msg));
    let res = await app.inject({
      method: 'POST',
      url: '/api/admin/embedding/shadow-migration',
      payload: { providerId: '2c0c8a92-98a8-4f8c-a6a1-000000000001', model: 'm' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe(msg);

    svc.swap.mockRejectedValue(new Error(msg));
    res = await app.inject({ method: 'POST', url: '/api/admin/embedding/shadow-migration/swap' });
    expect(res.statusCode).toBe(409);
  });

  it('status: returns the live status, or active:false when none', async () => {
    svc.status.mockResolvedValue({ phase: 'backfilling', totalPages: 10, backfilledPages: 4, stragglerPages: 6 });
    let res = await app.inject({ method: 'GET', url: '/api/admin/embedding/shadow-migration' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ active: true, migration: { phase: 'backfilling', stragglerPages: 6 } });

    svc.status.mockResolvedValue(null);
    res = await app.inject({ method: 'GET', url: '/api/admin/embedding/shadow-migration' });
    expect(res.json()).toEqual({ active: false, migration: null });
  });

  it('swap: 200 on success, 409 when not ready', async () => {
    svc.swap.mockResolvedValue(undefined);
    let res = await app.inject({ method: 'POST', url: '/api/admin/embedding/shadow-migration/swap' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ swapped: true });

    svc.swap.mockRejectedValue(new Error('Shadow migration not ready to swap: 3 straggler pages'));
    res = await app.inject({ method: 'POST', url: '/api/admin/embedding/shadow-migration/swap' });
    expect(res.statusCode).toBe(409);
  });

  it('swap: 503 when the table lock could not be acquired', async () => {
    svc.swap.mockRejectedValue(new Error('Could not acquire the table lock for the shadow swap after 5 attempts'));
    const res = await app.inject({ method: 'POST', url: '/api/admin/embedding/shadow-migration/swap' });
    expect(res.statusCode).toBe(503);
  });

  it('rollback: reports aborted vs reverted; 409 when nothing to roll back', async () => {
    svc.rollback.mockResolvedValue('reverted');
    let res = await app.inject({ method: 'POST', url: '/api/admin/embedding/shadow-migration/rollback' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ result: 'reverted' });

    svc.rollback.mockRejectedValue(new Error('No shadow migration to roll back'));
    res = await app.inject({ method: 'POST', url: '/api/admin/embedding/shadow-migration/rollback' });
    expect(res.statusCode).toBe(409);
  });

  it('cleanup: 200 on success, 409 before a swap', async () => {
    svc.cleanup.mockResolvedValue(undefined);
    let res = await app.inject({ method: 'POST', url: '/api/admin/embedding/shadow-migration/cleanup' });
    expect(res.statusCode).toBe(200);

    svc.cleanup.mockRejectedValue(new Error('Cleanup only applies after a swap — nothing to clean up'));
    res = await app.inject({ method: 'POST', url: '/api/admin/embedding/shadow-migration/cleanup' });
    expect(res.statusCode).toBe(409);
  });

  it('the race refusals arrive as 409s carrying their guidance, not masked 500s (review r3)', async () => {
    for (const [target, msg] of [
      [svc.swap, 'Migration state changed mid-swap (now aborting) — swap refused'],
      [svc.rollback, 'The swap completed while the abort was queued — use rollback to revert it, or cleanup to keep it'],
      [svc.cleanup, 'Migration state changed mid-cleanup (now active) — cleanup refused'],
    ] as const) {
      target.mockRejectedValue(new Error(msg));
      const url = target === svc.swap
        ? '/api/admin/embedding/shadow-migration/swap'
        : target === svc.rollback
          ? '/api/admin/embedding/shadow-migration/rollback'
          : '/api/admin/embedding/shadow-migration/cleanup';
      const res = await app.inject({ method: 'POST', url });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe(msg);
    }
  });

  it('backfill re-run: 200 when active, 409 when nothing to backfill (review r1)', async () => {
    svc.rerun.mockResolvedValue({ jobId: 'shadow-reembed' });
    let res = await app.inject({ method: 'POST', url: '/api/admin/embedding/shadow-migration/backfill' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ jobId: 'shadow-reembed' });

    svc.rerun.mockRejectedValue(new Error('No active shadow migration — nothing to backfill'));
    res = await app.inject({ method: 'POST', url: '/api/admin/embedding/shadow-migration/backfill' });
    expect(res.statusCode).toBe(409);
  });

  // ── #1260 — the comparison run ─────────────────────────────────────────

  const READY_STATUS = {
    status: 'active',
    phase: 'ready',
    model: 'qwen3-embedding:4b',
    stragglerPages: 0,
    indexReady: true,
  };

  it('compare: 202 with a runId, recorded in the audit log, worker fired', async () => {
    svc.status.mockResolvedValue(READY_STATUS);
    benchmarkGuard.active.mockResolvedValue(null);
    compareSvc.create.mockResolvedValue('run-1');

    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/embedding/shadow-migration/compare',
      payload: { days: 14, limit: 20, topK: 5 },
    });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ runId: 'run-1', status: 'queued' });
    expect(compareSvc.create).toHaveBeenCalledWith('test-admin', {
      kind: 'shadow-compare',
      days: 14,
      limit: 20,
      topK: 5,
    });
    expect(compareSvc.run).toHaveBeenCalledWith('run-1', 'test-admin');
    expect(auditMock).toHaveBeenCalledWith(
      'test-admin',
      'EMBEDDING_SHADOW_COMPARE_STARTED',
      'llm',
      undefined,
      expect.objectContaining({ runId: 'run-1', days: 14, limit: 20, topK: 5 }),
      expect.anything(),
    );
  });

  it('compare: an empty body takes the schema defaults', async () => {
    svc.status.mockResolvedValue(READY_STATUS);
    benchmarkGuard.active.mockResolvedValue(null);
    compareSvc.create.mockResolvedValue('run-2');
    const res = await app.inject({ method: 'POST', url: '/api/admin/embedding/shadow-migration/compare', payload: {} });
    expect(res.statusCode).toBe(202);
    expect(compareSvc.create).toHaveBeenCalledWith('test-admin', {
      kind: 'shadow-compare',
      days: 30,
      limit: 50,
      topK: 10,
    });
  });

  it('compare: 409 with no active shadow migration — there is nothing to compare against', async () => {
    svc.status.mockResolvedValue(null);
    const res = await app.inject({ method: 'POST', url: '/api/admin/embedding/shadow-migration/compare', payload: {} });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/no active shadow migration/i);
    expect(compareSvc.create).not.toHaveBeenCalled();
  });

  it('compare: 409 while backfilling, naming the straggler count — a partial column measures the backfill, not the model', async () => {
    svc.status.mockResolvedValue({ ...READY_STATUS, phase: 'backfilling', stragglerPages: 7 });
    const res = await app.inject({ method: 'POST', url: '/api/admin/embedding/shadow-migration/compare', payload: {} });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/7 straggler/i);
    expect(compareSvc.create).not.toHaveBeenCalled();
  });

  it('compare: 409 after the swap — the window is over', async () => {
    svc.status.mockResolvedValue({ ...READY_STATUS, status: 'swapped', phase: 'swapped' });
    const res = await app.inject({ method: 'POST', url: '/api/admin/embedding/shadow-migration/compare', payload: {} });
    expect(res.statusCode).toBe(409);
    expect(compareSvc.create).not.toHaveBeenCalled();
  });

  it('compare: 409 while a production benchmark (or another compare) holds the one-active slot', async () => {
    svc.status.mockResolvedValue(READY_STATUS);
    benchmarkGuard.active.mockResolvedValue({ id: 'bench-1' });
    const res = await app.inject({ method: 'POST', url: '/api/admin/embedding/shadow-migration/compare', payload: {} });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'benchmark_in_progress', runId: 'bench-1' });
    expect(compareSvc.create).not.toHaveBeenCalled();
  });

  it('compare: a create losing the unique-index race is the same 409, not a masked 500', async () => {
    svc.status.mockResolvedValue(READY_STATUS);
    benchmarkGuard.active.mockResolvedValue(null);
    const { ProductionBenchmarkAlreadyRunningError } = await import('../../domains/llm/eval/production-benchmark.js');
    compareSvc.create.mockRejectedValue(new ProductionBenchmarkAlreadyRunningError('bench-2'));
    const res = await app.inject({ method: 'POST', url: '/api/admin/embedding/shadow-migration/compare', payload: {} });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'benchmark_in_progress', runId: 'bench-2' });
  });

  it('compare poll: returns the run, 404 for an unknown or foreign-kind id', async () => {
    compareSvc.get.mockResolvedValue({ id: 'run-1', status: 'running', progressDone: 2, progressTotal: 5, result: null, error: null });
    let res = await app.inject({ method: 'GET', url: '/api/admin/embedding/shadow-migration/compare/2c0c8a92-98a8-4f8c-a6a1-000000000009' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'running', progressDone: 2 });

    compareSvc.get.mockResolvedValue(null);
    res = await app.inject({ method: 'GET', url: '/api/admin/embedding/shadow-migration/compare/2c0c8a92-98a8-4f8c-a6a1-000000000009' });
    expect(res.statusCode).toBe(404);
  });

  it('every route is admin-gated', async () => {
    isAdmin = false;
    for (const [method, url] of [
      ['POST', '/api/admin/embedding/shadow-migration'],
      ['GET', '/api/admin/embedding/shadow-migration'],
      ['POST', '/api/admin/embedding/shadow-migration/swap'],
      ['POST', '/api/admin/embedding/shadow-migration/rollback'],
      ['POST', '/api/admin/embedding/shadow-migration/cleanup'],
      ['POST', '/api/admin/embedding/shadow-migration/backfill'],
      ['POST', '/api/admin/embedding/shadow-migration/compare'],
      ['GET', '/api/admin/embedding/shadow-migration/compare/2c0c8a92-98a8-4f8c-a6a1-000000000009'],
    ] as const) {
      const res = await app.inject({
        method,
        url,
        ...(method === 'POST' && url.endsWith('shadow-migration')
          ? { payload: { providerId: '2c0c8a92-98a8-4f8c-a6a1-000000000001', model: 'm' } }
          : {}),
      });
      expect(res.statusCode).toBe(403);
    }
    expect(svc.start).not.toHaveBeenCalled();
    expect(svc.swap).not.toHaveBeenCalled();
    expect(compareSvc.create).not.toHaveBeenCalled();
    expect(compareSvc.get).not.toHaveBeenCalled();
  });
});
