import type { PoolClient } from 'pg';
import { PageLifecycleEventSchema, type PageLifecycleEvent } from '@compendiq/contracts';
import { getRedisClient, invalidateCacheNamespaces } from './redis-cache.js';
import { prefixedRedisChannel } from '../utils/prefixed-redis-channel.js';
import { logger } from '../utils/logger.js';
import { flushPageWriteInvalidations, withPagePublicationTransaction } from './page-write-invalidation.js';
import { resolveShutdownTimeoutMs } from '../utils/graceful-shutdown.js';

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_BATCH_SIZE = 25;
const CLAIM_STALE_SECONDS = 300;
const DELIVERY_TIMEOUT_MS = resolveShutdownTimeoutMs();
const MAX_LAST_ERROR_CHARS = 1_000;

export type PageLifecycleWebhookDelivery = (
  event: PageLifecycleEvent,
  deliveryId: string,
  signal: AbortSignal,
) => Promise<void>;

let webhookDelivery: PageLifecycleWebhookDelivery | null = null;

/** EE may register a durable webhook adapter. CE has no webhook subscribers. */
export function setPageLifecycleWebhookDelivery(
  delivery: PageLifecycleWebhookDelivery | null,
): void {
  webhookDelivery = delivery;
}

export async function enqueuePageLifecycleEvent(
  client: PoolClient,
  event: PageLifecycleEvent,
): Promise<string> {
  const parsed = PageLifecycleEventSchema.parse(event);
  const result = await client.query<{ id: string }>(
    `INSERT INTO page_lifecycle_outbox (page_id, lifecycle_revision, event)
     VALUES ($1, $2::bigint, $3::jsonb)
     ON CONFLICT (page_id, lifecycle_revision)
     DO UPDATE SET event = page_lifecycle_outbox.event
     RETURNING id`,
    [parsed.pageId, parsed.lifecycleRevision, JSON.stringify(parsed)],
  );
  return result.rows[0]!.id;
}

interface OutboxRow {
  id: string;
  event: unknown;
  attempt_count: number;
}

let timer: ReturnType<typeof setInterval> | null = null;
let activePoll: Promise<number> | null = null;
let activePollController: AbortController | null = null;
let teardown: (() => Promise<void>) | null = null;
let runtimeBatchSize = DEFAULT_BATCH_SIZE;
let stopping = false;

export async function initPageBaselineOutbox(options: {
  pollIntervalMs?: number;
  batchSize?: number;
} = {}): Promise<() => Promise<void>> {
  if (teardown) return teardown;

  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  runtimeBatchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  stopping = false;
  timer = setInterval(() => {
    void kickPageLifecycleOutbox();
  }, pollIntervalMs);

  teardown = async () => {
    stopping = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    activePollController?.abort(new Error('Page lifecycle outbox is shutting down'));
    if (activePoll) {
      await activePoll.catch(() => undefined);
    }
    activePoll = null;
    activePollController = null;
    teardown = null;
  };

  // Recover committed events promptly after restart. Errors are logged by the
  // guarded poll and never make application startup fail.
  void kickPageLifecycleOutbox();
  return teardown;
}

/**
 * Prompt the worker after a successful commit. It never rejects to its caller:
 * a delivery failure must not turn a committed freeze/thaw into an HTTP error.
 */
export async function kickPageLifecycleOutbox(): Promise<void> {
  if (activePoll || stopping) return;
  const controller = new AbortController();
  activePollController = controller;
  const run = pollPageLifecycleOutbox(runtimeBatchSize, controller.signal);
  activePoll = run;
  try {
    await run;
  } catch (err) {
    if (!controller.signal.aborted) {
      logger.error({ err }, 'page lifecycle outbox poll failed');
    }
  } finally {
    if (activePoll === run) activePoll = null;
    if (activePollController === controller) activePollController = null;
  }
}

export async function pollPageLifecycleOutbox(
  batchSize = DEFAULT_BATCH_SIZE,
  signal?: AbortSignal,
): Promise<number> {
  const deliverySignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(DELIVERY_TIMEOUT_MS)])
    : AbortSignal.timeout(DELIVERY_TIMEOUT_MS);
  const rows = await withPagePublicationTransaction(async (client) => {
    const claimed = await client.query<OutboxRow>(
      `WITH candidates AS (
         SELECT id
           FROM page_lifecycle_outbox
          WHERE delivered_at IS NULL
            AND next_attempt_at <= NOW()
            AND (claimed_at IS NULL OR claimed_at < NOW() - ($2::text || ' seconds')::interval)
          ORDER BY created_at, id
          FOR UPDATE SKIP LOCKED
          LIMIT $1
       )
       UPDATE page_lifecycle_outbox o
          SET claimed_at = NOW(), attempt_count = o.attempt_count + 1
         FROM candidates c
        WHERE o.id = c.id
       RETURNING o.id, o.event, o.attempt_count`,
      [Math.max(1, Math.min(batchSize, 100)), String(CLAIM_STALE_SECONDS)],
    );
    return claimed.rows;
  }, deliverySignal);
  deliverySignal.throwIfAborted();
  await Promise.all(rows.map(async (row) => deliverRow(row, deliverySignal)));
  deliverySignal.throwIfAborted();
  // Body-write invalidations have their own durable intent identity; they
  // share this worker lifecycle without pretending to be lifecycle events.
  await flushPageWriteInvalidations(undefined, deliverySignal);
  return rows.length;
}

async function deliverRow(row: OutboxRow, signal: AbortSignal): Promise<void> {
  try {
    signal.throwIfAborted();
    const event = PageLifecycleEventSchema.parse(row.event);
    await deliverCacheAndEvent(event, signal);
    if (webhookDelivery) {
      signal.throwIfAborted();
      await waitForDelivery(webhookDelivery(event, row.id, signal), signal);
    }
    signal.throwIfAborted();
    await withPagePublicationTransaction(
      (client) => client.query(
        `UPDATE page_lifecycle_outbox
            SET delivered_at = NOW(), claimed_at = NULL, last_error = NULL
          WHERE id = $1 AND delivered_at IS NULL`,
        [row.id],
      ),
      signal,
    );
  } catch (err) {
    // Teardown/timeout deliberately leaves the claim and row durable. The
    // stale-claim predicate makes it retryable without a late status write
    // racing pool shutdown.
    if (signal.aborted) return;
    const message = err instanceof Error ? err.message : String(err);
    const delaySeconds = Math.min(3_600, 5 * (2 ** Math.min(row.attempt_count - 1, 9)));
    await withPagePublicationTransaction(
      (client) => client.query(
        `UPDATE page_lifecycle_outbox
            SET claimed_at = NULL,
                last_error = $2,
                next_attempt_at = NOW() + ($3::text || ' seconds')::interval
          WHERE id = $1 AND delivered_at IS NULL`,
        [row.id, message.slice(0, MAX_LAST_ERROR_CHARS), String(delaySeconds)],
      ),
      signal,
    );
    logger.warn({ err, outboxId: row.id, attempt: row.attempt_count }, 'page lifecycle delivery deferred');
  }
}

async function deliverCacheAndEvent(
  event: PageLifecycleEvent,
  signal: AbortSignal,
): Promise<void> {
  const redis = getRedisClient();
  if (!redis) throw new Error('Redis unavailable for page lifecycle delivery');

  await invalidateCacheNamespaces(redis, ['pages', 'search'], signal);
  await redis.withAbortSignal(signal).publish(
    prefixedRedisChannel('page:lifecycle'),
    JSON.stringify(event),
  );
}

function waitForDelivery<T>(delivery: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void delivery.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

export function _resetPageBaselineOutboxForTests(): void {
  webhookDelivery = null;
}
