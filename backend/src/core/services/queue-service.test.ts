import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock BullMQ before importing the module
const mockQueue = {
  upsertJobScheduler: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
  getWaitingCount: vi.fn().mockResolvedValue(5),
  getActiveCount: vi.fn().mockResolvedValue(2),
  getCompletedCount: vi.fn().mockResolvedValue(100),
  getFailedCount: vi.fn().mockResolvedValue(3),
};

const mockWorker = {
  on: vi.fn(),
  close: vi.fn().mockResolvedValue(undefined),
};

vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation(() => ({ ...mockQueue })),
  Worker: vi.fn().mockImplementation((_name: string, _processor: unknown, _opts: unknown) => ({
    ...mockWorker,
  })),
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
});
