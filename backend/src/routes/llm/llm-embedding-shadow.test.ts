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
  latest: vi.fn(async () => null),
  run: vi.fn(async () => undefined),
  judge: vi.fn(),
  judgements: vi.fn(),
}));
// The three refusal classes stand in for the service's own: the route maps
// them by TYPE (a regex over English prose turns a copy edit into a 500), and
// the module boundary is where this test mocks. TypeScript ties the names to
// the real ones; the service throwing them is pinned by the integration test.
vi.mock('../../domains/llm/services/shadow-compare-service.js', () => ({
  CompareRunNotFoundError: class CompareRunNotFoundError extends Error {
    constructor() {
      super('Comparison run not found');
    }
  },
  CompareRunIncompleteError: class CompareRunIncompleteError extends Error {
    constructor() {
      super('Comparison run has not completed — judgements attach to a finished run');
    }
  },
  UnknownCompareQueryError: class UnknownCompareQueryError extends Error {
    constructor() {
      super('Unknown query id for this comparison run');
    }
  },
  createShadowCompareRun: (...a: unknown[]) => compareSvc.create(...a),
  getShadowCompareRun: (...a: unknown[]) => compareSvc.get(...a),
  getLatestShadowCompareRun: (...a: unknown[]) => compareSvc.latest(...(a as [])),
  runShadowCompare: (...a: unknown[]) => compareSvc.run(...a),
  recordShadowCompareJudgement: (...a: unknown[]) => compareSvc.judge(...a),
  getShadowCompareJudgements: (...a: unknown[]) => compareSvc.judgements(...a),
}));

const benchmarkGuard = vi.hoisted(() => ({
  active: vi.fn(async (): Promise<{ id: string; kind: string | null } | null> => null),
}));
vi.mock('../../domains/llm/eval/benchmark-run-lifecycle.js', async () => {
  // Only `activeBenchmarkRun` is stubbed — the slot query is the one thing
  // here that touches the database. Everything else is the REAL module (r3):
  // the hand-written stand-ins were a class the route's `instanceof` could
  // not have distinguished from the real one, and a `slotBusyMessage` that
  // simply did not exist, so the sentence the route sends was never once
  // exercised in the suite that pins its wording.
  const actual = await vi.importActual<
    typeof import('../../domains/llm/eval/benchmark-run-lifecycle.js')
  >('../../domains/llm/eval/benchmark-run-lifecycle.js');
  return {
    ...actual,
    activeBenchmarkRun: (...a: unknown[]) => benchmarkGuard.active(...(a as [])),
  };
});

const auditMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../../core/services/audit-service.js', () => ({
  logAuditEvent: (...a: unknown[]) => auditMock(...(a as [])),
}));

const { llmEmbeddingShadowRoutes } = await import('./llm-embedding-shadow.js');
const { LlmHttpError } = await import('../../domains/llm/services/llm-http-error.js');
const { ShadowProbeError } = await import('../../domains/llm/services/shadow-migration-service.js');

let isAdmin = true;

/**
 * Every route the plugin declares, collected from Fastify itself (r2). The
 * admin-gate test used to enumerate them by hand and had already missed one —
 * `GET …/compare`, the latest-run lookup, which serves real production query
 * text and page titles: deleting its `preHandler` left the whole suite green.
 * A hand-written list cannot fail for the route it does not mention, so the
 * list is derived and a new route is gated by default or the test names it.
 */
const declaredRoutes: Array<{ method: string; url: string }> = [];

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
    app.addHook('onRoute', (route) => {
      const methods = Array.isArray(route.method) ? route.method : [route.method];
      for (const method of methods) {
        // HEAD is Fastify's own free companion to every GET, and it shares
        // that GET's preHandler chain; listing it doubles the loop for no
        // extra coverage.
        if (method === 'HEAD') continue;
        declaredRoutes.push({ method, url: route.url });
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
    benchmarkGuard.active.mockResolvedValue({ id: 'bench-1', kind: null });
    const res = await app.inject({ method: 'POST', url: '/api/admin/embedding/shadow-migration/compare', payload: {} });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'benchmark_in_progress' });
    expect(res.json().message).toMatch(/production retrieval benchmark is already running/i);
    // No runId: it names a PRODUCTION BENCHMARK run, and this card would poll
    // it on the compare surface, where the kind guard 404s every request
    // while the card believed it had re-attached.
    expect(res.json().runId).toBeUndefined();
    expect(compareSvc.create).not.toHaveBeenCalled();
  });

  it('compare: the 409 names a comparison when the slot holder IS one, never a benchmark that does not exist (r3)', async () => {
    // Reachable without any race: the card's runId is plain useState, so an
    // admin who switches tabs mid-run and comes back gets this 409 — and its
    // message is toasted verbatim. Naming a "production retrieval benchmark"
    // there points at a run that does not exist.
    svc.status.mockResolvedValue(READY_STATUS);
    benchmarkGuard.active.mockResolvedValue({ id: 'cmp-1', kind: 'shadow-compare' });
    const res = await app.inject({ method: 'POST', url: '/api/admin/embedding/shadow-migration/compare', payload: {} });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'benchmark_in_progress', runId: 'cmp-1' });
    expect(res.json().message).toMatch(/comparison is already running/i);
    expect(res.json().message).not.toMatch(/benchmark/i);
    expect(compareSvc.create).not.toHaveBeenCalled();
  });

  it('compare: a create losing the unique-index race is the same 409, not a masked 500', async () => {
    svc.status.mockResolvedValue(READY_STATUS);
    benchmarkGuard.active.mockResolvedValue(null);
    const { BenchmarkRunSlotBusyError } = await import('../../domains/llm/eval/benchmark-run-lifecycle.js');
    compareSvc.create.mockRejectedValue(new BenchmarkRunSlotBusyError('bench-2'));
    const res = await app.inject({ method: 'POST', url: '/api/admin/embedding/shadow-migration/compare', payload: {} });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'benchmark_in_progress' });
    expect(res.json().runId).toBeUndefined();
  });

  it('compare: the race 409 is worded by the winning run\'s kind too (r3)', async () => {
    svc.status.mockResolvedValue(READY_STATUS);
    benchmarkGuard.active.mockResolvedValue(null);
    const { BenchmarkRunSlotBusyError } = await import('../../domains/llm/eval/benchmark-run-lifecycle.js');
    compareSvc.create.mockRejectedValue(new BenchmarkRunSlotBusyError('cmp-2', 'shadow-compare'));
    const res = await app.inject({ method: 'POST', url: '/api/admin/embedding/shadow-migration/compare', payload: {} });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'benchmark_in_progress', runId: 'cmp-2' });
    expect(res.json().message).toMatch(/comparison is already running/i);
    expect(res.json().message).not.toMatch(/benchmark/i);
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

  it('judgements: POST records a side for a run query and answers the recomputed verdict', async () => {
    const view = {
      judgements: { 'query-1': 'candidate' },
      verdict: { judgementCount: 1, liveBetter: 0, candidateBetter: 1, both: 0, neither: 0, mcnemar: null, recall: null, mrr: null, minJudgementsForP: 20 },
    };
    compareSvc.judge.mockResolvedValue(view);
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/embedding/shadow-migration/compare/2c0c8a92-98a8-4f8c-a6a1-000000000009/judgements',
      payload: { queryId: 'query-1', side: 'candidate' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(view);
    expect(compareSvc.judge).toHaveBeenCalledWith(
      '2c0c8a92-98a8-4f8c-a6a1-000000000009',
      'query-1',
      'candidate',
      'test-admin',
    );
  });

  it('judgements: GET answers the stored sides and the verdict', async () => {
    const view = { judgements: {}, verdict: { judgementCount: 0, liveBetter: 0, candidateBetter: 0, both: 0, neither: 0, mcnemar: null, recall: null, mrr: null, minJudgementsForP: 20 } };
    compareSvc.judgements.mockResolvedValue(view);
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/embedding/shadow-migration/compare/2c0c8a92-98a8-4f8c-a6a1-000000000009/judgements',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(view);
  });

  it('judgements: the service refusals map onto 404/409/422 BY TYPE, never masked 500s', async () => {
    const {
      CompareRunNotFoundError,
      CompareRunIncompleteError,
      UnknownCompareQueryError,
    } = await import('../../domains/llm/services/shadow-compare-service.js');
    for (const [Refusal, code] of [
      [CompareRunNotFoundError, 404],
      [CompareRunIncompleteError, 409],
      [UnknownCompareQueryError, 422],
    ] as const) {
      const err = new Refusal();
      compareSvc.judge.mockRejectedValue(err);
      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/embedding/shadow-migration/compare/2c0c8a92-98a8-4f8c-a6a1-000000000009/judgements',
        payload: { queryId: 'query-1', side: 'live' },
      });
      expect(res.statusCode, err.message).toBe(code);
      expect(res.json().error, err.message).toBe(err.message);
    }

    // The mapping is by type, so re-wording a refusal cannot silently drop it
    // to a 500 — the failure a regex over English prose has.
    class Reworded extends CompareRunIncompleteError {
      constructor() {
        super();
        this.message = 'That comparison is still running — judgements attach once it finishes.';
      }
    }
    compareSvc.judge.mockRejectedValue(new Reworded());
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/embedding/shadow-migration/compare/2c0c8a92-98a8-4f8c-a6a1-000000000009/judgements',
      payload: { queryId: 'query-1', side: 'live' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/still running/i);
  });

  it('compare: the latest-run lookup answers this admin\'s most recent comparison', async () => {
    // The card re-attaches through this after an unmount; without it a run
    // that outlives a tab switch is unreachable while still holding the slot.
    compareSvc.latest.mockResolvedValue({
      id: 'run-9',
      status: 'completed',
      progressDone: 3,
      progressTotal: 3,
      result: null,
      error: null,
    } as never);
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/embedding/shadow-migration/compare',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().run).toMatchObject({ id: 'run-9', status: 'completed' });
    expect(compareSvc.latest).toHaveBeenCalledWith('test-admin');
  });

  it('compare poll and judgements are scoped to the requesting admin', async () => {
    // The persisted report carries page titles retrieved under the starting
    // admin's ACL, private standalone pages included.
    compareSvc.get.mockResolvedValue(null);
    compareSvc.judgements.mockResolvedValue({ judgements: {}, verdict: null });
    await app.inject({ method: 'GET', url: '/api/admin/embedding/shadow-migration/compare/2c0c8a92-98a8-4f8c-a6a1-000000000009' });
    expect(compareSvc.get).toHaveBeenCalledWith('2c0c8a92-98a8-4f8c-a6a1-000000000009', 'test-admin');
    await app.inject({ method: 'GET', url: '/api/admin/embedding/shadow-migration/compare/2c0c8a92-98a8-4f8c-a6a1-000000000009/judgements' });
    expect(compareSvc.judgements).toHaveBeenCalledWith('2c0c8a92-98a8-4f8c-a6a1-000000000009', 'test-admin');
  });

  it('judgements: an unknown side is a 400, before the service is reached', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/embedding/shadow-migration/compare/2c0c8a92-98a8-4f8c-a6a1-000000000009/judgements',
      payload: { queryId: 'query-1', side: 'draw' },
    });
    expect(res.statusCode).toBe(400);
    expect(compareSvc.judge).not.toHaveBeenCalled();
  });

  it('every route is admin-gated', async () => {
    isAdmin = false;
    const urls = declaredRoutes.map((route) => route.url);
    // The derivation itself has to be load-bearing: an `onRoute` hook that
    // silently collected nothing would make the loop below pass vacuously.
    expect(urls).toContain('/api/admin/embedding/shadow-migration');
    expect(urls).toContain('/api/admin/embedding/shadow-migration/compare');
    expect(urls).toContain('/api/admin/embedding/shadow-migration/compare/:id');
    expect(declaredRoutes.length).toBeGreaterThanOrEqual(11);

    for (const { method, url } of declaredRoutes) {
      const res = await app.inject({
        method: method as 'GET',
        url: url.replace(':id', '2c0c8a92-98a8-4f8c-a6a1-000000000009'),
        ...(method === 'POST'
          ? { payload: { providerId: '2c0c8a92-98a8-4f8c-a6a1-000000000001', model: 'm' } }
          : {}),
      });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
    expect(svc.start).not.toHaveBeenCalled();
    expect(svc.swap).not.toHaveBeenCalled();
    expect(compareSvc.create).not.toHaveBeenCalled();
    expect(compareSvc.get).not.toHaveBeenCalled();
    expect(compareSvc.latest).not.toHaveBeenCalled();
    expect(compareSvc.judge).not.toHaveBeenCalled();
    expect(compareSvc.judgements).not.toHaveBeenCalled();
  });
});
