/**
 * Redis-backed `streamBulkProgress` against a REAL Redis (#1785).
 *
 * The generator used to replay the durable list and only then subscribe to
 * live pub/sub. A terminal event published in that gap existed in Redis but
 * never reached the SSE consumer, which then waited forever. These tests
 * drive the generator by hand with `.next()` so the interleaving is exact:
 * every publish happens while the generator is suspended at a known yield.
 *
 * Pattern: test-redis-helper probe + `describe.skipIf`, as in
 * collab-room-service.test.ts. No fake timers — the generator's own 15s
 * keepalive is far longer than the explicit per-step deadline below, so a
 * lost terminal event shows up as a deadline failure, not a hang.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createClient, type RedisClientType } from 'redis';
import { isRedisAvailable } from '../../test-redis-helper.js';
import { setRedisClient } from './redis-cache.js';
import {
  startBulkJob,
  publishProgress,
  cancelBulkJob,
  streamBulkProgress,
  newJobId,
  type BulkProgressEvent,
} from './bulk-page-progress.js';

const redisAvailable = await isRedisAvailable();

/** Upper bound for one generator step; well under the 15s keepalive. */
const STEP_MS = 2_000;

let main: RedisClientType | null = null;
const jobIds: string[] = [];
const controllers: AbortController[] = [];

function newJob(): { jobId: string; signal: AbortSignal } {
  const jobId = newJobId();
  jobIds.push(jobId);
  const controller = new AbortController();
  controllers.push(controller);
  return { jobId, signal: controller.signal };
}

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  const deadline = Promise.withResolvers<never>();
  const timer = setTimeout(
    () => deadline.reject(new Error(`timed out after ${STEP_MS}ms: ${label}`)),
    STEP_MS,
  );
  try {
    return await Promise.race([promise, deadline.promise]);
  } finally {
    clearTimeout(timer);
  }
}

async function nextEvent(
  gen: AsyncGenerator<BulkProgressEvent>,
  label: string,
): Promise<BulkProgressEvent> {
  const r = await within(gen.next(), label);
  expect(r.done, `${label}: generator ended early`).toBe(false);
  return r.value as BulkProgressEvent;
}

async function expectEnd(gen: AsyncGenerator<BulkProgressEvent>, label: string): Promise<void> {
  const r = await within(gen.next(), label);
  expect(r.done, `${label}: generator should have returned`).toBe(true);
}

describe.skipIf(!redisAvailable)('streamBulkProgress (real Redis) — replay/subscription gap', () => {
  beforeAll(async () => {
    main = createClient({ url: process.env.REDIS_URL }) as RedisClientType;
    await main.connect();
    setRedisClient(main);
  }, 15_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    // Abort any generator a failing test left suspended so its subscriber
    // connection is torn down, then drop this test's keys.
    for (const c of controllers.splice(0)) c.abort();
    if (main && jobIds.length > 0) {
      const keys = jobIds.splice(0).flatMap((id) => [
        `bulk-page-progress:list:${id}`,
        `bulk-page-progress:seq:${id}`,
        `bulk-page-progress:cancel:${id}`,
        `bulk-page-progress:meta:${id}`,
      ]);
      await main.del(keys);
    }
  });

  afterAll(async () => {
    setRedisClient(null);
    await main?.quit();
    main = null;
  });

  it('terminal event published between history read and subscribe still terminates the stream (issue repro)', async () => {
    const { jobId, signal } = newJob();
    await startBulkJob(jobId, 1, 'user-1', 'replace-tags');

    const gen = streamBulkProgress(jobId, signal);
    // Step 1: consume the initial (history) event. The generator is now
    // suspended inside the replay loop.
    const first = await nextEvent(gen, 'initial event');
    expect(first).toMatchObject({ completed: 0, done: false });

    // Step 2: the job finishes while the generator is suspended.
    await publishProgress(jobId, { completed: 1, done: true });
    const stored = await main!.lIndex(`bulk-page-progress:list:${jobId}`, 0);
    expect(JSON.parse(stored!)).toMatchObject({ completed: 1, done: true });

    // Step 3: the next read MUST surface the terminal event, then end.
    const terminal = await nextEvent(gen, 'terminal event after gap');
    expect(terminal).toMatchObject({ seq: 2, completed: 1, done: true });
    expect(first.seq).toBe(1);
    await expectEnd(gen, 'end after done');
  });

  it('cancellation published between history read and subscribe terminates the stream', async () => {
    const { jobId, signal } = newJob();
    await startBulkJob(jobId, 3, 'user-1', 'delete');

    const gen = streamBulkProgress(jobId, signal);
    await nextEvent(gen, 'initial event');

    await cancelBulkJob(jobId);

    const terminal = await nextEvent(gen, 'cancelled event after gap');
    expect(terminal).toMatchObject({ seq: 2, cancelled: true });
    await expectEnd(gen, 'end after cancel');
  });

  it('events published during history drain are delivered once, in order, ending on the terminal', async () => {
    const { jobId, signal } = newJob();
    await startBulkJob(jobId, 4, 'user-1', 'tag');
    await publishProgress(jobId, { completed: 1 });
    await publishProgress(jobId, { completed: 2 });
    // History is now seq 1..3.

    const gen = streamBulkProgress(jobId, signal);
    const first = await nextEvent(gen, 'history seq 1');
    expect(first.completed).toBe(0);

    // Suspended mid-drain: two more events arrive, the last one terminal.
    await publishProgress(jobId, { completed: 3 });
    await publishProgress(jobId, { completed: 4, done: true });

    const seen = [first];
    for (;;) {
      const r = await within(gen.next(), `event after seq ${seen[seen.length - 1]!.seq}`);
      if (r.done) break;
      seen.push(r.value);
      if (seen.length > 10) throw new Error('runaway stream');
    }

    expect(seen.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(seen.map((e) => e.completed)).toEqual([0, 1, 2, 3, 4]);
    expect(seen[seen.length - 1]!.done).toBe(true);
  });

  it('events that land in both history and the live feed are not duplicated or reordered', async () => {
    const { jobId, signal } = newJob();
    await startBulkJob(jobId, 2, 'user-1', 'sync');

    // Publish while the generator is inside its LRANGE: the two events are
    // delivered on the (already open) subscription AND returned by LRANGE.
    const realLRange = main!.lRange.bind(main!);
    const lRangeSpy = vi.spyOn(main!, 'lRange').mockImplementationOnce(async (key, start, stop) => {
      await publishProgress(jobId, { completed: 1 });
      await publishProgress(jobId, { completed: 2, done: true });
      return realLRange(key, start, stop);
    });

    const gen = streamBulkProgress(jobId, signal);
    const seen: BulkProgressEvent[] = [];
    for (;;) {
      const r = await within(gen.next(), `event #${seen.length + 1}`);
      if (r.done) break;
      seen.push(r.value);
      if (seen.length > 10) throw new Error('runaway stream');
    }

    expect(lRangeSpy).toHaveBeenCalledTimes(1);
    expect(seen.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(seen.map((e) => e.completed)).toEqual([0, 1, 2]);
    expect(seen[2]!.done).toBe(true);
  });

  it('live path: a consumer connected before any progress sees every event through done', async () => {
    const { jobId, signal } = newJob();
    await startBulkJob(jobId, 3, 'user-1', 'embed');

    const gen = streamBulkProgress(jobId, signal);
    const seen: BulkProgressEvent[] = [await nextEvent(gen, 'initial')];

    // Resuming the generator synchronously parks it on its idle wait (history
    // is already in memory); the live events below wake it via pub/sub.
    const waiting = gen.next();
    await publishProgress(jobId, { completed: 1 });
    await publishProgress(jobId, { completed: 2, failed: 1 });
    await publishProgress(jobId, { completed: 3, failed: 1, done: true });

    const r1 = await within(waiting, 'first live event');
    expect(r1.done).toBe(false);
    seen.push(r1.value as BulkProgressEvent);
    for (;;) {
      const r = await within(gen.next(), `event #${seen.length + 1}`);
      if (r.done) break;
      seen.push(r.value);
      if (seen.length > 10) throw new Error('runaway stream');
    }

    expect(seen.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(seen.map((e) => e.completed)).toEqual([0, 1, 2, 3]);
    expect(seen.map((e) => e.failed)).toEqual([0, 0, 1, 1]);
    expect(seen[3]!.done).toBe(true);
    // Stored and streamed payloads are the same bytes-level record.
    const stored = await main!.lRange(`bulk-page-progress:list:${jobId}`, 0, -1);
    expect(stored.reverse().map((s) => JSON.parse(s) as BulkProgressEvent)).toEqual(seen);
  });
});
