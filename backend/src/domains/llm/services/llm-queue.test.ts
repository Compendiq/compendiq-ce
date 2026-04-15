import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../core/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
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
});
