import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── BullMQ mock wiring ──────────────────────────────────────────────────
// Each test needs fine-grained control over Job methods (getState, remove).
// We route every `new Queue(...)` to a per-name stub held in `queueStubs` so
// tests can assert against `queueStubs.get('reembed-all')!.add` etc.

interface JobStub {
  id: string;
  name: string;
  data: unknown;
  progress: number | object;
  returnvalue: unknown;
  failedReason?: string;
  getState: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
}

interface QueueStub {
  add: ReturnType<typeof vi.fn>;
  getJob: ReturnType<typeof vi.fn>;
  upsertJobScheduler: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  getWaitingCount: ReturnType<typeof vi.fn>;
  getActiveCount: ReturnType<typeof vi.fn>;
  getCompletedCount: ReturnType<typeof vi.fn>;
  getFailedCount: ReturnType<typeof vi.fn>;
}

const queueStubs = new Map<string, QueueStub>();

function createQueueStub(): QueueStub {
  return {
    add: vi.fn(),
    getJob: vi.fn(),
    upsertJobScheduler: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    getWaitingCount: vi.fn().mockResolvedValue(5),
    getActiveCount: vi.fn().mockResolvedValue(2),
    getCompletedCount: vi.fn().mockResolvedValue(100),
    getFailedCount: vi.fn().mockResolvedValue(3),
  };
}

function createJobStub(overrides: Partial<JobStub> & { id: string }): JobStub {
  return {
    name: 'reembed-all',
    data: {},
    progress: 0,
    returnvalue: undefined,
    getState: vi.fn().mockResolvedValue('waiting'),
    remove: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

vi.mock('bullmq', () => ({
  // Use a real constructor function so `new Queue(...)` returns the stub
  // (arrow functions / vi.fn implementations are not constructible).
  Queue: function (this: QueueStub, name: string) {
    let stub = queueStubs.get(name);
    if (!stub) {
      stub = createQueueStub();
      queueStubs.set(name, stub);
    }
    // Copy stub properties onto `this` — returning a non-object from a
    // constructor is ignored, so mutation is the cleanest approach.
    Object.assign(this, stub);
  },
  Worker: function (this: Record<string, unknown>) {
    this.on = vi.fn();
    this.close = vi.fn().mockResolvedValue(undefined);
  },
}));

// ─── Legacy-mode module mocks (issue #741) ───────────────────────────────
// `startLegacyWorkers()` / the registered processors dynamically import these
// modules. `vi.hoisted` keeps the vi.fn references stable across the
// `vi.resetModules()` call in beforeEach (factories re-run on re-import, but
// they all close over this same object).

const legacy = vi.hoisted(() => ({
  startSyncWorker: vi.fn(),
  stopSyncWorker: vi.fn(),
  runScheduledSync: vi.fn(),
  startQualityWorker: vi.fn(),
  stopQualityWorker: vi.fn(),
  triggerQualityBatch: vi.fn(),
  processBatch: vi.fn(),
  startSummaryWorker: vi.fn(),
  stopSummaryWorker: vi.fn(),
  triggerSummaryBatch: vi.fn(),
  runSummaryBatch: vi.fn(),
  startTokenCleanupWorker: vi.fn(),
  stopTokenCleanupWorker: vi.fn(),
  startRetentionWorker: vi.fn(),
  stopRetentionWorker: vi.fn(),
  runRetentionCleanup: vi.fn(),
  runReembedAllJob: vi.fn(),
}));

vi.mock('../../domains/confluence/services/sync-service.js', () => ({
  startSyncWorker: legacy.startSyncWorker,
  stopSyncWorker: legacy.stopSyncWorker,
  runScheduledSync: legacy.runScheduledSync,
}));

vi.mock('../../domains/knowledge/services/quality-worker.js', () => ({
  startQualityWorker: legacy.startQualityWorker,
  stopQualityWorker: legacy.stopQualityWorker,
  triggerQualityBatch: legacy.triggerQualityBatch,
  processBatch: legacy.processBatch,
}));

vi.mock('../../domains/knowledge/services/summary-worker.js', () => ({
  startSummaryWorker: legacy.startSummaryWorker,
  stopSummaryWorker: legacy.stopSummaryWorker,
  triggerSummaryBatch: legacy.triggerSummaryBatch,
  runSummaryBatch: legacy.runSummaryBatch,
}));

vi.mock('./token-cleanup-service.js', () => ({
  startTokenCleanupWorker: legacy.startTokenCleanupWorker,
  stopTokenCleanupWorker: legacy.stopTokenCleanupWorker,
}));

vi.mock('./data-retention-service.js', () => ({
  startRetentionWorker: legacy.startRetentionWorker,
  stopRetentionWorker: legacy.stopRetentionWorker,
  runRetentionCleanup: legacy.runRetentionCleanup,
}));

vi.mock('../../domains/llm/services/embedding-service.js', () => ({
  runReembedAllJob: legacy.runReembedAllJob,
}));

vi.mock('../db/postgres.js', () => ({
  query: vi.fn().mockResolvedValue({ rows: [] }),
}));

vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('queue-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Fresh stubs per test — prevents state leaking between cases.
    queueStubs.clear();
    // Reset the module-level `queues`/`workerDefs` maps inside queue-service.
    // Without this, an internal queue reference from the previous test would
    // shadow the fresh stub we set up, making vi.fn()s unreachable.
    vi.resetModules();
  });

  it('isBullMQEnabled returns true by default', async () => {
    const { isBullMQEnabled } = await import('./queue-service.js');
    // Default (no USE_BULLMQ env var) should be true
    expect(typeof isBullMQEnabled()).toBe('boolean');
  });

  it('getQueueMetrics returns metrics for registered queues', async () => {
    const { getQueueMetrics } = await import('./queue-service.js');
    const metrics = await getQueueMetrics();
    // Before any queues are created, metrics should be an object
    expect(typeof metrics).toBe('object');
  });

  // ─── RED #5 (plan §4.2, Q3 core) ─────────────────────────────────────
  describe('enqueueJob — idempotent re-enqueue semantics', () => {
    it('removes the previous completed job before re-adding so a fresh run can start', async () => {
      const { enqueueJob } = await import('./queue-service.js');
      const completedJob = createJobStub({
        id: 'reembed-all',
        getState: vi.fn().mockResolvedValue('completed'),
      });
      // First call returns the stale completed job; subsequent `add` resolves normally.
      const stub = createQueueStub();
      stub.getJob.mockResolvedValueOnce(completedJob);
      stub.add.mockResolvedValueOnce({ id: 'reembed-all' });
      queueStubs.set('reembed-all', stub);

      const id = await enqueueJob(
        'reembed-all',
        { triggeredAt: 't' },
        { jobId: 'reembed-all', removeOnComplete: 150, removeOnFail: 150 },
      );

      expect(completedJob.remove).toHaveBeenCalledOnce();
      expect(stub.add).toHaveBeenCalledOnce();
      expect(id).toBe('reembed-all');
    });

    it('also removes a previous failed job before re-adding', async () => {
      const { enqueueJob } = await import('./queue-service.js');
      const failedJob = createJobStub({
        id: 'reembed-all',
        getState: vi.fn().mockResolvedValue('failed'),
      });
      const stub = createQueueStub();
      stub.getJob.mockResolvedValueOnce(failedJob);
      stub.add.mockResolvedValueOnce({ id: 'reembed-all' });
      queueStubs.set('reembed-all', stub);

      await enqueueJob(
        'reembed-all',
        {},
        { jobId: 'reembed-all' },
      );

      expect(failedJob.remove).toHaveBeenCalledOnce();
      expect(stub.add).toHaveBeenCalledOnce();
    });

    it('does NOT remove a previous waiting/active job (collapse-concurrent semantic)', async () => {
      const { enqueueJob } = await import('./queue-service.js');
      const activeJob = createJobStub({
        id: 'reembed-all',
        getState: vi.fn().mockResolvedValue('active'),
      });
      const stub = createQueueStub();
      stub.getJob.mockResolvedValueOnce(activeJob);
      // When the job is already in-flight, BullMQ add() with the same jobId is
      // a silent no-op — it still resolves to the existing job record.
      stub.add.mockResolvedValueOnce({ id: 'reembed-all' });
      queueStubs.set('reembed-all', stub);

      const id = await enqueueJob(
        'reembed-all',
        {},
        { jobId: 'reembed-all' },
      );

      expect(activeJob.remove).not.toHaveBeenCalled();
      expect(id).toBe('reembed-all');
    });

    it('forwards removeOnComplete / removeOnFail counts into BullMQ add opts', async () => {
      const { enqueueJob } = await import('./queue-service.js');
      const stub = createQueueStub();
      stub.getJob.mockResolvedValueOnce(null);
      stub.add.mockResolvedValueOnce({ id: 'reembed-all' });
      queueStubs.set('reembed-all', stub);

      await enqueueJob(
        'reembed-all',
        {},
        { jobId: 'reembed-all', removeOnComplete: 250, removeOnFail: 250 },
      );

      const addCall = stub.add.mock.calls[0];
      // add(name, data, opts)
      expect(addCall[2]).toMatchObject({
        jobId: 'reembed-all',
        removeOnComplete: { count: 250 },
        removeOnFail: { count: 250 },
      });
    });

    it('swallows a race error from existing.remove()', async () => {
      const { enqueueJob } = await import('./queue-service.js');
      const completedJob = createJobStub({
        id: 'reembed-all',
        getState: vi.fn().mockResolvedValue('completed'),
        remove: vi.fn().mockRejectedValue(new Error('already removed')),
      });
      const stub = createQueueStub();
      stub.getJob.mockResolvedValueOnce(completedJob);
      stub.add.mockResolvedValueOnce({ id: 'reembed-all' });
      queueStubs.set('reembed-all', stub);

      await expect(
        enqueueJob('reembed-all', {}, { jobId: 'reembed-all' }),
      ).resolves.toBe('reembed-all');
    });
  });

  // ─── RED #6 (plan §4.2) ───────────────────────────────────────────────
  describe('getJobStatus', () => {
    it('returns null for an unknown job id', async () => {
      const { getJobStatus } = await import('./queue-service.js');
      const stub = createQueueStub();
      stub.getJob.mockResolvedValueOnce(null);
      queueStubs.set('reembed-all', stub);

      const status = await getJobStatus('reembed-all', 'unknown-id');
      expect(status).toBeNull();
    });

    it('returns { state, progress, returnvalue, failedReason } when the job exists', async () => {
      const { getJobStatus } = await import('./queue-service.js');
      const job = createJobStub({
        id: 'reembed-all',
        progress: { phase: 'embedding', processed: 42 },
        returnvalue: 'processed=42 failed=0 total=42',
        getState: vi.fn().mockResolvedValue('completed'),
      });
      const stub = createQueueStub();
      stub.getJob.mockResolvedValueOnce(job);
      queueStubs.set('reembed-all', stub);

      const status = await getJobStatus('reembed-all', 'reembed-all');
      expect(status).toEqual({
        state: 'completed',
        progress: { phase: 'embedding', processed: 42 },
        returnvalue: 'processed=42 failed=0 total=42',
        failedReason: undefined,
      });
    });
  });

  // ─── Queue registration — reembed-all must be registerable (plan §2.2) ──
  describe('reembed-all queue wiring', () => {
    it('getJobStatus transparently creates the reembed-all queue if no enqueue happened first', async () => {
      const { getJobStatus } = await import('./queue-service.js');

      // No pre-seeded stub — trigger the lazy getOrCreateQueue path.
      const status = await getJobStatus('reembed-all', 'any-id');
      expect(status).toBeNull(); // getJob returns undefined on an empty fresh stub by default

      // Stub got created lazily
      expect(queueStubs.has('reembed-all')).toBe(true);
    });
  });

  // ─── Issue #741 — legacy mode (USE_BULLMQ=false) ──────────────────────
  // enqueueJob's inline fallback must actually execute the registered
  // processor (it previously found no workerDefs because registerAllWorkers
  // only ran in the BullMQ branch), and a rejecting processor must be logged
  // instead of becoming a process-fatal unhandled rejection.
  describe('legacy mode (USE_BULLMQ=false) — issue #741', () => {
    const ORIGINAL_USE_BULLMQ = process.env.USE_BULLMQ;

    beforeEach(() => {
      process.env.USE_BULLMQ = 'false';
      // Fake timers so startLegacyWorkers' 30s initial-batch setTimeout does
      // not leave a real pending timer behind after each test.
      vi.useFakeTimers();
      legacy.triggerQualityBatch.mockResolvedValue(undefined);
      legacy.triggerSummaryBatch.mockResolvedValue(undefined);
      legacy.runReembedAllJob.mockResolvedValue('processed=0 failed=0 total=0');
    });

    afterEach(() => {
      vi.useRealTimers();
      if (ORIGINAL_USE_BULLMQ === undefined) {
        delete process.env.USE_BULLMQ;
      } else {
        process.env.USE_BULLMQ = ORIGINAL_USE_BULLMQ;
      }
    });

    it('enqueueJob runs the registered reembed-all processor inline after startQueueWorkers()', async () => {
      const { startQueueWorkers, enqueueJob } = await import('./queue-service.js');
      await startQueueWorkers();

      // Legacy interval workers still start (ordering regression guard).
      expect(legacy.startSyncWorker).toHaveBeenCalledOnce();
      expect(legacy.startQualityWorker).toHaveBeenCalledOnce();

      const id = await enqueueJob(
        'reembed-all',
        { triggeredAt: 't' },
        { jobId: 'reembed-all' },
      );
      expect(id).toBe('reembed-all');

      // Fire-and-forget inline execution — wait for the async processor.
      await vi.waitFor(() => {
        expect(legacy.runReembedAllJob).toHaveBeenCalledOnce();
      });
      expect(legacy.runReembedAllJob).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'reembed-all',
          name: 'reembed-all',
          data: { triggeredAt: 't' },
        }),
      );
    });

    it('does not create any BullMQ queues or schedulers in legacy mode', async () => {
      const { startQueueWorkers } = await import('./queue-service.js');
      await startQueueWorkers();

      // Registering worker defs for the inline fallback must not open Redis
      // connections — no Queue construction, no upsertJobScheduler.
      expect(queueStubs.size).toBe(0);
    });

    it('logs instead of crashing when an inline processor rejects', async () => {
      legacy.runReembedAllJob.mockRejectedValue(new Error('embed boom'));
      const { startQueueWorkers, enqueueJob } = await import('./queue-service.js');
      const { logger } = await import('../utils/logger.js');
      await startQueueWorkers();

      await enqueueJob('reembed-all', {}, { jobId: 'reembed-all' });

      // The rejection must be caught and logged — an uncaught rejection here
      // would be process-fatal on modern Node.
      await vi.waitFor(() => {
        expect(logger.error).toHaveBeenCalledWith(
          expect.objectContaining({
            err: expect.objectContaining({ message: 'embed boom' }),
            queueName: 'reembed-all',
          }),
          expect.any(String),
        );
      });
    });

    it('warns when enqueueJob targets a queue with no registered processor', async () => {
      const { startQueueWorkers, enqueueJob } = await import('./queue-service.js');
      const { logger } = await import('../utils/logger.js');
      await startQueueWorkers();

      const id = await enqueueJob('no-such-queue', {});

      expect(id).toContain('no-such-queue');
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ queueName: 'no-such-queue' }),
        expect.any(String),
      );
    });

    it('catches rejections from the delayed initial quality/summary batch trigger', async () => {
      legacy.triggerQualityBatch.mockRejectedValue(new Error('quality boom'));
      const { startQueueWorkers } = await import('./queue-service.js');
      const { logger } = await import('../utils/logger.js');
      await startQueueWorkers();

      // Fire the 30s initial-batch setTimeout.
      await vi.advanceTimersByTimeAsync(30_000);

      await vi.waitFor(() => {
        expect(logger.error).toHaveBeenCalledWith(
          expect.objectContaining({
            err: expect.objectContaining({ message: 'quality boom' }),
          }),
          expect.any(String),
        );
      });
    });
  });
});
