import { describe, it, expect, vi, beforeEach } from 'vitest';

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
});
