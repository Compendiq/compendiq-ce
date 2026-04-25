import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../core/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// `redis-cache-bus` is consumed by `initLlmQueueClusterCoordination` and the
// new cluster-wide setters. Mock both `publish` (assert it fires on the right
// channel from setters) and `subscribe` (capture the registered handler so
// tests can simulate an inbound invalidation).
const mockPublish = vi.fn(async () => undefined);
let cacheBusHandler: ((payload: unknown) => void | Promise<void>) | null = null;
const mockSubscribe = vi.fn((channel: string, handler: (payload: unknown) => void | Promise<void>) => {
  cacheBusHandler = handler;
  return () => { cacheBusHandler = null; };
});
vi.mock('../../../core/services/redis-cache-bus.js', () => ({
  publish: (...args: unknown[]) => mockPublish(...args as [string, unknown]),
  subscribe: (channel: string, handler: (payload: unknown) => void | Promise<void>) =>
    mockSubscribe(channel, handler),
  // Tests don't exercise the reconnect path — return a noop.
  onReconnect: () => () => undefined,
}));

// `getLlmConcurrency` / `getLlmMaxQueueDepth` are imported by `llm-queue.ts`
// to prime `_limiter` on init. Provide controllable mocks so tests can drive
// the values returned by `initLlmQueueClusterCoordination`.
let cachedConcurrency = 4;
let cachedMaxQueueDepth = 50;
vi.mock('../../../core/services/admin-settings-service.js', () => ({
  getLlmConcurrency: () => cachedConcurrency,
  getLlmMaxQueueDepth: () => cachedMaxQueueDepth,
}));

// `query` is imported dynamically inside `initLlmQueue` and the new
// cluster-wide setters / subscriber. We mock it so tests can drive the DB
// reads on cache-bus invalidation and assert the UPSERT calls from the
// setters.
const mockQuery = vi.fn();
vi.mock('../../../core/db/postgres.js', () => ({
  query: (sql: string, params?: unknown[]) => mockQuery(sql, params),
}));

describe('llm-queue', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('enqueue executes the function', async () => {
    const { enqueue } = await import('./llm-queue.js');
    const result = await enqueue(() => Promise.resolve(42));
    expect(result).toBe(42);
  });

  it('enqueue respects concurrency', async () => {
    const { enqueue, setConcurrency, getMetrics } = await import('./llm-queue.js');
    setConcurrency(2);

    let running = 0;
    let maxRunning = 0;

    const task = () => new Promise<void>((resolve) => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      setTimeout(() => { running--; resolve(); }, 50);
    });

    await Promise.all([enqueue(task), enqueue(task), enqueue(task), enqueue(task)]);
    expect(maxRunning).toBeLessThanOrEqual(2);
    expect(getMetrics().totalProcessed).toBeGreaterThanOrEqual(4);
  });

  it('enqueue rejects when queue is full', async () => {
    const { enqueue, setConcurrency, setMaxQueueDepth, QueueFullError } = await import('./llm-queue.js');
    setConcurrency(1);
    setMaxQueueDepth(1);

    const blocker = enqueue(() => new Promise<void>((resolve) => setTimeout(resolve, 200)));
    const second = enqueue(() => Promise.resolve());

    await expect(enqueue(() => Promise.resolve())).rejects.toThrow(QueueFullError);

    await blocker;
    await second;
  });

  it('getMetrics returns correct counts', async () => {
    const { getMetrics, setConcurrency } = await import('./llm-queue.js');
    setConcurrency(4);

    const metrics = getMetrics();
    expect(metrics.concurrency).toBe(4);
    expect(metrics.activeCount).toBe(0);
    expect(metrics.pendingCount).toBe(0);
    expect(metrics.maxQueueDepth).toBe(50);
  });

  it('setConcurrency clamps to valid range', async () => {
    const { setConcurrency, getMetrics } = await import('./llm-queue.js');

    setConcurrency(0);
    expect(getMetrics().concurrency).toBe(1);

    setConcurrency(200);
    expect(getMetrics().concurrency).toBe(100);
  });

  describe('env-var fallback defaults', () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
      // Restore env to original snapshot so env var leakage doesn't break
      // other tests in this suite.
      process.env = { ...originalEnv };
      vi.resetModules();
    });

    it('honors LLM_CONCURRENCY when admin_settings row is absent', async () => {
      process.env.LLM_CONCURRENCY = '1';
      delete process.env.LLM_MAX_QUEUE_DEPTH;
      vi.resetModules();
      const { getMetrics } = await import('./llm-queue.js');
      expect(getMetrics().concurrency).toBe(1);
    });

    it('honors LLM_MAX_QUEUE_DEPTH when admin_settings row is absent', async () => {
      process.env.LLM_MAX_QUEUE_DEPTH = '7';
      delete process.env.LLM_CONCURRENCY;
      vi.resetModules();
      const { getMetrics } = await import('./llm-queue.js');
      expect(getMetrics().maxQueueDepth).toBe(7);
    });

    it('falls back to hardcoded defaults when env vars are unset', async () => {
      delete process.env.LLM_CONCURRENCY;
      delete process.env.LLM_MAX_QUEUE_DEPTH;
      vi.resetModules();
      const { getMetrics } = await import('./llm-queue.js');
      expect(getMetrics().concurrency).toBe(4);
      expect(getMetrics().maxQueueDepth).toBe(50);
    });

    it('ignores invalid env-var values and falls back to hardcoded defaults', async () => {
      process.env.LLM_CONCURRENCY = 'not-a-number';
      process.env.LLM_MAX_QUEUE_DEPTH = '0';
      vi.resetModules();
      const { getMetrics } = await import('./llm-queue.js');
      expect(getMetrics().concurrency).toBe(4);
      expect(getMetrics().maxQueueDepth).toBe(50);
    });

    it('LLM_CONCURRENCY=1 limits actual concurrent execution', async () => {
      process.env.LLM_CONCURRENCY = '1';
      vi.resetModules();
      const { enqueue, getMetrics } = await import('./llm-queue.js');
      expect(getMetrics().concurrency).toBe(1);

      let running = 0;
      let maxRunning = 0;
      const task = () => new Promise<void>((resolve) => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        setTimeout(() => { running--; resolve(); }, 30);
      });
      await Promise.all([enqueue(task), enqueue(task), enqueue(task)]);
      expect(maxRunning).toBe(1);
    });
  });

  // ─── #113 Phase B-3 — cluster-wide coordination ─────────────────────────
  describe('cluster-wide coordination (Phase B-3)', () => {
    beforeEach(() => {
      mockPublish.mockReset();
      mockPublish.mockResolvedValue(undefined);
      mockSubscribe.mockClear();
      mockQuery.mockReset();
      cacheBusHandler = null;
      cachedConcurrency = 4;
      cachedMaxQueueDepth = 50;
      vi.resetModules();
    });

    describe('setLlmConcurrencyClusterWide', () => {
      it('UPSERTs admin_settings.llm_concurrency and publishes admin:llm:settings', async () => {
        mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });
        const { setLlmConcurrencyClusterWide } = await import('./llm-queue.js');

        await setLlmConcurrencyClusterWide(10);

        // UPSERT — the setter sends the value as a string ('10').
        const upsertCall = mockQuery.mock.calls.find(
          ([sql]) =>
            typeof sql === 'string'
            && sql.includes('INSERT INTO admin_settings')
            && sql.includes('llm_concurrency'),
        );
        expect(upsertCall).toBeDefined();
        expect(upsertCall?.[1]).toEqual(['10']);

        // Publish — channel + payload shape (advisory only).
        expect(mockPublish).toHaveBeenCalledTimes(1);
        const [channel, payload] = mockPublish.mock.calls[0]!;
        expect(channel).toBe('admin:llm:settings');
        expect(payload).toEqual(expect.objectContaining({ at: expect.any(Number) }));
      });

      it('clamps the concurrency value to [1, 100] before persisting', async () => {
        mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });
        const { setLlmConcurrencyClusterWide } = await import('./llm-queue.js');

        await setLlmConcurrencyClusterWide(0);
        await setLlmConcurrencyClusterWide(500);

        const lowValue = mockQuery.mock.calls.find(
          ([sql, params]) =>
            typeof sql === 'string'
            && sql.includes('llm_concurrency')
            && Array.isArray(params)
            && params[0] === '1',
        );
        const highValue = mockQuery.mock.calls.find(
          ([sql, params]) =>
            typeof sql === 'string'
            && sql.includes('llm_concurrency')
            && Array.isArray(params)
            && params[0] === '100',
        );
        expect(lowValue).toBeDefined();
        expect(highValue).toBeDefined();
      });
    });

    describe('setLlmMaxQueueDepthClusterWide', () => {
      it('UPSERTs admin_settings.llm_max_queue_depth and publishes', async () => {
        mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });
        const { setLlmMaxQueueDepthClusterWide } = await import('./llm-queue.js');

        await setLlmMaxQueueDepthClusterWide(75);

        const upsertCall = mockQuery.mock.calls.find(
          ([sql]) =>
            typeof sql === 'string'
            && sql.includes('INSERT INTO admin_settings')
            && sql.includes('llm_max_queue_depth'),
        );
        expect(upsertCall).toBeDefined();
        expect(upsertCall?.[1]).toEqual(['75']);
        expect(mockPublish).toHaveBeenCalledWith('admin:llm:settings', expect.any(Object));
      });
    });

    describe('initLlmQueueClusterCoordination', () => {
      it('subscribes to admin:llm:settings and primes _limiter from the cached getter', async () => {
        cachedConcurrency = 12;
        cachedMaxQueueDepth = 250;

        const { initLlmQueueClusterCoordination, getMetrics, _resetClusterCoordinationForTests } =
          await import('./llm-queue.js');
        _resetClusterCoordinationForTests();

        initLlmQueueClusterCoordination();

        // Subscribed exactly once on the right channel.
        const channels = mockSubscribe.mock.calls.map((c) => c[0]);
        expect(channels).toContain('admin:llm:settings');

        // Primed from the cached getter — the limiter swap goes through
        // `setConcurrency`, which clamps + updates `_concurrency`.
        const m = getMetrics();
        expect(m.concurrency).toBe(12);
        expect(m.maxQueueDepth).toBe(250);
      });

      it('on incoming message, re-reads DB and swaps _limiter via setConcurrency', async () => {
        // Initial state: 4. After the cache-bus message, the handler reads
        // `admin_settings` and finds llm_concurrency=20.
        const { initLlmQueueClusterCoordination, getMetrics, _resetClusterCoordinationForTests } =
          await import('./llm-queue.js');
        _resetClusterCoordinationForTests();

        // Prime read (concurrency=4 already; cached getters return the default).
        initLlmQueueClusterCoordination();
        expect(getMetrics().concurrency).toBe(4);

        // Now the handler runs because pod B PUT a new value. The handler
        // SELECTs both keys; the mock returns 20 for concurrency and the
        // existing value for depth.
        mockQuery.mockResolvedValueOnce({
          rows: [
            { setting_key: 'llm_concurrency', setting_value: '20' },
            { setting_key: 'llm_max_queue_depth', setting_value: '250' },
          ],
        });

        expect(cacheBusHandler).not.toBeNull();
        await cacheBusHandler!({ at: Date.now() });

        const m = getMetrics();
        expect(m.concurrency).toBe(20);
        expect(m.maxQueueDepth).toBe(250);
      });

      it('on incoming message with invalid DB value, leaves _limiter unchanged', async () => {
        const { initLlmQueueClusterCoordination, getMetrics, _resetClusterCoordinationForTests } =
          await import('./llm-queue.js');
        _resetClusterCoordinationForTests();
        initLlmQueueClusterCoordination();

        const before = getMetrics().concurrency;

        // Corrupted DB row — 0 is below the minimum, the handler must skip.
        mockQuery.mockResolvedValueOnce({
          rows: [{ setting_key: 'llm_concurrency', setting_value: '0' }],
        });
        await cacheBusHandler!({ at: 1 });

        expect(getMetrics().concurrency).toBe(before);
      });

      it('is idempotent — second init while active is a no-op', async () => {
        const { initLlmQueueClusterCoordination, _resetClusterCoordinationForTests } =
          await import('./llm-queue.js');
        _resetClusterCoordinationForTests();

        initLlmQueueClusterCoordination();
        const subsAfterFirst = mockSubscribe.mock.calls.length;
        initLlmQueueClusterCoordination();
        expect(mockSubscribe.mock.calls.length).toBe(subsAfterFirst);
      });

      it('soft-fails when subscribe throws (single-pod / no Redis)', async () => {
        mockSubscribe.mockImplementationOnce(() => {
          throw new Error('cache-bus inactive');
        });

        const { initLlmQueueClusterCoordination, getMetrics, _resetClusterCoordinationForTests } =
          await import('./llm-queue.js');
        _resetClusterCoordinationForTests();

        // Should NOT throw — the queue still primes from the cached getter.
        expect(() => initLlmQueueClusterCoordination()).not.toThrow();
        // Default cached values applied.
        expect(getMetrics().concurrency).toBe(4);
      });
    });
  });
});
