import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  createShutdownHandler,
  resolveShutdownTimeoutMs,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
} from './graceful-shutdown.js';

describe('createShutdownHandler (issue #745)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs all steps in order and exits with code 0', async () => {
    const order: string[] = [];
    const exit = vi.fn();
    const shutdown = createShutdownHandler({
      steps: [
        { name: 'a', run: async () => void order.push('a') },
        { name: 'b', run: () => void order.push('b') },
        { name: 'c', run: async () => void order.push('c') },
      ],
      exit,
    });

    await shutdown('SIGTERM');

    expect(order).toEqual(['a', 'b', 'c']);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('continues past a rejecting step and exits with code 1', async () => {
    const order: string[] = [];
    const exit = vi.fn();
    const shutdown = createShutdownHandler({
      steps: [
        { name: 'a', run: async () => void order.push('a') },
        {
          name: 'redis-quit',
          run: async () => {
            throw new Error('Connection is closed');
          },
        },
        { name: 'c', run: async () => void order.push('c') },
      ],
      exit,
    });

    await shutdown('SIGTERM');

    expect(order).toEqual(['a', 'c']);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('catches synchronously-throwing steps too', async () => {
    const order: string[] = [];
    const exit = vi.fn();
    const shutdown = createShutdownHandler({
      steps: [
        {
          name: 'boom',
          run: () => {
            throw new Error('sync boom');
          },
        },
        { name: 'b', run: async () => void order.push('b') },
      ],
      exit,
    });

    await shutdown('SIGINT');

    expect(order).toEqual(['b']);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('ignores a second signal while a shutdown is already in progress', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runs = vi.fn(() => gate);
    const exit = vi.fn();
    const shutdown = createShutdownHandler({
      steps: [{ name: 'slow', run: runs }],
      exit,
    });

    const first = shutdown('SIGTERM');
    const second = shutdown('SIGINT'); // double-fire while first is mid-flight
    release();
    await Promise.all([first, second]);

    expect(runs).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('force-exits with code 1 when a step hangs past the hard deadline', async () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    const shutdown = createShutdownHandler({
      steps: [{ name: 'hung', run: () => new Promise<void>(() => {}) }],
      timeoutMs: 5_000,
      exit,
    });

    void shutdown('SIGTERM');
    await vi.advanceTimersByTimeAsync(5_000);

    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  // Review follow-up (PR #757): 30s halved the drain window ADR-024 budgets
  // (EE compose stop_grace_period: 60s) — LLM summary/quality/sync jobs
  // awaited by stopQueueWorkers() can exceed 30s and were force-exited.
  it('defaults the hard deadline to 50s (ADR-024 drain budget)', async () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    const shutdown = createShutdownHandler({
      steps: [{ name: 'hung', run: () => new Promise<void>(() => {}) }],
      exit,
    });

    void shutdown('SIGTERM');
    await vi.advanceTimersByTimeAsync(49_999);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('does not fire the deadline exit after a completed shutdown', async () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    const shutdown = createShutdownHandler({
      steps: [{ name: 'fast', run: async () => {} }],
      timeoutMs: 5_000,
      exit,
    });

    await shutdown('SIGTERM');
    await vi.advanceTimersByTimeAsync(10_000);

    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });
});

describe('resolveShutdownTimeoutMs (review follow-up, PR #757)', () => {
  it('returns the 50s default when SHUTDOWN_TIMEOUT_MS is unset', () => {
    expect(resolveShutdownTimeoutMs(undefined)).toBe(DEFAULT_SHUTDOWN_TIMEOUT_MS);
    expect(DEFAULT_SHUTDOWN_TIMEOUT_MS).toBe(50_000);
  });

  it('parses a positive integer of milliseconds', () => {
    expect(resolveShutdownTimeoutMs('15000')).toBe(15_000);
    expect(resolveShutdownTimeoutMs('120000')).toBe(120_000);
  });

  it.each(['', '0', '-5000', 'abc', '1.5', '30s', 'NaN', 'Infinity'])(
    'falls back to the default for invalid value %j',
    (raw) => {
      expect(resolveShutdownTimeoutMs(raw)).toBe(DEFAULT_SHUTDOWN_TIMEOUT_MS);
    },
  );
});
