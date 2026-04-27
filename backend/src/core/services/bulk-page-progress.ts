/**
 * Redis-backed progress + cancel state for long-running bulk page operations
 * (Compendiq/compendiq-ee#117).
 *
 * Two routes share state via this module:
 *   - POST /api/pages/bulk/<action>?jobId=...   runs the operation in chunks,
 *     publishes progress after each chunk, checks the cancel flag between
 *     chunks.
 *   - GET  /api/pages/bulk/:jobId/progress      SSE stream that consumes the
 *     same state and sets the cancel flag when the client disconnects.
 *
 * Why Redis: bulk operations span seconds to minutes. The POST and SSE
 * connections are two independent HTTP requests possibly hitting different
 * Node processes behind a load balancer. Redis is the only state store
 * that's already shared across the cluster.
 *
 * When Redis is unavailable (test mode, Redis outage) the module degrades to
 * an in-process Map. Single-process correctness is preserved; multi-process
 * progress observation is not.
 */
import type { RedisClientType } from 'redis';
import { randomUUID } from 'node:crypto';
import { getRedisClient } from './redis-cache.js';
import { logger } from '../utils/logger.js';

/**
 * TTL on every progress key. Long enough for the longest realistic bulk op
 * to complete and the SSE client to consume the final `done` event;
 * short enough that abandoned jobs are reaped automatically.
 */
const PROGRESS_TTL_SEC = 60 * 30; // 30 minutes

/**
 * Channel prefix for pub/sub-style progress events. We push to a Redis list
 * (LPUSH + LTRIM bounded) AND publish a notification so the SSE generator
 * can wake without polling. The list is the durable record (so a slow SSE
 * subscriber catches up); the pub/sub is the kick.
 */
const PROGRESS_CHANNEL_PREFIX = 'bulk-page-progress:channel:';
const PROGRESS_LIST_PREFIX = 'bulk-page-progress:list:';
const PROGRESS_CANCEL_PREFIX = 'bulk-page-progress:cancel:';
const PROGRESS_META_PREFIX = 'bulk-page-progress:meta:';
const PROGRESS_LIST_MAX = 1000;

export interface BulkProgressEvent {
  jobId: string;
  total: number;
  completed: number;
  failed: number;
  done: boolean;
  cancelled: boolean;
  /** Optional human-readable note (e.g. last error). */
  note?: string;
}

interface InMemoryJob {
  meta: { total: number; userId: string; action: string };
  events: BulkProgressEvent[];
  cancelled: boolean;
  done: boolean;
  /** Resolvers waiting on the next event — wakes the in-memory async generator. */
  waiters: Array<() => void>;
}

const memoryJobs = new Map<string, InMemoryJob>();

function channelKey(jobId: string): string {
  return `${PROGRESS_CHANNEL_PREFIX}${jobId}`;
}
function listKey(jobId: string): string {
  return `${PROGRESS_LIST_PREFIX}${jobId}`;
}
function cancelKey(jobId: string): string {
  return `${PROGRESS_CANCEL_PREFIX}${jobId}`;
}
function metaKey(jobId: string): string {
  return `${PROGRESS_META_PREFIX}${jobId}`;
}

/** Generate a fresh job id. Callers MAY supply their own (e.g. correlation id). */
export function newJobId(): string {
  return randomUUID();
}

/**
 * Initialize progress state for a new bulk job. Idempotent: re-initialisation
 * with the same jobId is a no-op (the SSE client may have created the meta
 * record by hitting the GET route slightly before the POST starts).
 */
export async function startBulkJob(
  jobId: string,
  total: number,
  userId: string,
  action: string,
): Promise<void> {
  const redis = getRedisClient();
  const meta = JSON.stringify({ total, userId, action, startedAt: Date.now() });

  if (redis) {
    try {
      await redis.set(metaKey(jobId), meta, { NX: true, EX: PROGRESS_TTL_SEC });
      // Pre-warm the cancel key so EXISTS-style checks always have a definitive
      // answer; "0" means "not cancelled". TTL keeps it from leaking.
      await redis.set(cancelKey(jobId), '0', { NX: true, EX: PROGRESS_TTL_SEC });
      await pushEvent(redis, jobId, {
        jobId, total, completed: 0, failed: 0, done: false, cancelled: false,
      });
      return;
    } catch (err) {
      logger.warn({ err, jobId }, 'bulk-progress: redis init failed, falling back to memory');
    }
  }

  if (!memoryJobs.has(jobId)) {
    memoryJobs.set(jobId, {
      meta: { total, userId, action },
      events: [{ jobId, total, completed: 0, failed: 0, done: false, cancelled: false }],
      cancelled: false,
      done: false,
      waiters: [],
    });
  }
}

/**
 * Publish a progress tick. Called by the chunked runner after each chunk.
 * Safe to call from many concurrent runners as long as each owns its own
 * jobId.
 */
export async function publishProgress(
  jobId: string,
  partial: Partial<Omit<BulkProgressEvent, 'jobId'>>,
): Promise<void> {
  const redis = getRedisClient();

  if (redis) {
    try {
      const last = await getLatestEvent(redis, jobId);
      const next: BulkProgressEvent = {
        jobId,
        total: partial.total ?? last?.total ?? 0,
        completed: partial.completed ?? last?.completed ?? 0,
        failed: partial.failed ?? last?.failed ?? 0,
        done: partial.done ?? last?.done ?? false,
        cancelled: partial.cancelled ?? last?.cancelled ?? false,
        note: partial.note ?? last?.note,
      };
      await pushEvent(redis, jobId, next);
      return;
    } catch (err) {
      logger.warn({ err, jobId }, 'bulk-progress: redis publish failed, falling back to memory');
    }
  }

  const job = memoryJobs.get(jobId);
  if (!job) return;
  const last = job.events[job.events.length - 1];
  const next: BulkProgressEvent = {
    jobId,
    total: partial.total ?? last?.total ?? 0,
    completed: partial.completed ?? last?.completed ?? 0,
    failed: partial.failed ?? last?.failed ?? 0,
    done: partial.done ?? last?.done ?? false,
    cancelled: partial.cancelled ?? last?.cancelled ?? false,
    note: partial.note ?? last?.note,
  };
  job.events.push(next);
  if (next.done) job.done = true;
  if (next.cancelled) job.cancelled = true;
  for (const w of job.waiters.splice(0)) w();
}

/**
 * Mark the job as cancelled. Called by the SSE route when the client
 * disconnects. The chunked runner checks `isCancelled()` between chunks;
 * a true result causes the loop to bail with the partial-success counts
 * gathered so far.
 *
 * Idempotent: calling on an already-cancelled or already-done job is a no-op
 * for the runner but still publishes a final event so the SSE generator
 * exits cleanly.
 */
export async function cancelBulkJob(jobId: string): Promise<void> {
  const redis = getRedisClient();

  if (redis) {
    try {
      await redis.set(cancelKey(jobId), '1', { EX: PROGRESS_TTL_SEC });
      const last = await getLatestEvent(redis, jobId);
      await pushEvent(redis, jobId, {
        jobId,
        total: last?.total ?? 0,
        completed: last?.completed ?? 0,
        failed: last?.failed ?? 0,
        done: last?.done ?? false,
        cancelled: true,
        note: last?.note,
      });
      return;
    } catch (err) {
      logger.warn({ err, jobId }, 'bulk-progress: redis cancel failed');
    }
  }

  const job = memoryJobs.get(jobId);
  if (!job) return;
  job.cancelled = true;
  const last = job.events[job.events.length - 1];
  job.events.push({
    jobId,
    total: last?.total ?? 0,
    completed: last?.completed ?? 0,
    failed: last?.failed ?? 0,
    done: last?.done ?? false,
    cancelled: true,
    note: last?.note,
  });
  for (const w of job.waiters.splice(0)) w();
}

/**
 * Probe the cancel flag. Cheap — single GET. The chunked runner calls this
 * between every chunk so cancel-latency is bounded by chunk-size, not row
 * count.
 */
export async function isBulkJobCancelled(jobId: string): Promise<boolean> {
  const redis = getRedisClient();
  if (redis) {
    try {
      const v = await redis.get(cancelKey(jobId));
      return v === '1';
    } catch (err) {
      logger.debug({ err, jobId }, 'bulk-progress: redis cancel-probe failed, defaulting to false');
      return memoryJobs.get(jobId)?.cancelled ?? false;
    }
  }
  return memoryJobs.get(jobId)?.cancelled ?? false;
}

/**
 * Async generator backing the SSE route. Yields every published event for
 * the job, then yields once more on `done` or `cancelled` and returns.
 *
 * `signal` is the SSE route's AbortController — when the client disconnects,
 * the route aborts and the generator exits early without setting the cancel
 * flag. The route is responsible for separately calling `cancelBulkJob`.
 *
 * Includes a 15s keepalive heartbeat: when no event arrives within the
 * window, the generator yields a synthetic event with the last known counts
 * and `note: 'keepalive'`. Reverse proxies that buffer SSE will see the
 * write and not idle-disconnect.
 */
export async function* streamBulkProgress(
  jobId: string,
  signal: AbortSignal,
): AsyncGenerator<BulkProgressEvent> {
  const redis = getRedisClient();
  const KEEPALIVE_MS = 15_000;

  if (redis) {
    // Replay any historical events first — the SSE client may connect after
    // the POST has already completed several chunks.
    const history = await readEventList(redis, jobId);
    for (const ev of history) {
      yield ev;
      if (ev.done || ev.cancelled) return;
    }

    // Subscribe and stream. We use a duplicate connection because pub/sub
    // mode disables normal commands on a redis-client v4+ instance.
    const sub = redis.duplicate();
    await sub.connect();

    let lastEvent: BulkProgressEvent | null = history[history.length - 1] ?? null;
    let pending: BulkProgressEvent | null = null;
    let resolveWaiter: (() => void) | null = null;
    let aborted = false;

    const wake = (): void => {
      const r = resolveWaiter;
      resolveWaiter = null;
      r?.();
    };

    const onMessage = (msg: string): void => {
      try {
        pending = JSON.parse(msg) as BulkProgressEvent;
      } catch {
        // Drop malformed events.
        return;
      }
      wake();
    };

    await sub.subscribe(channelKey(jobId), onMessage);

    const onAbort = (): void => {
      aborted = true;
      wake();
    };
    signal.addEventListener('abort', onAbort, { once: true });

    try {
      while (!aborted) {
        if (pending !== null) {
          const ev: BulkProgressEvent = pending;
          pending = null;
          lastEvent = ev;
          yield ev;
          if (ev.done || ev.cancelled) return;
          continue;
        }

        // Wait for the next event OR the keepalive deadline OR abort.
        await new Promise<void>((resolve) => {
          resolveWaiter = resolve;
          const t = setTimeout(() => {
            resolveWaiter = null;
            resolve();
          }, KEEPALIVE_MS);
          // If signalled while we set up, resolve immediately.
          if (aborted) {
            clearTimeout(t);
            resolve();
          }
        });

        if (aborted) break;
        if (pending) continue;

        // Keepalive tick — yield the last known event with a marker note.
        if (lastEvent) {
          yield { ...lastEvent, note: 'keepalive' };
        }
      }
    } finally {
      signal.removeEventListener('abort', onAbort);
      try {
        await sub.unsubscribe(channelKey(jobId));
        await sub.quit();
      } catch (err) {
        logger.debug({ err, jobId }, 'bulk-progress: subscriber teardown failed');
      }
    }
    return;
  }

  // In-memory mode (tests, redis outage)
  const job = memoryJobs.get(jobId);
  if (!job) return;

  let i = 0;
  let aborted = false;
  const onAbort = (): void => {
    aborted = true;
    for (const w of job.waiters.splice(0)) w();
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    while (!aborted) {
      while (i < job.events.length) {
        const ev = job.events[i++]!;
        yield ev;
        if (ev.done || ev.cancelled) return;
      }
      if (aborted) break;

      // Wait for the next event or keepalive timeout.
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, KEEPALIVE_MS);
        job.waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });

      if (aborted) break;
      if (i >= job.events.length && job.events.length > 0) {
        yield { ...job.events[job.events.length - 1]!, note: 'keepalive' };
      }
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

// ── internal redis helpers ────────────────────────────────────────────────

async function pushEvent(
  redis: RedisClientType,
  jobId: string,
  ev: BulkProgressEvent,
): Promise<void> {
  const payload = JSON.stringify(ev);
  // LPUSH + LTRIM bounds the durable list; PUBLISH wakes subscribers. Both
  // commands tolerate failure independently.
  await Promise.all([
    redis.lPush(listKey(jobId), payload).then(() => redis.lTrim(listKey(jobId), 0, PROGRESS_LIST_MAX - 1)),
    redis.expire(listKey(jobId), PROGRESS_TTL_SEC),
    redis.publish(channelKey(jobId), payload),
  ]).catch((err) => {
    logger.debug({ err, jobId }, 'bulk-progress: pushEvent partial failure');
  });
}

async function readEventList(
  redis: RedisClientType,
  jobId: string,
): Promise<BulkProgressEvent[]> {
  try {
    const raw = await redis.lRange(listKey(jobId), 0, -1);
    // List is LPUSH'd, so reverse for chronological order.
    return raw
      .slice()
      .reverse()
      .map((s) => {
        try {
          return JSON.parse(s) as BulkProgressEvent;
        } catch {
          return null;
        }
      })
      .filter((e): e is BulkProgressEvent => e !== null);
  } catch {
    return [];
  }
}

async function getLatestEvent(
  redis: RedisClientType,
  jobId: string,
): Promise<BulkProgressEvent | null> {
  try {
    const raw = await redis.lIndex(listKey(jobId), 0);
    if (!raw) return null;
    return JSON.parse(raw) as BulkProgressEvent;
  } catch {
    return null;
  }
}

/**
 * Chunked runner used by every bulk route. Splits `items` into chunks of
 * `chunkSize`, runs `worker` on each, publishes a progress tick between
 * chunks, and aborts as soon as `isBulkJobCancelled` returns true.
 *
 * The worker is responsible for its own concurrency inside the chunk
 * (existing routes use `pLimit(5)` against external services). Returns
 * aggregate counts plus the cancelled flag so the route can decide what to
 * report in the response body.
 *
 * `jobId` may be `null` — in that case we still chunk for memory pressure
 * but skip the publish/cancel checks. This keeps the runner usable for
 * callers that don't need progress streaming (e.g. legacy clients calling
 * the existing bulk routes without a jobId).
 */
export async function runBulkInChunks<T>(
  items: T[],
  chunkSize: number,
  jobId: string | null,
  worker: (chunk: T[]) => Promise<{ succeeded: number; failed: number; errors: string[] }>,
): Promise<{ succeeded: number; failed: number; errors: string[]; cancelled: boolean }> {
  let succeeded = 0;
  let failed = 0;
  const errors: string[] = [];
  let cancelled = false;

  for (let i = 0; i < items.length; i += chunkSize) {
    if (jobId && (await isBulkJobCancelled(jobId))) {
      cancelled = true;
      break;
    }
    const chunk = items.slice(i, i + chunkSize);
    const result = await worker(chunk);
    succeeded += result.succeeded;
    failed += result.failed;
    if (result.errors.length > 0) errors.push(...result.errors);

    if (jobId) {
      await publishProgress(jobId, { completed: succeeded + failed, failed });
    }
  }

  if (jobId) {
    await publishProgress(jobId, {
      completed: succeeded + failed,
      failed,
      done: !cancelled,
      cancelled,
    });
  }

  return { succeeded, failed, errors, cancelled };
}

// Test-only: clear in-memory job state.
export function _resetMemoryJobsForTests(): void {
  memoryJobs.clear();
}
