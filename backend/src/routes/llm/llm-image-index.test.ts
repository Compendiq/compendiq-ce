import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { ZodError } from 'zod';
import { ImageIndexStatusSchema } from '@compendiq/contracts';

/**
 * #1115 P2 — the image-index admin surface.
 *
 * Minimal Fastify instance and boundary mocks, like `llm-embedding-shadow`'s
 * route test: the service's own behaviour is covered against real Postgres in
 * `image-embedding-service.integration.test.ts` and its worker test, and what
 * is under test HERE is the wiring — the admin gate, the answered shape, and
 * the two actions really reaching the service.
 */

const svc = vi.hoisted(() => ({
  process: vi.fn(),
  markAll: vi.fn(),
  lastRun: vi.fn(),
}));
vi.mock('../../domains/llm/services/image-embedding-service.js', () => ({
  processDirtyPageImages: (...a: unknown[]) => svc.process(...a),
  markAllPagesImageDirty: (...a: unknown[]) => svc.markAll(...a),
  readImageIndexLastRun: (...a: unknown[]) => svc.lastRun(...a),
  IMAGE_INDEX_WORKER_LOCK: 'image-embedding-index',
}));

const resolver = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock('../../domains/llm/services/llm-provider-resolver.js', () => ({
  resolveImageEmbeddingUsecase: (...a: unknown[]) => resolver.resolve(...a),
}));

const index = vi.hoisted(() => ({ dims: vi.fn(), identity: vi.fn() }));
vi.mock('../../domains/llm/services/image-embedding-index.js', async (importOriginal) => ({
  // `imageIndexIdentityFor` stays REAL. Re-spelling `provider:model@url#dims`
  // here is how the route and the rebuild drift into disagreeing about what
  // counts as the same vector space — which is the exact disagreement the
  // flag under test reports.
  ...(await importOriginal<Record<string, unknown>>()),
  readImageIndexDimensions: (...a: unknown[]) => index.dims(...a),
  readImageIndexIdentity: (...a: unknown[]) => index.identity(...a),
}));

const target = vi.hoisted(() => ({ dims: vi.fn() }));
vi.mock('../../core/services/image-embedding-target-dimensions.js', () => ({
  getImageEmbeddingTargetDimensions: (...a: unknown[]) => target.dims(...a),
}));

const db = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../../core/db/postgres.js', () => ({
  query: (...a: unknown[]) => db.query(...a),
}));

const redis = vi.hoisted(() => ({ locked: vi.fn() }));
vi.mock('../../core/services/redis-cache.js', () => ({
  isWorkerLocked: (...a: unknown[]) => redis.locked(...a),
}));

vi.mock('../../core/services/rate-limit-service.js', () => ({
  getRateLimits: vi.fn(async () => ({ admin: { max: 1000 } })),
}));

const { llmImageIndexRoutes } = await import('./llm-image-index.js');

let isAdmin = true;

/** Counts answered by the two aggregate SELECTs, in call order. */
function stubCounts(rows: number, dirty: number, total: number): void {
  db.query.mockImplementation(async (sql: string) => {
    if (String(sql).includes('page_image_embeddings')) {
      return { rows: [{ count: String(rows) }] };
    }
    return { rows: [{ dirty: String(dirty), total: String(total) }] };
  });
}

describe('#1115 P2 image-index routes', () => {
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
      reply.status(statusCode).send({ error: error.name, message: error.message, statusCode });
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
    await app.register(llmImageIndexRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    isAdmin = true;
    resolver.resolve.mockResolvedValue({
      config: { providerId: '00000000-0000-4000-8000-000000000001', baseUrl: 'http://vl/v1' },
      model: 'Qwen/Qwen3-VL-Embedding-2B',
    });
    index.dims.mockResolvedValue(2048);
    index.identity.mockResolvedValue(
      '00000000-0000-4000-8000-000000000001:Qwen/Qwen3-VL-Embedding-2B@http://vl/v1#native',
    );
    target.dims.mockResolvedValue(null);
    svc.lastRun.mockResolvedValue(null);
    redis.locked.mockResolvedValue(false);
    stubCounts(12, 3, 100);
  });

  it('GET answers a payload the contract accepts', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/embedding/image-index' });

    expect(res.statusCode).toBe(200);
    const parsed = ImageIndexStatusSchema.parse(res.json());
    expect(parsed).toMatchObject({
      assigned: true,
      rows: 12,
      pagesDirty: 3,
      pagesTotal: 100,
      running: false,
      lastRun: null,
    });
    expect(parsed.identity).toEqual({
      providerId: '00000000-0000-4000-8000-000000000001',
      model: 'Qwen/Qwen3-VL-Embedding-2B',
      dimensions: 2048,
      tier: 'halfvec',
    });
  });

  /**
   * Review r1 — `identity` mixes two documents on one line: the LIVE
   * assignment's provider and model, and the RECORDED index's width and tier.
   * They can disagree, because the column DDL behind an assignment is guarded
   * (a failed `ALTER` answers 200 with a warning naming Re-check), and the
   * card would otherwise present a model+width pair no index has ever had.
   */
  describe('identityMatchesAssignment', () => {
    it('is true when the recorded identity is the one the live pair produces', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/admin/embedding/image-index' });
      expect(ImageIndexStatusSchema.parse(res.json()).identityMatchesAssignment).toBe(true);
    });

    it('is false when the model moved but the rebuild did not land', async () => {
      index.identity.mockResolvedValue(
        '00000000-0000-4000-8000-000000000001:Qwen/Qwen3-VL-Embedding-8B@http://vl/v1#native',
      );
      const res = await app.inject({ method: 'GET', url: '/api/admin/embedding/image-index' });
      expect(res.json().identityMatchesAssignment).toBe(false);
    });

    it('is false when only the ENDPOINT moved', async () => {
      // `PATCH /admin/llm-providers/:id` moves a provider's base URL without
      // changing its id, which is the nearest signal a pinned-vLLM-version
      // change leaves — so the URL is in the identity in its own right.
      resolver.resolve.mockResolvedValue({
        config: { providerId: '00000000-0000-4000-8000-000000000001', baseUrl: 'http://vl-2/v1' },
        model: 'Qwen/Qwen3-VL-Embedding-2B',
      });
      const res = await app.inject({ method: 'GET', url: '/api/admin/embedding/image-index' });
      expect(res.json().identityMatchesAssignment).toBe(false);
    });

    it('is false when only the MRL truncation width moved', async () => {
      target.dims.mockResolvedValue(2048);
      const res = await app.inject({ method: 'GET', url: '/api/admin/embedding/image-index' });
      expect(res.json().identityMatchesAssignment).toBe(false);
    });

    it('is null with nothing to compare — an unassigned leg or a fresh install', async () => {
      // Neither is a mismatch, and rendering one would put a permanent amber
      // strip on every new deployment.
      index.identity.mockResolvedValue(null);
      const fresh = await app.inject({ method: 'GET', url: '/api/admin/embedding/image-index' });
      expect(ImageIndexStatusSchema.parse(fresh.json()).identityMatchesAssignment).toBeNull();

      resolver.resolve.mockResolvedValue(null);
      const off = await app.inject({ method: 'GET', url: '/api/admin/embedding/image-index' });
      expect(ImageIndexStatusSchema.parse(off.json()).identityMatchesAssignment).toBeNull();
    });
  });

  it('never leaks the provider base URL or key into the identity', async () => {
    // This is the index document, not the provider document (#1184's rule).
    const res = await app.inject({ method: 'GET', url: '/api/admin/embedding/image-index' });
    expect(JSON.stringify(res.json())).not.toContain('http://vl/v1');
  });

  it('reports an unassigned leg without claiming the index is empty', async () => {
    // Unassigning destroys nothing (ADR-025 D7), so the rows stay reported.
    resolver.resolve.mockResolvedValue(null);
    const res = await app.inject({ method: 'GET', url: '/api/admin/embedding/image-index' });
    const parsed = ImageIndexStatusSchema.parse(res.json());
    expect(parsed.assigned).toBe(false);
    expect(parsed.identity).toBeNull();
    expect(parsed.rows).toBe(12);
  });

  it('answers a null tier rather than 500ing on an out-of-range recorded width', async () => {
    // The width comes from an `admin_settings` row a dump or psql can set.
    index.dims.mockResolvedValue(999_999);
    const res = await app.inject({ method: 'GET', url: '/api/admin/embedding/image-index' });
    expect(res.statusCode).toBe(200);
    expect(res.json().identity.tier).toBeNull();
  });

  it('reports a running scan, which is what the card polls on', async () => {
    redis.locked.mockResolvedValue(true);
    const res = await app.inject({ method: 'GET', url: '/api/admin/embedding/image-index' });
    expect(res.json().running).toBe(true);
  });

  it('POST rescan marks every page and kicks the worker', async () => {
    svc.markAll.mockResolvedValue(87);
    svc.process.mockResolvedValue({ pages: 0 });

    const res = await app.inject({ method: 'POST', url: '/api/admin/embedding/image-index/rescan' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ marked: 87, started: true, alreadyRunning: false });
    expect(svc.markAll).toHaveBeenCalledTimes(1);
    expect(svc.process).toHaveBeenCalledTimes(1);
  });

  /**
   * Review r2 — `started: true` was answered whether or not anything started.
   *
   * `kickScan` is fire-and-forget, so the route never observed the worker's own
   * `alreadyRunning` verdict, and the card toasted "scan started" for a trigger
   * that did nothing. The second half is the one with a lasting effect: the
   * in-flight run advances its OFFSET over a result set that a Re-scan just
   * grew, so pages marked ahead of that offset are never visited by it and stay
   * dirty until something kicks the worker again — which on a local-only
   * instance is only these two buttons.
   */
  describe('a trigger that lands on a running scan', () => {
    it('rescan says so instead of claiming a scan started', async () => {
      redis.locked.mockResolvedValue(true);
      svc.markAll.mockResolvedValue(12);
      svc.process.mockResolvedValue({ pages: 0, alreadyRunning: true });

      const res = await app.inject({ method: 'POST', url: '/api/admin/embedding/image-index/rescan' });

      expect(res.statusCode).toBe(200);
      // The pages really were marked — that half always happens.
      expect(res.json()).toEqual({ marked: 12, started: false, alreadyRunning: true });
      expect(svc.markAll).toHaveBeenCalledTimes(1);
    });

    it('process says so instead of claiming a scan started', async () => {
      redis.locked.mockResolvedValue(true);
      svc.process.mockResolvedValue({ pages: 0, alreadyRunning: true });

      const res = await app.inject({ method: 'POST', url: '/api/admin/embedding/image-index/process' });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ started: false, alreadyRunning: true });
    });

    it('still kicks, because the lock can be released between the read and the kick', async () => {
      // Reported pessimistically and kicked anyway: the alternative is a window
      // in which the lock frees right after the check and nothing runs at all.
      redis.locked.mockResolvedValue(true);
      svc.process.mockResolvedValue({ pages: 0, alreadyRunning: true });

      await app.inject({ method: 'POST', url: '/api/admin/embedding/image-index/process' });

      expect(svc.process).toHaveBeenCalledTimes(1);
    });
  });

  it('POST process kicks the worker without marking anything', async () => {
    svc.process.mockResolvedValue({ pages: 0 });

    const res = await app.inject({ method: 'POST', url: '/api/admin/embedding/image-index/process' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ started: true, alreadyRunning: false });
    expect(svc.markAll).not.toHaveBeenCalled();
    expect(svc.process).toHaveBeenCalledTimes(1);
  });

  it('answers immediately — the scan is fire-and-forget, not the response', async () => {
    // A corpus-wide scan can run for minutes; awaiting it inside the request
    // would hold a connection open past every proxy timeout in the path.
    let release!: () => void;
    svc.process.mockImplementation(
      () => new Promise<void>((resolve) => { release = resolve; }),
    );

    const res = await app.inject({ method: 'POST', url: '/api/admin/embedding/image-index/process' });

    expect(res.statusCode).toBe(200);
    release();
  });

  it('does not fail the request when the kicked scan rejects', async () => {
    svc.process.mockRejectedValue(new Error('provider down'));
    const res = await app.inject({ method: 'POST', url: '/api/admin/embedding/image-index/process' });
    expect(res.statusCode).toBe(200);
  });

  it.each([
    ['GET', '/api/admin/embedding/image-index'],
    ['POST', '/api/admin/embedding/image-index/rescan'],
    ['POST', '/api/admin/embedding/image-index/process'],
  ])('%s %s is admin-only', async (method, url) => {
    isAdmin = false;
    const res = await app.inject({ method: method as 'GET' | 'POST', url });
    expect(res.statusCode).toBe(403);
  });
});
