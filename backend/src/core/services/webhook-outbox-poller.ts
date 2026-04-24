/**
 * Webhook outbox poller (Compendiq/compendiq-ee#114, Phase C).
 *
 * Periodically scans `webhook_outbox` for rows in `status='pending'` with
 * `next_dispatch_at <= now()` and promotes them to BullMQ jobs on the
 * `webhook-delivery` queue. The delivery worker (Phase D, not in this
 * module) consumes that queue and performs the HTTP POST.
 *
 * ─── Cluster safety ──────────────────────────────────────────────────────
 *
 * Two correctness primitives combine so that N backend replicas can all
 * run this poller simultaneously without double-delivery:
 *
 *   1. `FOR UPDATE SKIP LOCKED` on the claiming `SELECT ... FOR UPDATE`.
 *      When two pods poll concurrently, each claims a disjoint subset of
 *      the pending rows — PostgreSQL's row-level locks make the partition
 *      deterministic and race-free. A row is NEVER visible to two pollers
 *      at the same moment.
 *
 *   2. The claim transaction transitions the row from `pending` to
 *      `dispatched` atomically with the BullMQ jobId stamp, so even after
 *      COMMIT a second pod sees the row as already dispatched and skips it
 *      via the `status='pending'` WHERE clause.
 *
 * A separate **stale-dispatch recovery sweep** (see `recoverStuckDispatches`)
 * runs once at poller init. It resets rows that have been stuck in
 * `dispatched` for longer than the configured threshold (default 5 min)
 * back to `pending` so they get re-delivered. This covers the case where
 * a previous pod crashed between claiming the row and the delivery worker
 * writing to `webhook_deliveries`.
 *
 * ─── Overlap prevention ─────────────────────────────────────────────────
 *
 * A module-scope `pollingInProgress` flag prevents an interval fire from
 * overlapping an in-progress poll on the SAME pod (inter-pod isolation is
 * handled by `SKIP LOCKED`). If the guard is already set when the timer
 * fires, the tick is skipped and logged at debug level.
 *
 * ─── Shutdown contract ──────────────────────────────────────────────────
 *
 * `initWebhookOutboxPoller` returns an async teardown. The teardown
 * clears the interval, waits for any in-flight poll cycle to complete,
 * and closes any queue handle this module owns. It does NOT call
 * `worker.close()` — the delivery worker is owned by Phase D.
 *
 * Not wired into `app.ts` in this PR; Phase F handles end-to-end
 * bootstrap registration.
 */

import { Queue, type ConnectionOptions } from 'bullmq';
import type { PoolClient } from 'pg';
import { getPool } from '../db/postgres.js';
import { logger } from '../utils/logger.js';

// ─── Tunables ────────────────────────────────────────────────────────────

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_STALE_DISPATCH_THRESHOLD_MS = 5 * 60 * 1_000; // 5 min

/** Queue name shared with the Phase D delivery worker. */
export const WEBHOOK_DELIVERY_QUEUE = 'webhook-delivery';

// ─── Redis connection (mirror queue-service.ts — one source of truth) ───

function getRedisConnectionOpts(): ConnectionOptions {
  const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return {
      host: 'localhost',
      port: 6379,
      maxRetriesPerRequest: null,
    };
  }
  return {
    host: parsed.hostname,
    port: parseInt(parsed.port || '6379', 10),
    password: parsed.password || undefined,
    maxRetriesPerRequest: null,
  };
}

// ─── Singleton queue handle ──────────────────────────────────────────────
//
// We own our own `Queue` instance rather than going through
// `queue-service.enqueueJob` because:
//   (a) `enqueueJob` forces `job.name === queueName`; the Standard Webhooks
//       semantic here is that the job's name is the action ('deliver'),
//       not the queue name. Phase D's worker filters on `job.name` so
//       this matters for correctness.
//   (b) `enqueueJob`'s "remove stale terminal jobs with same jobId"
//       behaviour is inappropriate here — the jobId is a freshly-minted
//       UUID on every claim, so there will never be a collision and the
//       extra `getJob` round-trip is waste.
//
// The Queue is cached lazily on first `initWebhookOutboxPoller` call and
// reused across re-inits. Exposed via `getWebhookDeliveryQueue()` so the
// Phase D worker can share the same instance.

let deliveryQueue: Queue | null = null;

/**
 * Shared BullMQ queue handle for webhook deliveries. Phase D's delivery
 * worker uses this too; both call sites must agree on the name and
 * connection options or jobs land in the wrong queue.
 *
 * Lazy-instantiated. Safe to call before `initWebhookOutboxPoller`.
 */
export function getWebhookDeliveryQueue(): Queue {
  if (!deliveryQueue) {
    deliveryQueue = new Queue(WEBHOOK_DELIVERY_QUEUE, {
      connection: getRedisConnectionOpts(),
    });
  }
  return deliveryQueue;
}

// ─── Options & teardown types ────────────────────────────────────────────

export interface OutboxPollerOptions {
  /** ms between polls. Defaults to 5000. */
  pollIntervalMs?: number;
  /** Max rows claimed per cycle. Defaults to 50. */
  batchSize?: number;
  /** ms before a stuck `dispatched` row is reset to `pending`. Defaults to 300_000 (5 min). */
  staleDispatchThresholdMs?: number;
}

// ─── Module state ────────────────────────────────────────────────────────

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let pollingInProgress = false;
let activePollPromise: Promise<number> | null = null;
let runtimeBatchSize = DEFAULT_BATCH_SIZE;
let cachedTeardown: (() => Promise<void>) | null = null;

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * Start the poller. Called from `app.ts` during bootstrap AFTER
 * `initCacheBus` and once the BullMQ queue service is up.
 *
 * Idempotent: a second call while a poller is already running returns
 * the same teardown without re-scheduling.
 *
 * Runs the stale-dispatch recovery sweep once BEFORE the first poll
 * cycle fires, so any rows stranded by a prior pod's crash are
 * re-delivered without waiting for an operator.
 */
export async function initWebhookOutboxPoller(
  opts: OutboxPollerOptions = {},
): Promise<() => Promise<void>> {
  if (cachedTeardown) {
    logger.debug('webhook-outbox-poller already initialised — returning existing teardown');
    return cachedTeardown;
  }

  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const staleThresholdMs =
    opts.staleDispatchThresholdMs ?? DEFAULT_STALE_DISPATCH_THRESHOLD_MS;

  runtimeBatchSize = batchSize;

  // Ensure queue is eagerly constructed so the first cycle doesn't pay
  // the ioredis-connect cost under the `pollingInProgress` guard.
  getWebhookDeliveryQueue();

  // Recovery sweep runs ONCE at init. If it fails we log and continue —
  // the stale rows will just wait for the next pod restart or a manual
  // operator-run `recoverStuckDispatches(...)`.
  try {
    const recovered = await recoverStuckDispatches(staleThresholdMs);
    if (recovered > 0) {
      logger.info({ recovered }, 'webhook-outbox-poller: reset stuck dispatched rows to pending');
    }
  } catch (err) {
    logger.error({ err }, 'webhook-outbox-poller: stale-dispatch recovery failed');
  }

  logger.info(
    { pollIntervalMs, batchSize, staleThresholdMs },
    'webhook-outbox-poller: starting',
  );

  intervalHandle = setInterval(() => {
    if (pollingInProgress) {
      logger.debug('webhook-outbox-poller: previous cycle still running — skipping tick');
      return;
    }
    // Fire-and-forget — any rejection is caught inside pollOnceInternal.
    // We intentionally do NOT await here: setInterval callbacks cannot be
    // async without creating unhandled rejections on their own.
    void runGuardedPoll(batchSize);
  }, pollIntervalMs);

  // Node intervals keep the event loop alive; production boot does
  // want that, tests may want to override via .unref() externally.

  cachedTeardown = async () => {
    if (intervalHandle) {
      clearInterval(intervalHandle);
      intervalHandle = null;
    }
    // Wait for any cycle that is mid-flight so we don't leave a query
    // stranded in the pool.
    if (activePollPromise) {
      try {
        await activePollPromise;
      } catch {
        /* already logged inside pollOnceInternal */
      }
    }
    // Close our queue handle. BullMQ's close() does not accept new jobs
    // and flushes outstanding state — safe to call even if another
    // module has its own Queue instance pointing at the same Redis key
    // space.
    if (deliveryQueue) {
      await deliveryQueue.close().catch((err) => {
        logger.error({ err }, 'webhook-outbox-poller: error closing delivery queue');
      });
      deliveryQueue = null;
    }
    cachedTeardown = null;
    logger.info('webhook-outbox-poller: stopped');
  };

  return cachedTeardown;
}

/**
 * Run the stale-dispatch recovery sweep once. Rows stuck in
 * `status='dispatched'` with `dispatched_at` older than `thresholdMs`
 * are reset back to `pending` so the next poll cycle re-dispatches them.
 *
 * Returns the number of rows recovered.
 *
 * Exposed both for the boot sequence (called by `initWebhookOutboxPoller`
 * once before the first tick) and for tests.
 */
export async function recoverStuckDispatches(
  thresholdMs: number = DEFAULT_STALE_DISPATCH_THRESHOLD_MS,
): Promise<number> {
  // Use milliseconds via `interval` cast so we don't lose precision for
  // sub-minute thresholds (common in tests). Using a parameter-bound
  // number for interval math requires the `NUMERIC * INTERVAL '1 ms'`
  // pattern; we convert to seconds to keep the query plain SQL.
  const seconds = Math.max(1, Math.floor(thresholdMs / 1_000));
  const result = await getPool().query<{ id: string }>(
    `UPDATE webhook_outbox
        SET status = 'pending',
            dispatched_at = NULL,
            bullmq_job_id = NULL
      WHERE status = 'dispatched'
        AND dispatched_at IS NOT NULL
        AND dispatched_at < (NOW() - ($1::text || ' seconds')::interval)
      RETURNING id`,
    [String(seconds)],
  );
  return result.rowCount ?? 0;
}

/**
 * Test-only export: run one poll cycle synchronously and return the
 * number of rows claimed + enqueued.
 *
 * Named with `__` prefix so IDE import completion lists it last and no
 * production caller grabs it by accident.
 */
export async function __pollOnce(batchSize?: number): Promise<number> {
  return runGuardedPoll(batchSize ?? runtimeBatchSize);
}

// ─── Internals ───────────────────────────────────────────────────────────

/**
 * Wraps `pollOnceInternal` with the overlap guard and the module-scope
 * `activePollPromise` pointer so `initWebhookOutboxPoller`'s teardown
 * can await a mid-flight cycle.
 */
async function runGuardedPoll(batchSize: number): Promise<number> {
  if (pollingInProgress) {
    logger.debug('webhook-outbox-poller: guard rejected overlapping __pollOnce');
    return 0;
  }
  pollingInProgress = true;
  const p = pollOnceInternal(batchSize).finally(() => {
    pollingInProgress = false;
    activePollPromise = null;
  });
  activePollPromise = p;
  return p;
}

/**
 * One poll cycle. Claims up to `batchSize` pending rows inside a single
 * transaction with `FOR UPDATE SKIP LOCKED`, flips them to `dispatched`
 * with a fresh BullMQ jobId, then enqueues one delivery job per row.
 *
 * Enqueue failures post-commit are logged but DO NOT roll the row back
 * to `pending`. Instead the stale-dispatch recovery sweep will eventually
 * reset it. This is deliberate: after COMMIT the row is the delivery
 * worker's responsibility, and bundling BullMQ writes into the DB
 * transaction would mean a half-committed state if Redis flaked.
 */
async function pollOnceInternal(batchSize: number): Promise<number> {
  const pool = getPool();
  const client: PoolClient = await pool.connect();

  type ClaimedRow = {
    id: string;
    subscription_id: string;
    webhook_id: string;
    event_type: string;
    payload: unknown;
    bullmq_job_id: string;
  };

  let rows: ClaimedRow[] = [];

  try {
    await client.query('BEGIN');

    // Two-step claim: first SELECT ... FOR UPDATE SKIP LOCKED to pin the
    // candidate ids under lock, then UPDATE RETURNING.
    //
    // We can't fuse the two into a single `UPDATE ... WHERE id IN (SELECT
    // ... FOR UPDATE SKIP LOCKED ...)` because PostgreSQL applies the
    // outer statement's row lock before it evaluates the sub-query, so the
    // SKIP LOCKED hint is ignored and concurrent pollers serialise on the
    // same rows. The IN-subquery form is the canonical SKIP LOCKED recipe
    // and what the plan's §1.3 mockup shows.

    const claimSql = `
      WITH candidates AS (
        SELECT id
          FROM webhook_outbox
         WHERE status = 'pending'
           AND next_dispatch_at <= NOW()
         ORDER BY created_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED
      )
      UPDATE webhook_outbox o
         SET status = 'dispatched',
             dispatched_at = NOW(),
             bullmq_job_id = gen_random_uuid()::text
        FROM candidates c
       WHERE o.id = c.id
      RETURNING o.id,
                o.subscription_id,
                o.webhook_id,
                o.event_type,
                o.payload,
                o.bullmq_job_id
    `;

    const result = await client.query<ClaimedRow>(claimSql, [batchSize]);
    rows = result.rows;

    await client.query('COMMIT');
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* connection may already be torn; next release() handles it */
    }
    logger.error({ err }, 'webhook-outbox-poller: claim transaction failed');
    return 0;
  } finally {
    client.release();
  }

  if (rows.length === 0) return 0;

  // Enqueue phase — post-commit. Per row, a failure here leaves the row
  // in `dispatched` with a jobId that will never be picked up. The stale
  // sweep recovers them on the next pod restart or next manual call.
  const queue = getWebhookDeliveryQueue();
  let enqueued = 0;
  for (const row of rows) {
    try {
      await queue.add(
        'deliver',
        {
          outboxId: row.id,
          subscriptionId: row.subscription_id,
          webhookId: row.webhook_id,
          eventType: row.event_type,
          payload: row.payload,
        },
        { jobId: row.bullmq_job_id },
      );
      enqueued++;
    } catch (err) {
      logger.error(
        { err, outboxId: row.id, jobId: row.bullmq_job_id },
        'webhook-outbox-poller: failed to enqueue BullMQ delivery job — row will be recovered by stale-dispatch sweep',
      );
    }
  }

  logger.debug(
    { claimed: rows.length, enqueued },
    'webhook-outbox-poller: cycle complete',
  );
  return enqueued;
}

// ─── Test seam ──────────────────────────────────────────────────────────

/**
 * Test-only: clear module state so a fresh test can start from a known
 * baseline. Not exported through any production index.
 */
export function __resetWebhookOutboxPollerForTests(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  pollingInProgress = false;
  activePollPromise = null;
  cachedTeardown = null;
  runtimeBatchSize = DEFAULT_BATCH_SIZE;
  // Do NOT null out deliveryQueue — tests that still hold a reference
  // would otherwise talk to a closed queue. The teardown path owns
  // closing + nulling it.
}

/**
 * Test-only: signal that a fresh queue instance is needed. Closes the
 * current cached queue (if any). Intended for integration tests that
 * want to `obliterate()` leftover jobs between cases.
 */
export async function __closeWebhookDeliveryQueueForTests(): Promise<void> {
  if (deliveryQueue) {
    await deliveryQueue.close().catch(() => {
      /* test cleanup — swallow */
    });
    deliveryQueue = null;
  }
}

