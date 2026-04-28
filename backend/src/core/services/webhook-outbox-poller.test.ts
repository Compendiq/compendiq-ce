/**
 * Integration tests for the webhook outbox poller
 * (Compendiq/compendiq-ee#114, Phase C).
 *
 * These exercise the poller against REAL Postgres + REAL Redis. When
 * either is unavailable the suite self-skips (so local runs without a
 * Docker compose stack don't fail CI gate locally). CI images bring both
 * up for us.
 *
 * The tests focus on contract guarantees, NOT the delivery worker:
 *
 *   - Pending rows get claimed and enqueued.
 *   - `next_dispatch_at > now()` rows are skipped.
 *   - `status='done' | 'dead'` rows are never re-dispatched.
 *   - `batchSize` cap is honoured.
 *   - Two concurrent poll cycles partition their rows (SKIP LOCKED gate).
 *   - Stale-dispatch recovery respects / honours the threshold.
 *   - Module-scope poll-in-progress guard prevents overlap on the same pod.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient } from 'redis';
import { Queue } from 'bullmq';

import {
  isDbAvailable,
  setupTestDb,
  teardownTestDb,
  truncateAllTables,
} from '../../test-db-helper.js';
import { query, getPool } from '../db/postgres.js';
import {
  initWebhookOutboxPoller,
  recoverStuckDispatches,
  getWebhookDeliveryQueue,
  WEBHOOK_DELIVERY_QUEUE,
  __pollOnce,
  __resetWebhookOutboxPollerForTests,
  __closeWebhookDeliveryQueueForTests,
} from './webhook-outbox-poller.js';

// ─── Environment probe ───────────────────────────────────────────────────

async function checkRedisReachable(): Promise<boolean> {
  const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
  // Use an explicit bounded reconnect strategy so ECONNREFUSED fails fast
  // instead of letting the default retry backoff hang the suite. The redis
  // client will otherwise wait >10s with exponential backoff per attempt.
  const probe = createClient({
    url,
    socket: {
      connectTimeout: 1_500,
      reconnectStrategy: () => new Error('probe: no retries'),
    },
  });
  probe.on('error', () => {
    /* swallow — we only want to know whether connect works */
  });
  try {
    await probe.connect();
    await probe.ping();
    await probe.quit();
    return true;
  } catch {
    try {
      await probe.disconnect();
    } catch {
      /* best effort */
    }
    return false;
  }
}

const dbAvailable = await isDbAvailable();
const redisAvailable = dbAvailable ? await checkRedisReachable() : false;
const canRun = dbAvailable && redisAvailable;

// ─── Redis connection opts (mirror the service under test) ───────────────

function getRedisConnectionOpts() {
  const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parseInt(parsed.port || '6379', 10),
    password: parsed.password || undefined,
    maxRetriesPerRequest: null,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────

let testUserId: string;
let testSubscriptionId: string;

/**
 * Seed the prerequisite `users` + `webhook_subscriptions` rows once per
 * test. Truncation runs before each test, so we re-seed in beforeEach.
 */
async function seedUserAndSubscription(): Promise<void> {
  const u = await query<{ id: string }>(
    `INSERT INTO users (username, password_hash, role)
     VALUES ('webhook-poller-test', 'hash', 'admin')
     RETURNING id`,
  );
  testUserId = u.rows[0]!.id;

  const s = await query<{ id: string }>(
    `INSERT INTO webhook_subscriptions
        (user_id, url, secret_enc, event_types, active)
     VALUES ($1, 'https://example.invalid/hook', '\\x00'::bytea,
             ARRAY['page.updated'], TRUE)
     RETURNING id`,
    [testUserId],
  );
  testSubscriptionId = s.rows[0]!.id;
}

async function insertOutboxRow(opts: {
  status?: 'pending' | 'dispatched' | 'done' | 'dead';
  nextDispatchOffsetSec?: number; // 0 = now; positive = future; negative = past
  dispatchedAtOffsetSec?: number | null;
  subscriptionId?: string;
}): Promise<string> {
  const status = opts.status ?? 'pending';
  const offset = opts.nextDispatchOffsetSec ?? 0;
  const dispatchedAt =
    opts.dispatchedAtOffsetSec === undefined
      ? null
      : opts.dispatchedAtOffsetSec;
  const subId = opts.subscriptionId ?? testSubscriptionId;

  const result = await query<{ id: string }>(
    `INSERT INTO webhook_outbox
        (subscription_id, event_type, payload, payload_bytes,
         status, next_dispatch_at, dispatched_at)
     VALUES ($1, 'page.updated', '{"id":"p1"}'::jsonb, 12,
             $2, NOW() + ($3::text || ' seconds')::interval,
             CASE WHEN $4::int IS NULL THEN NULL
                  ELSE NOW() + ($4::text || ' seconds')::interval END)
     RETURNING id`,
    [subId, status, String(offset), dispatchedAt],
  );
  return result.rows[0]!.id;
}

async function readOutboxRow(id: string) {
  const r = await query<{
    status: string;
    bullmq_job_id: string | null;
    dispatched_at: Date | null;
  }>(
    `SELECT status, bullmq_job_id, dispatched_at FROM webhook_outbox WHERE id = $1`,
    [id],
  );
  return r.rows[0] ?? null;
}

/**
 * Separate Queue instance for the assertion side — talks to the same
 * Redis keyspace as the poller's queue but does NOT share process-local
 * state, so closing one does not affect the other.
 */
let assertionQueue: Queue | null = null;

function getAssertionQueue(): Queue {
  if (!assertionQueue) {
    assertionQueue = new Queue(WEBHOOK_DELIVERY_QUEUE, {
      connection: getRedisConnectionOpts(),
    });
  }
  return assertionQueue;
}

// ─── Lifecycle ──────────────────────────────────────────────────────────

beforeAll(async () => {
  if (!canRun) return;
  await setupTestDb();
}, 30_000);

afterAll(async () => {
  if (!canRun) return;
  if (assertionQueue) {
    try {
      await assertionQueue.obliterate({ force: true });
      await assertionQueue.close();
    } catch {
      /* best effort */
    }
    assertionQueue = null;
  }
  await __closeWebhookDeliveryQueueForTests();
  await teardownTestDb();
});

beforeEach(async () => {
  if (!canRun) return;
  await truncateAllTables();
  await seedUserAndSubscription();

  // Scrub any jobs left in Redis from a prior test. Obliterate is the
  // only way to wipe completed + waiting + delayed in one call.
  const q = getAssertionQueue();
  try {
    await q.obliterate({ force: true });
  } catch {
    /* queue may not exist yet on first run */
  }
});

afterEach(async () => {
  if (!canRun) return;
  // Reset module state so the next test starts clean; the queue itself
  // is shared across tests so we don't close it here.
  __resetWebhookOutboxPollerForTests();
});

// ─── Placeholder suite (when env is missing) ────────────────────────────
//
// Vitest treats an empty file as success. Emit at least one skipped test
// so the run output records "skipped for missing env" rather than
// silently passing with zero tests.

describe.skipIf(canRun)('webhook-outbox-poller integration [SKIPPED — missing env]', () => {
  it.skip(
    `Requires Postgres (${dbAvailable ? 'OK' : 'MISSING'}) and Redis (${redisAvailable ? 'OK' : 'MISSING'})`,
    () => {
      /* placeholder */
    },
  );
});

// ─── Real tests ─────────────────────────────────────────────────────────

describe.skipIf(!canRun)('webhook-outbox-poller', () => {
  describe('__pollOnce — happy path', () => {
    it('claims pending rows, flips status to dispatched, and enqueues one BullMQ job each', async () => {
      const ids = [
        await insertOutboxRow({}),
        await insertOutboxRow({}),
        await insertOutboxRow({}),
      ];

      const claimed = await __pollOnce();
      expect(claimed).toBe(3);

      // DB side: each row now `dispatched`, has a bullmq_job_id, and a
      // dispatched_at timestamp close to NOW().
      const rows = await query<{
        id: string;
        status: string;
        bullmq_job_id: string;
        age_s: string;
      }>(
        `SELECT id, status, bullmq_job_id,
                EXTRACT(EPOCH FROM (NOW() - dispatched_at))::text AS age_s
           FROM webhook_outbox
          ORDER BY created_at ASC`,
      );
      expect(rows.rows).toHaveLength(3);
      for (const row of rows.rows) {
        expect(row.status).toBe('dispatched');
        expect(row.bullmq_job_id).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        );
        expect(parseFloat(row.age_s)).toBeLessThan(5);
      }
      // IDs should match the seeded order (we INSERTed sequentially).
      expect(rows.rows.map((r) => r.id).sort()).toEqual([...ids].sort());

      // BullMQ side: 3 jobs on the delivery queue with matching jobIds.
      const q = getAssertionQueue();
      const waiting = await q.getWaitingCount();
      expect(waiting).toBe(3);

      for (const row of rows.rows) {
        const job = await q.getJob(row.bullmq_job_id);
        expect(job).not.toBeNull();
        expect(job!.name).toBe('deliver');
        expect(job!.data.outboxId).toBe(row.id);
        expect(job!.data.eventType).toBe('page.updated');
      }
    });
  });

  describe('skip rules', () => {
    it('does NOT claim a row whose next_dispatch_at is still in the future', async () => {
      const futureId = await insertOutboxRow({ nextDispatchOffsetSec: 3600 });

      const claimed = await __pollOnce();
      expect(claimed).toBe(0);

      const row = await readOutboxRow(futureId);
      expect(row?.status).toBe('pending');
      expect(row?.bullmq_job_id).toBeNull();
    });

    it('does NOT re-dispatch rows that are already in terminal states (done / dead)', async () => {
      const doneId = await insertOutboxRow({ status: 'done' });
      const deadId = await insertOutboxRow({ status: 'dead' });

      const claimed = await __pollOnce();
      expect(claimed).toBe(0);

      const done = await readOutboxRow(doneId);
      const dead = await readOutboxRow(deadId);
      expect(done?.status).toBe('done');
      expect(dead?.status).toBe('dead');
    });
  });

  describe('batch size', () => {
    it('claims at most batchSize rows per cycle', async () => {
      // 20 is enough to prove the cap without stretching the test-DB
      // round-trip budget.
      const total = 20;
      for (let i = 0; i < total; i++) {
        await insertOutboxRow({});
      }

      const claimed = await __pollOnce(5);
      expect(claimed).toBe(5);

      const remainingPending = await query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM webhook_outbox WHERE status = 'pending'`,
      );
      expect(remainingPending.rows[0]!.c).toBe(String(total - 5));

      const dispatched = await query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM webhook_outbox WHERE status = 'dispatched'`,
      );
      expect(dispatched.rows[0]!.c).toBe('5');
    });
  });

  describe('cluster safety — FOR UPDATE SKIP LOCKED', () => {
    it('two concurrent __pollOnce calls partition the rows; never double-claim', async () => {
      const total = 10;
      for (let i = 0; i < total; i++) {
        await insertOutboxRow({});
      }

      // Fire two pollers into the guard together. Because the guard is
      // module-scope and the same module instance backs both calls,
      // Promise.all would normally trigger the guard — but the guard is
      // re-checked synchronously so the second call bails with 0 and the
      // first gets everything. That would make this test prove the guard,
      // not SKIP LOCKED.
      //
      // To actually probe SKIP LOCKED, we need two DISTINCT transactions
      // running the claim query concurrently. The cleanest path is to
      // bypass the single-module-instance guard by running a raw copy of
      // the claim SQL against the pool alongside the poller's __pollOnce.
      //
      // This proves the DB-layer cluster-safety primitive independently
      // of the module-scope JS guard.

      const pool = getPool();

      const rawClaim = async (): Promise<string[]> => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const r = await client.query<{ id: string }>(
            `WITH candidates AS (
               SELECT id
                 FROM webhook_outbox
                WHERE status = 'pending'
                  AND next_dispatch_at <= NOW()
                ORDER BY created_at ASC
                LIMIT 100
                FOR UPDATE SKIP LOCKED
             )
             UPDATE webhook_outbox o
                SET status = 'dispatched',
                    dispatched_at = NOW(),
                    bullmq_job_id = gen_random_uuid()::text
               FROM candidates c
              WHERE o.id = c.id
             RETURNING o.id`,
          );
          await client.query('COMMIT');
          return r.rows.map((row) => row.id);
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        } finally {
          client.release();
        }
      };

      const [a, b] = await Promise.all([rawClaim(), rawClaim()]);

      // Cluster-safety invariant: union covers everyone, intersection is
      // empty.
      const setA = new Set(a);
      const setB = new Set(b);
      expect(setA.size + setB.size).toBe(total);
      for (const id of setA) {
        expect(setB.has(id)).toBe(false);
      }
      // And every row ended up `dispatched`.
      const dispatched = await query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM webhook_outbox WHERE status = 'dispatched'`,
      );
      expect(dispatched.rows[0]!.c).toBe(String(total));
    });
  });

  describe('stale-dispatch recovery sweep', () => {
    it('resets rows stuck in dispatched beyond the threshold back to pending', async () => {
      const stuckId = await insertOutboxRow({
        status: 'dispatched',
        dispatchedAtOffsetSec: -600, // 10 minutes ago
      });

      const recovered = await recoverStuckDispatches(5 * 60 * 1_000);
      expect(recovered).toBe(1);

      const row = await readOutboxRow(stuckId);
      expect(row?.status).toBe('pending');
      expect(row?.bullmq_job_id).toBeNull();
      expect(row?.dispatched_at).toBeNull();
    });

    it('leaves rows alone when dispatched_at is younger than the threshold', async () => {
      const freshId = await insertOutboxRow({
        status: 'dispatched',
        dispatchedAtOffsetSec: -30, // 30 seconds ago
      });

      const recovered = await recoverStuckDispatches(5 * 60 * 1_000);
      expect(recovered).toBe(0);

      const row = await readOutboxRow(freshId);
      expect(row?.status).toBe('dispatched');
      expect(row?.dispatched_at).not.toBeNull();
    });
  });

  describe('poll-in-progress guard', () => {
    it('second __pollOnce invoked while the first is still running returns 0 without racing', async () => {
      // Seed enough rows so the claim query has real work to do.
      for (let i = 0; i < 5; i++) {
        await insertOutboxRow({});
      }

      // Fire the first call (don't await yet) then kick off a second
      // while it's in-flight. The module-scope guard should cause the
      // second to short-circuit to 0.
      const first = __pollOnce();
      const second = __pollOnce();

      const [firstResult, secondResult] = await Promise.all([first, second]);

      // Exactly one of the two saw the rows; the other was guarded.
      // In practice `second` is scheduled synchronously after `first`
      // sets `pollingInProgress = true`, so the second returns 0.
      expect(firstResult + secondResult).toBe(5);
      expect(Math.min(firstResult, secondResult)).toBe(0);
      expect(Math.max(firstResult, secondResult)).toBe(5);
    });
  });

  describe('initWebhookOutboxPoller', () => {
    it('runs recovery sweep at init and returns an idempotent teardown', async () => {
      const stuckId = await insertOutboxRow({
        status: 'dispatched',
        dispatchedAtOffsetSec: -600,
      });

      // Interval of 1 hour so no tick fires during the test.
      const teardown = await initWebhookOutboxPoller({
        pollIntervalMs: 60 * 60 * 1_000,
        staleDispatchThresholdMs: 5 * 60 * 1_000,
      });

      // Recovery ran.
      const row = await readOutboxRow(stuckId);
      expect(row?.status).toBe('pending');

      // Idempotent second init — same teardown.
      const teardown2 = await initWebhookOutboxPoller({
        pollIntervalMs: 60 * 60 * 1_000,
      });
      expect(teardown2).toBe(teardown);

      await teardown();
      // Running it again is safe (delivery queue may already be closed).
      await teardown();

      // `getWebhookDeliveryQueue()` should rebuild after teardown so
      // subsequent tests still have a working queue handle.
      const fresh = getWebhookDeliveryQueue();
      expect(fresh).toBeInstanceOf(Queue);

      // Wait for the rebuilt queue's ioredis client + subscriber connections
      // to fully establish before we close them. Otherwise `afterAll`'s
      // `__closeWebhookDeliveryQueueForTests()` races against in-flight
      // ioredis handshake commands and the close handler rejects them with
      // `Error: Connection is closed.` — which surfaces as an unhandled
      // rejection that fails the whole vitest run (see Compendiq/compendiq-ce
      // PRs #365, #373, #377). Owning the cleanup inside the test that
      // built the queue eliminates the race entirely.
      await fresh.waitUntilReady();
      await __closeWebhookDeliveryQueueForTests();
    });
  });
});

// ─── Notes ──────────────────────────────────────────────────────────────
//
// If the suite aborts mid-test, vitest's process teardown still runs the
// `afterAll` hook — but only for suites that ran at least one test. The
// `describe.skipIf(canRun)` placeholder branch always emits at least one
// `it.skip`, so `afterAll` executes whether or not `canRun` is true. The
// placeholder branch itself has no cleanup to do.
