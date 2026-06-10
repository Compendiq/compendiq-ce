/**
 * Regression test (issue #742 follow-up): the webhook-delivery `Worker`
 * MUST build its Redis connection options via the shared parser in
 * `core/utils/redis-connection.ts`.
 *
 * A drifted local copy of the parser previously dropped `rediss://` TLS,
 * the ACL username, and the `/N` db index. Because the outbox poller
 * (producer) already used the shared parser, a REDIS_URL like
 * `redis://host:6379/2` split the pipeline: the poller enqueued jobs into
 * db 2 while the worker listened on db 0 — webhooks silently never
 * delivered.
 *
 * Mirrors queue-service.test.ts: bullmq is mocked at the module boundary
 * with constructor-capturing stubs, so no real Redis or Postgres is
 * needed — these tests assert wiring, not delivery behaviour (that lives
 * in webhook-delivery.test.ts).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

interface CapturedCtorCall {
  queueName: string;
  opts: { connection?: unknown } | undefined;
}

const workerCtorCalls: CapturedCtorCall[] = [];
const queueCtorCalls: CapturedCtorCall[] = [];

vi.mock('bullmq', () => ({
  // Real constructor functions so `new Queue(...)` / `new Worker(...)`
  // work — arrow functions are not constructible (same pattern as
  // queue-service.test.ts).
  Queue: function (
    this: Record<string, unknown>,
    queueName: string,
    opts?: { connection?: unknown },
  ) {
    queueCtorCalls.push({ queueName, opts });
    this.close = vi.fn().mockResolvedValue(undefined);
  },
  Worker: function (
    this: Record<string, unknown>,
    queueName: string,
    _processor: unknown,
    opts?: { connection?: unknown },
  ) {
    workerCtorCalls.push({ queueName, opts });
    this.on = vi.fn();
    this.close = vi.fn().mockResolvedValue(undefined);
  },
}));

vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('webhook-delivery worker — Redis connection wiring', () => {
  beforeEach(() => {
    workerCtorCalls.length = 0;
    queueCtorCalls.length = 0;
    // Fresh module state (cachedTeardown, worker singleton, the poller's
    // queue handle) per test.
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('passes the shared parser output (TLS, ACL username, db index) to the Worker', async () => {
    const url = 'rediss://app-user:s%40cret@redis.internal:6390/2';
    vi.stubEnv('REDIS_URL', url);

    const { getRedisConnectionOpts } = await import('../utils/redis-connection.js');
    const { initWebhookDeliveryWorker } = await import('./webhook-delivery.js');

    const teardown = await initWebhookDeliveryWorker();
    try {
      expect(workerCtorCalls).toHaveLength(1);
      expect(workerCtorCalls[0]!.queueName).toBe('webhook-delivery');
      // The Worker's connection must be exactly what the shared parser
      // produces for the same URL…
      expect(workerCtorCalls[0]!.opts?.connection).toEqual(
        getRedisConnectionOpts(url),
      );
      // …and explicitly carry the full supported surface, so this test
      // still fails loudly if the shared parser itself regresses.
      expect(workerCtorCalls[0]!.opts?.connection).toEqual({
        host: 'redis.internal',
        port: 6390,
        username: 'app-user',
        password: 's@cret',
        db: 2,
        tls: {},
        maxRetriesPerRequest: null,
      });
    } finally {
      await teardown();
    }
  });

  it('worker (consumer) and shared delivery queue (producer) use identical connection options', async () => {
    // A db-index URL is the exact split that originally broke delivery:
    // producer on db 2, consumer on db 0.
    vi.stubEnv('REDIS_URL', 'redis://localhost:6379/2');

    const { initWebhookDeliveryWorker } = await import('./webhook-delivery.js');

    const teardown = await initWebhookDeliveryWorker();
    try {
      // initWebhookDeliveryWorker eagerly builds the shared queue handle
      // via getWebhookDeliveryQueue() (poller module).
      expect(queueCtorCalls).toHaveLength(1);
      expect(queueCtorCalls[0]!.queueName).toBe('webhook-delivery');
      expect(workerCtorCalls).toHaveLength(1);
      expect(workerCtorCalls[0]!.opts?.connection).toEqual(
        queueCtorCalls[0]!.opts?.connection,
      );
    } finally {
      await teardown();
    }
  });
});
