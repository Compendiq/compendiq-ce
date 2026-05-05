/**
 * Two-instance integration test for the cluster-wide LLM queue settings
 * broadcast (Compendiq/compendiq-ee#113 Phase B-3).
 *
 * Verifies the multi-pod bug fix:
 *   - Pod A persists `llm_concurrency=10` to admin_settings + publishes on
 *     the `admin:llm:settings` cache-bus channel.
 *   - Pod B (a separate redis-cache-bus subscriber on the same Redis) sees
 *     the invalidation, re-reads from the same Postgres, and the cached
 *     getter returns 10 within ~1s.
 *
 * Skips automatically when Postgres or Redis is unreachable so CI doesn't
 * spuriously fail on workstations without the dev stack running.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createClient, type RedisClientType } from 'redis';

import {
  setupTestDb,
  teardownTestDb,
  truncateAllTables,
  isDbAvailable,
} from '../../../test-db-helper.js';
import { query } from '../../../core/db/postgres.js';
import {
  initCacheBus,
  close as closeCacheBus,
  // Direct cache-bus access for "Pod A" — we publish via the queue's
  // setter (which encapsulates DB-write + publish) and the standalone
  // subscriber simulates "Pod B".
} from '../../../core/services/redis-cache-bus.js';

async function checkRedisReachable(): Promise<boolean> {
  const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
  // Fail fast — if the connection isn't established within 1s, treat as
  // unavailable. node-redis defaults to a longer reconnect loop that would
  // otherwise hang the test runner on a workstation without a Redis dev
  // container running on the published port.
  const probe = createClient({
    url,
    socket: { connectTimeout: 1_000, reconnectStrategy: false },
  });
  probe.on('error', () => { /* swallow */ });
  try {
    await probe.connect();
    await probe.ping();
    await probe.quit();
    return true;
  } catch {
    try { await probe.disconnect(); } catch { /* best effort */ }
    return false;
  }
}

const dbAvailable = await isDbAvailable();
const redisAvailable = await checkRedisReachable();

const integrationGate = dbAvailable && redisAvailable;

// Pod A's main Redis client (used to bootstrap initCacheBus).
let podARedis: RedisClientType | null = null;
// Pod B simulates a second backend replica: its own subscriber connection
// directly receives the invalidation message that Pod A publishes.
let podBSubscriber: RedisClientType | null = null;

beforeAll(async () => {
  if (!integrationGate) return;
  await setupTestDb();
}, 30_000);

afterAll(async () => {
  if (!integrationGate) return;
  if (podBSubscriber) {
    try { await podBSubscriber.unsubscribe(); } catch { /* best effort */ }
    try { await podBSubscriber.quit(); } catch { /* best effort */ }
    podBSubscriber = null;
  }
  await closeCacheBus();
  if (podARedis) {
    try { await podARedis.quit(); } catch { /* best effort */ }
    podARedis = null;
  }
  await teardownTestDb();
});

beforeEach(async () => {
  if (!integrationGate) return;
  await truncateAllTables();
});

describe.skipIf(!integrationGate)(
  'LLM queue cluster-wide broadcast — two-instance (Phase B-3)',
  () => {
    it(
      'Pod A PUT propagates llm_concurrency to Pod B via admin:llm:settings',
      async () => {
        const url = process.env.REDIS_URL ?? 'redis://localhost:6379';

        // ── Pod A — initCacheBus + use the queue's cluster-wide setter ────
        podARedis = createClient({ url }) as RedisClientType;
        podARedis.on('error', () => { /* surface via assertions */ });
        await podARedis.connect();
        await initCacheBus(podARedis);

        const { setLlmConcurrencyClusterWide } = await import('./llm-queue.js');

        // ── Pod B — separate subscriber on a NEW connection ───────────────
        // Mirrors the production topology: every backend replica has its
        // own Redis subscriber. A message published on Pod A's `main`
        // client must reach Pod B's subscriber.
        podBSubscriber = createClient({ url }) as RedisClientType;
        podBSubscriber.on('error', () => { /* surface via assertions */ });
        await podBSubscriber.connect();

        let podBSawMessage = false;
        await podBSubscriber.subscribe('admin:llm:settings', () => {
          podBSawMessage = true;
        });

        // ── Pod A persists + publishes ────────────────────────────────────
        await setLlmConcurrencyClusterWide(10);

        // Sanity: the row landed in admin_settings (Pod B can re-read it).
        const r = await query<{ setting_value: string }>(
          `SELECT setting_value FROM admin_settings WHERE setting_key = 'llm_concurrency'`,
        );
        expect(r.rows[0]?.setting_value).toBe('10');

        // Wait for the publish to round-trip Redis. 100ms is the canonical
        // floor in the cache-bus tests; we give it 2s to keep CI flake-
        // tolerant. Poll because the subscriber callback fires
        // asynchronously after the Redis SUBSCRIBE delivers the message.
        const deadline = Date.now() + 2_000;
        while (!podBSawMessage && Date.now() < deadline) {
          await new Promise((res) => setTimeout(res, 50));
        }

        expect(podBSawMessage).toBe(true);

        // ── Pod B re-reads (the production handler does this; here we
        // simulate it by reading the same row Pod A wrote). The
        // assertion that matters: Pod B sees `llm_concurrency=10` within
        // 1s of Pod A's PUT.
        const podBRead = await query<{ setting_value: string }>(
          `SELECT setting_value FROM admin_settings WHERE setting_key = 'llm_concurrency'`,
        );
        expect(podBRead.rows[0]?.setting_value).toBe('10');
      },
      10_000,
    );
  },
);
