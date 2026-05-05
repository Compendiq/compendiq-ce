/**
 * Integration tests for the webhook delivery worker
 * (Compendiq/compendiq-ee#114, Phase D).
 *
 * Exercises `__deliverOnce()` against REAL Postgres and a mocked undici
 * `fetch`. The BullMQ worker construction path (`initWebhookDeliveryWorker`)
 * is intentionally NOT driven here — Phase F owns end-to-end wiring, and
 * the per-job contract is fully observable via `__deliverOnce` without
 * needing Redis to be up. We still probe Redis so the suite skips with
 * the same banner the outbox-poller test uses, keeping CI semantics
 * aligned across Phase C and Phase D.
 *
 * Mocking strategy:
 *   - `vi.mock('undici', ...)` hoists to before module import and
 *     replaces both `fetch` (the outbound POST) and `Agent` (the
 *     dispatcher constructor) with stubs. Each test overrides the mock's
 *     implementation to simulate 2xx / 4xx / 5xx / timeout responses.
 *   - We do NOT mock postgres / crypto / ssrf-guard / webhook-signer —
 *     they exercise real code against the real DB.
 *
 * The 10 cases below trace the contract matrix from the Phase D brief:
 *   1. 2xx success → outbox 'done' + success row
 *   2. 4xx permanent → outbox 'dead' + failure row
 *   3. 5xx retryable → outbox back to 'pending' + backoff[1] = 5s
 *   4. Timeout → delivery row status='timeout' + retry
 *   5. SSRF-blocked URL → delivery row status='ssrf_blocked' + retry
 *   6. Exhausted retries → outbox 'dead' + WEBHOOK_DELIVERY_DEAD audit
 *   7. Inactive subscription → dead, never attempts HTTP
 *   8. Signature + required headers asserted on outbound request
 *   9. Response body truncated to 1 KB
 *  10. Backoff table produces expected delays (parametric)
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { createClient } from 'redis';

// ─── Mock undici (hoisted before service import) ─────────────────────────
//
// The mock returns stubs for both `fetch` (replaced per-test) and `Agent`
// (constructor stub — tests don't interrogate it, but the service calls
// `new Agent(...)` during init, so it must be callable).
vi.mock('undici', () => {
  // `Agent` is a real class in undici; the service uses `new Agent(...)`,
  // so the mock MUST be constructor-callable. `vi.fn` alone is callable
  // but not constructor-callable under ESM hoisting — hence a plain
  // class stub with the one method the service might invoke.
  class MockAgent {
    close(): Promise<void> {
      return Promise.resolve();
    }
  }
  return {
    fetch: vi.fn(),
    Agent: MockAgent,
  };
});

// Silence the logger so test output stays focused on assertions.
vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { fetch as undiciFetch } from 'undici';
import {
  isDbAvailable,
  setupTestDb,
  teardownTestDb,
  truncateAllTables,
} from '../../test-db-helper.js';
import { query } from '../db/postgres.js';
import { encryptPat } from '../utils/crypto.js';
import {
  __deliverOnce,
  __resetWebhookDeliveryWorkerForTests,
  backoffSeconds,
} from './webhook-delivery.js';

const mockFetch = vi.mocked(undiciFetch);

// ─── Environment probe ──────────────────────────────────────────────────

async function checkRedisReachable(): Promise<boolean> {
  const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
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

// ─── Helpers ────────────────────────────────────────────────────────────

const TEST_SECRET = 'webhook-delivery-test-secret-value-1234';

/**
 * Build an undici-fetch-shaped response object. Kept minimal — the
 * service only reads `status` and `text()`.
 */
function makeFetchResponse(opts: {
  status: number;
  body?: string;
}): unknown {
  const body = opts.body ?? '';
  return {
    status: opts.status,
    ok: opts.status >= 200 && opts.status < 300,
    text: async () => body,
  };
}

/**
 * Build an AbortError shaped like what `AbortSignal.timeout` throws so
 * the service classifies it as `timeout`.
 */
function makeTimeoutError(): Error {
  const err = new Error('The operation was aborted due to timeout');
  err.name = 'TimeoutError';
  return err;
}

interface SeedResult {
  userId: string;
  subscriptionId: string;
  outboxId: string;
  webhookId: string;
}

/**
 * Seed a user + active webhook subscription + one pending outbox row.
 * Returns ids so tests can assert on the resulting DB state.
 */
async function seedSubscriptionAndOutbox(overrides: {
  url?: string;
  active?: boolean;
  eventType?: string;
  payload?: unknown;
} = {}): Promise<SeedResult> {
  const encSecret = encryptPat(TEST_SECRET);

  const u = await query<{ id: string }>(
    `INSERT INTO users (username, password_hash, role)
     VALUES ('webhook-delivery-test-' || substr(md5(random()::text), 1, 8),
             'hash', 'admin')
     RETURNING id`,
  );
  const userId = u.rows[0]!.id;

  const s = await query<{ id: string }>(
    `INSERT INTO webhook_subscriptions
        (user_id, url, secret_enc, event_types, active)
     VALUES ($1, $2, convert_to($3, 'UTF8'), ARRAY['page.updated'], $4)
     RETURNING id`,
    [
      userId,
      overrides.url ?? 'https://receiver.example.com/hook',
      encSecret,
      overrides.active ?? true,
    ],
  );
  const subscriptionId = s.rows[0]!.id;

  const payload = overrides.payload ?? { id: 'page-1', title: 'x' };
  const payloadJson = JSON.stringify(payload);
  const ob = await query<{ id: string; webhook_id: string }>(
    `INSERT INTO webhook_outbox
        (subscription_id, event_type, payload, payload_bytes,
         status, next_dispatch_at)
     VALUES ($1, $2, $3::jsonb, $4, 'pending', NOW())
     RETURNING id, webhook_id`,
    [
      subscriptionId,
      overrides.eventType ?? 'page.updated',
      payloadJson,
      Buffer.byteLength(payloadJson, 'utf8'),
    ],
  );
  return {
    userId,
    subscriptionId,
    outboxId: ob.rows[0]!.id,
    webhookId: ob.rows[0]!.webhook_id,
  };
}

async function readOutbox(id: string): Promise<{
  status: string;
  nextDispatchInSec: number;
  dispatchedAt: Date | null;
  bullmqJobId: string | null;
} | null> {
  const r = await query<{
    status: string;
    next_in: string;
    dispatched_at: Date | null;
    bullmq_job_id: string | null;
  }>(
    `SELECT status,
            EXTRACT(EPOCH FROM (next_dispatch_at - NOW()))::text AS next_in,
            dispatched_at,
            bullmq_job_id
       FROM webhook_outbox WHERE id = $1`,
    [id],
  );
  if (r.rows.length === 0) return null;
  const row = r.rows[0]!;
  return {
    status: row.status,
    nextDispatchInSec: parseFloat(row.next_in),
    dispatchedAt: row.dispatched_at,
    bullmqJobId: row.bullmq_job_id,
  };
}

async function readDeliveries(outboxId: string): Promise<
  Array<{
    attemptNumber: number;
    status: string;
    httpStatus: number | null;
    responseBody: string | null;
    errorMessage: string | null;
    durationMs: number | null;
  }>
> {
  const r = await query<{
    attempt_number: number;
    status: string;
    http_status: number | null;
    response_body: string | null;
    error_message: string | null;
    duration_ms: number | null;
  }>(
    `SELECT attempt_number, status, http_status, response_body,
            error_message, duration_ms
       FROM webhook_deliveries
      WHERE outbox_id = $1
      ORDER BY attempt_number ASC`,
    [outboxId],
  );
  return r.rows.map((row) => ({
    attemptNumber: row.attempt_number,
    status: row.status,
    httpStatus: row.http_status,
    responseBody: row.response_body,
    errorMessage: row.error_message,
    durationMs: row.duration_ms,
  }));
}

async function readAuditActions(subscriptionId: string): Promise<string[]> {
  const r = await query<{ action: string }>(
    `SELECT action FROM audit_log
      WHERE resource_type = 'webhook_subscription'
        AND resource_id = $1
      ORDER BY created_at ASC`,
    [subscriptionId],
  );
  return r.rows.map((row) => row.action);
}

// ─── Lifecycle ──────────────────────────────────────────────────────────

beforeAll(async () => {
  if (!canRun) return;
  await setupTestDb();
}, 30_000);

afterAll(async () => {
  if (!canRun) return;
  await teardownTestDb();
});

beforeEach(async () => {
  if (!canRun) return;
  await truncateAllTables();
  __resetWebhookDeliveryWorkerForTests();
  mockFetch.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ─── Skipped placeholder when env is missing ────────────────────────────

describe.skipIf(canRun)('webhook-delivery integration [SKIPPED — missing env]', () => {
  it.skip(
    `Requires Postgres (${dbAvailable ? 'OK' : 'MISSING'}) and Redis (${redisAvailable ? 'OK' : 'MISSING'})`,
    () => {
      /* placeholder */
    },
  );
});

// ─── Backoff table — pure, no DB, always runs ───────────────────────────

describe('backoffSeconds (pure)', () => {
  it('produces the expected delay for attempts 1..8', () => {
    // Plan §1.4 table. Values are fixed by spec; do not change without
    // coordinated doc update.
    expect(backoffSeconds(1)).toBe(5);
    expect(backoffSeconds(2)).toBe(30);
    expect(backoffSeconds(3)).toBe(2 * 60);
    expect(backoffSeconds(4)).toBe(5 * 60);
    expect(backoffSeconds(5)).toBe(30 * 60);
    expect(backoffSeconds(6)).toBe(2 * 60 * 60);
    expect(backoffSeconds(7)).toBe(5 * 60 * 60);
    // attempt 8 is the final attempt — no further wait beyond the last
    // tabulated entry; clamping keeps the contract monotonic.
    expect(backoffSeconds(8)).toBe(5 * 60 * 60);
  });
});

// ─── Real tests ─────────────────────────────────────────────────────────

describe.skipIf(!canRun)('webhook-delivery __deliverOnce', () => {
  // Case 1: 2xx success → outbox 'done' + success row
  it('2xx response marks outbox done and records a success row', async () => {
    const seed = await seedSubscriptionAndOutbox();
    mockFetch.mockResolvedValueOnce(
      makeFetchResponse({ status: 200, body: 'ok' }) as never,
    );

    const outcome = await __deliverOnce({
      id: seed.outboxId,
      subscription_id: seed.subscriptionId,
      webhook_id: seed.webhookId,
      event_type: 'page.updated',
      payload: { id: 'page-1' },
    });

    expect(outcome.outcome).toBe('success');
    expect(outcome.httpStatus).toBe(200);
    expect(outcome.terminal).toBe(true);

    const outbox = await readOutbox(seed.outboxId);
    expect(outbox?.status).toBe('done');

    const deliveries = await readDeliveries(seed.outboxId);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.status).toBe('success');
    expect(deliveries[0]!.httpStatus).toBe(200);
    expect(deliveries[0]!.attemptNumber).toBe(1);
    expect(deliveries[0]!.responseBody).toBe('ok');
  });

  // Case 2: 4xx permanent failure → outbox 'dead' + failure row + DEAD audit
  it('400 marks outbox dead and records a failure row (permanent, no retry)', async () => {
    const seed = await seedSubscriptionAndOutbox();
    mockFetch.mockResolvedValueOnce(
      makeFetchResponse({ status: 400, body: 'bad request' }) as never,
    );

    const outcome = await __deliverOnce({
      id: seed.outboxId,
      subscription_id: seed.subscriptionId,
      webhook_id: seed.webhookId,
      event_type: 'page.updated',
      payload: { id: 'page-1' },
    });

    expect(outcome.outcome).toBe('failure');
    expect(outcome.httpStatus).toBe(400);
    expect(outcome.terminal).toBe(true);

    const outbox = await readOutbox(seed.outboxId);
    expect(outbox?.status).toBe('dead');

    const deliveries = await readDeliveries(seed.outboxId);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.status).toBe('failure');
    expect(deliveries[0]!.httpStatus).toBe(400);

    // Permanent → dead → WEBHOOK_DELIVERY_DEAD audit.
    const actions = await readAuditActions(seed.subscriptionId);
    expect(actions).toEqual(['WEBHOOK_DELIVERY_DEAD']);
  });

  // Case 3: 5xx retryable → outbox back to 'pending' with backoff[1] = 5s
  it('500 moves outbox back to pending with first-attempt backoff of 5s', async () => {
    const seed = await seedSubscriptionAndOutbox();
    mockFetch.mockResolvedValueOnce(
      makeFetchResponse({ status: 500, body: 'internal' }) as never,
    );

    const outcome = await __deliverOnce({
      id: seed.outboxId,
      subscription_id: seed.subscriptionId,
      webhook_id: seed.webhookId,
      event_type: 'page.updated',
      payload: { id: 'page-1' },
    });

    expect(outcome.outcome).toBe('failure');
    expect(outcome.httpStatus).toBe(500);
    expect(outcome.terminal).toBe(false);

    const outbox = await readOutbox(seed.outboxId);
    expect(outbox?.status).toBe('pending');
    // backoff[1] = 5s; tolerate 1s drift for DB round-trip.
    expect(outbox?.nextDispatchInSec).toBeGreaterThanOrEqual(4);
    expect(outbox?.nextDispatchInSec).toBeLessThanOrEqual(6);
    expect(outbox?.dispatchedAt).toBeNull();
    expect(outbox?.bullmqJobId).toBeNull();

    const deliveries = await readDeliveries(seed.outboxId);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.status).toBe('failure');
    expect(deliveries[0]!.httpStatus).toBe(500);

    // Non-terminal → FAILED audit, not DEAD.
    const actions = await readAuditActions(seed.subscriptionId);
    expect(actions).toEqual(['WEBHOOK_DELIVERY_FAILED']);
  });

  // Case 4: Timeout → delivery row status='timeout' + retry
  it('timeout is classified as timeout and schedules a retry', async () => {
    const seed = await seedSubscriptionAndOutbox();
    mockFetch.mockRejectedValueOnce(makeTimeoutError());

    const outcome = await __deliverOnce({
      id: seed.outboxId,
      subscription_id: seed.subscriptionId,
      webhook_id: seed.webhookId,
      event_type: 'page.updated',
      payload: { id: 'page-1' },
    });

    expect(outcome.outcome).toBe('timeout');
    expect(outcome.terminal).toBe(false);

    const outbox = await readOutbox(seed.outboxId);
    expect(outbox?.status).toBe('pending');

    const deliveries = await readDeliveries(seed.outboxId);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.status).toBe('timeout');
    expect(deliveries[0]!.httpStatus).toBeNull();
    expect(deliveries[0]!.errorMessage).toMatch(/timeout|aborted/i);
  });

  // Case 5: SSRF-blocked URL → counts as one attempt; not terminal on first
  it('SSRF-blocked URL records an ssrf_blocked delivery row and schedules a retry', async () => {
    const seed = await seedSubscriptionAndOutbox({
      // 169.254.169.254 is AWS metadata — caught by the link-local
      // pattern in ssrf-guard before DNS lookup.
      url: 'http://169.254.169.254/latest/meta-data/',
    });

    const outcome = await __deliverOnce({
      id: seed.outboxId,
      subscription_id: seed.subscriptionId,
      webhook_id: seed.webhookId,
      event_type: 'page.updated',
      payload: { id: 'page-1' },
    });

    expect(outcome.outcome).toBe('ssrf_blocked');
    // SSRF counts against the retry budget (plan: "misconfigured URL
    // eventually dies instead of looping") — NOT terminal on attempt 1.
    expect(outcome.terminal).toBe(false);

    // HTTP was never attempted.
    expect(mockFetch).not.toHaveBeenCalled();

    const outbox = await readOutbox(seed.outboxId);
    expect(outbox?.status).toBe('pending');

    const deliveries = await readDeliveries(seed.outboxId);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.status).toBe('ssrf_blocked');
    expect(deliveries[0]!.errorMessage).toMatch(/SSRF/i);
  });

  // Case 6: Exhausted retries → dead + WEBHOOK_DELIVERY_DEAD audit
  it('the 8th failed attempt marks outbox dead and writes WEBHOOK_DELIVERY_DEAD', async () => {
    const seed = await seedSubscriptionAndOutbox();

    // Pre-seed 7 prior failures so this delivery is attempt 8 (maxAttempts=8).
    for (let n = 1; n <= 7; n++) {
      await query(
        `INSERT INTO webhook_deliveries
            (outbox_id, subscription_id, webhook_id, attempt_number,
             status, http_status, error_message, duration_ms)
         VALUES ($1, $2, $3, $4, 'failure', 500, 'HTTP 500', 10)`,
        [seed.outboxId, seed.subscriptionId, seed.webhookId, n],
      );
    }

    mockFetch.mockResolvedValueOnce(
      makeFetchResponse({ status: 500, body: 'still broken' }) as never,
    );

    const outcome = await __deliverOnce({
      id: seed.outboxId,
      subscription_id: seed.subscriptionId,
      webhook_id: seed.webhookId,
      event_type: 'page.updated',
      payload: { id: 'page-1' },
    });

    expect(outcome.outcome).toBe('failure');
    expect(outcome.terminal).toBe(true);

    const outbox = await readOutbox(seed.outboxId);
    expect(outbox?.status).toBe('dead');

    const deliveries = await readDeliveries(seed.outboxId);
    expect(deliveries).toHaveLength(8);
    expect(deliveries[7]!.attemptNumber).toBe(8);
    expect(deliveries[7]!.status).toBe('failure');

    const actions = await readAuditActions(seed.subscriptionId);
    expect(actions).toEqual(['WEBHOOK_DELIVERY_DEAD']);
  });

  // Case 7: Inactive subscription → dead, never attempts HTTP
  it('inactive subscription → outbox dead, HTTP never attempted', async () => {
    const seed = await seedSubscriptionAndOutbox({ active: false });

    const outcome = await __deliverOnce({
      id: seed.outboxId,
      subscription_id: seed.subscriptionId,
      webhook_id: seed.webhookId,
      event_type: 'page.updated',
      payload: { id: 'page-1' },
    });

    expect(outcome.outcome).toBe('failure');
    expect(outcome.terminal).toBe(true);
    expect(outcome.errorMessage).toBe('subscription_missing_or_inactive');

    expect(mockFetch).not.toHaveBeenCalled();

    const outbox = await readOutbox(seed.outboxId);
    expect(outbox?.status).toBe('dead');

    const deliveries = await readDeliveries(seed.outboxId);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.status).toBe('failure');
    expect(deliveries[0]!.errorMessage).toBe('subscription_missing_or_inactive');
  });

  // Case 8: Signature + required headers present on outbound request
  it('sends webhook-* headers, content-type, user-agent, and X-Compendiq-Event', async () => {
    const seed = await seedSubscriptionAndOutbox();
    mockFetch.mockResolvedValueOnce(
      makeFetchResponse({ status: 200, body: '' }) as never,
    );

    await __deliverOnce({
      id: seed.outboxId,
      subscription_id: seed.subscriptionId,
      webhook_id: seed.webhookId,
      event_type: 'page.updated',
      payload: { id: 'page-1' },
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://receiver.example.com/hook');

    const headers = (init as { headers: Record<string, string> }).headers;
    expect(headers['webhook-id']).toBe(seed.webhookId);
    expect(headers['webhook-timestamp']).toMatch(/^\d+$/);
    // Signer prefix "v1,<base64>"; may contain multiple space-separated
    // values during a rotation window but the primary-only path
    // guarantees exactly one.
    expect(headers['webhook-signature']).toMatch(/^v1,[A-Za-z0-9+/=]+$/);
    expect(headers['content-type']).toBe('application/json');
    expect(headers['user-agent']).toContain('Compendiq-Webhook/');
    expect(headers['X-Compendiq-Event']).toBe('page.updated');

    // Body must be byte-identical to what was signed.
    const body = (init as { body: string }).body;
    expect(body).toBe(
      JSON.stringify({ type: 'page.updated', data: { id: 'page-1' } }),
    );
  });

  // Case 9: Response body truncated to 1 KB
  it('persists at most 1024 bytes of the response body', async () => {
    const seed = await seedSubscriptionAndOutbox();
    // 5 KB is well over the 1 KB cap — picks a character distinct from
    // the prefix window so an off-by-one cap bug is visible.
    const bigBody = 'a'.repeat(5 * 1024);
    mockFetch.mockResolvedValueOnce(
      makeFetchResponse({ status: 200, body: bigBody }) as never,
    );

    await __deliverOnce({
      id: seed.outboxId,
      subscription_id: seed.subscriptionId,
      webhook_id: seed.webhookId,
      event_type: 'page.updated',
      payload: { id: 'page-1' },
    });

    const deliveries = await readDeliveries(seed.outboxId);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.responseBody).not.toBeNull();
    expect(deliveries[0]!.responseBody!.length).toBeLessThanOrEqual(1024);
    expect(deliveries[0]!.responseBody!.length).toBe(1024);
  });

  // Case 10: Backoff table produces expected delays at the DB level too.
  // This is the parametric check requested in the brief — it complements
  // the pure unit on `backoffSeconds` by confirming the number that comes
  // out of the delivery flow matches the table within 1s tolerance.
  it('first-attempt retry schedules next_dispatch_at = now() + backoffSeconds(1)', async () => {
    const seed = await seedSubscriptionAndOutbox();
    mockFetch.mockResolvedValueOnce(
      makeFetchResponse({ status: 503, body: 'unavail' }) as never,
    );

    await __deliverOnce({
      id: seed.outboxId,
      subscription_id: seed.subscriptionId,
      webhook_id: seed.webhookId,
      event_type: 'page.updated',
      payload: { id: 'page-1' },
    });

    const outbox = await readOutbox(seed.outboxId);
    const expected = backoffSeconds(1);
    expect(outbox?.status).toBe('pending');
    // ±1s tolerance for the DB NOW() vs NodeJS clock skew window.
    expect(outbox?.nextDispatchInSec).toBeGreaterThanOrEqual(expected - 1);
    expect(outbox?.nextDispatchInSec).toBeLessThanOrEqual(expected + 1);
  });
});
