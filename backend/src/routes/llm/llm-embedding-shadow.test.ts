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

const { llmEmbeddingShadowRoutes } = await import('./llm-embedding-shadow.js');
const { LlmHttpError } = await import('../../domains/llm/services/llm-http-error.js');

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

  it('every route is admin-gated', async () => {
    isAdmin = false;
    for (const [method, url] of [
      ['POST', '/api/admin/embedding/shadow-migration'],
      ['GET', '/api/admin/embedding/shadow-migration'],
      ['POST', '/api/admin/embedding/shadow-migration/swap'],
      ['POST', '/api/admin/embedding/shadow-migration/rollback'],
      ['POST', '/api/admin/embedding/shadow-migration/cleanup'],
      ['POST', '/api/admin/embedding/shadow-migration/backfill'],
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
  });
});
