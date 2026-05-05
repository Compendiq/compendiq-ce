/**
 * In-memory mode covers the unit tests. Redis-backed correctness is covered
 * by a Redis-using integration test in the sibling redis-cache-bus.test.ts
 * pattern (deferred — getRedisClient() is mocked here).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  startBulkJob,
  publishProgress,
  cancelBulkJob,
  isBulkJobCancelled,
  streamBulkProgress,
  runBulkInChunks,
  newJobId,
  _resetMemoryJobsForTests,
} from './bulk-page-progress.js';

vi.mock('./redis-cache.js', () => ({
  getRedisClient: vi.fn().mockReturnValue(null),
}));

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('bulk-page-progress (in-memory)', () => {
  beforeEach(() => {
    _resetMemoryJobsForTests();
  });

  it('newJobId returns a unique id every call', () => {
    const a = newJobId();
    const b = newJobId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('publishProgress without a started job is a no-op (does not throw)', async () => {
    await expect(publishProgress('not-started', { completed: 5 })).resolves.toBeUndefined();
  });

  it('isBulkJobCancelled returns false until cancelBulkJob is called', async () => {
    const jobId = newJobId();
    await startBulkJob(jobId, 10, 'user-1', 'replace-tags');
    expect(await isBulkJobCancelled(jobId)).toBe(false);
    await cancelBulkJob(jobId);
    expect(await isBulkJobCancelled(jobId)).toBe(true);
  });

  it('streamBulkProgress replays history then yields published events to done', async () => {
    const jobId = newJobId();
    await startBulkJob(jobId, 100, 'user-1', 'replace-tags');
    await publishProgress(jobId, { completed: 25 });
    await publishProgress(jobId, { completed: 50 });

    const controller = new AbortController();
    const events: number[] = [];

    // Run the consumer concurrently with later publishes.
    const consumer = (async () => {
      for await (const ev of streamBulkProgress(jobId, controller.signal)) {
        // Ignore keepalive ticks (they reuse the last completed value).
        if (ev.note === 'keepalive') continue;
        events.push(ev.completed);
        if (ev.done || ev.cancelled) break;
      }
    })();

    // Microtask hop so the consumer drains history first.
    await new Promise((r) => setTimeout(r, 0));
    await publishProgress(jobId, { completed: 75 });
    await publishProgress(jobId, { completed: 100, done: true });
    await consumer;

    // History 0,25,50 + live 75,100 — consumer sees all, ending on done.
    expect(events).toContain(0);
    expect(events).toContain(25);
    expect(events).toContain(50);
    expect(events).toContain(75);
    expect(events).toContain(100);
  });

  it('streamBulkProgress aborts cleanly when signal fires', async () => {
    const jobId = newJobId();
    await startBulkJob(jobId, 10, 'user-1', 'replace-tags');

    const controller = new AbortController();
    const collected: boolean[] = [];

    const consumer = (async () => {
      for await (const ev of streamBulkProgress(jobId, controller.signal)) {
        collected.push(ev.cancelled);
      }
    })();

    await new Promise((r) => setTimeout(r, 5));
    controller.abort();

    // The consumer must terminate within a reasonable window despite no
    // further events being published.
    await Promise.race([
      consumer,
      new Promise((_, reject) => setTimeout(() => reject(new Error('consumer hung after abort')), 1000)),
    ]);

    // Initial event was emitted, no cancellation set.
    expect(collected.length).toBeGreaterThanOrEqual(1);
    expect(collected.every((c) => c === false)).toBe(true);
  });

  it('runBulkInChunks aggregates per-chunk results and publishes progress', async () => {
    const jobId = newJobId();
    await startBulkJob(jobId, 30, 'user-1', 'replace-tags');

    const result = await runBulkInChunks(
      Array.from({ length: 30 }, (_, i) => i),
      10,
      jobId,
      async (chunk) => ({
        succeeded: chunk.length - 1,
        failed: 1,
        errors: [`row ${chunk[0]}: simulated error`],
      }),
    );

    expect(result.succeeded).toBe(27);
    expect(result.failed).toBe(3);
    expect(result.errors).toHaveLength(3);
    expect(result.cancelled).toBe(false);
  });

  it('runBulkInChunks bails out when the job is cancelled mid-flight', async () => {
    const jobId = newJobId();
    await startBulkJob(jobId, 100, 'user-1', 'replace-tags');

    let chunksRun = 0;
    const result = await runBulkInChunks(
      Array.from({ length: 100 }, (_, i) => i),
      10,
      jobId,
      async (chunk) => {
        chunksRun++;
        if (chunksRun === 2) {
          await cancelBulkJob(jobId);
        }
        return { succeeded: chunk.length, failed: 0, errors: [] };
      },
    );

    expect(result.cancelled).toBe(true);
    expect(chunksRun).toBeLessThan(10);
    expect(result.succeeded).toBeGreaterThan(0);
  });

  it('runBulkInChunks works without a jobId (legacy / no-progress path)', async () => {
    const result = await runBulkInChunks(
      [1, 2, 3, 4, 5],
      2,
      null,
      async (chunk) => ({ succeeded: chunk.length, failed: 0, errors: [] }),
    );
    expect(result.succeeded).toBe(5);
    expect(result.cancelled).toBe(false);
  });

  it('cancelBulkJob causes streamBulkProgress to terminate with cancelled=true', async () => {
    const jobId = newJobId();
    await startBulkJob(jobId, 10, 'user-1', 'replace-tags');

    const controller = new AbortController();
    const lastSeen: { cancelled: boolean }[] = [];

    const consumer = (async () => {
      for await (const ev of streamBulkProgress(jobId, controller.signal)) {
        lastSeen.push({ cancelled: ev.cancelled });
        if (ev.cancelled) break;
      }
    })();

    await new Promise((r) => setTimeout(r, 5));
    await cancelBulkJob(jobId);
    await consumer;

    expect(lastSeen.some((e) => e.cancelled)).toBe(true);
    expect(await isBulkJobCancelled(jobId)).toBe(true);
  });
});
