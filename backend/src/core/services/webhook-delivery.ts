/**
 * Webhook delivery worker (Compendiq/compendiq-ee#114, Phase D).
 *
 * BullMQ `Worker` that consumes the `webhook-delivery` queue populated by
 * the Phase C outbox poller. Each job represents one pending row in
 * `webhook_outbox`. The worker:
 *
 *   1. Loads the subscription and validates it is active.
 *   2. Decrypts the primary signing secret.
 *   3. Runs the SSRF guard on the subscription URL (repeated per-attempt
 *      because the allow/block result can change between when the admin
 *      created the sub and when we fire — DNS rebinding, admin edit, etc.).
 *   4. Stringifies the payload (plain JSON.stringify — canonicalisation is
 *      the receiver's problem; we guarantee only that the string fed to
 *      the signer is byte-identical to the HTTP body).
 *   5. Signs with `webhook-signer.signWebhook()` using the primary secret.
 *      Rotation overlap is a receiver-side concern; we never dual-sign.
 *   6. POSTs via `undici.fetch` with a 10-second overall deadline
 *      (`AbortSignal.timeout`) AND a 10-second connect/headers deadline
 *      on the `Agent` — the signal alone does not cover the pre-headers
 *      TCP-connect phase.
 *   7. Records one row in `webhook_deliveries` per attempt (status,
 *      http_status, 1 KB-truncated response body, error_message,
 *      duration_ms, attempt_number).
 *   8. Transitions the outbox row:
 *        2xx                                  → status = 'done'
 *        4xx (except 408 / 429)               → status = 'dead'       (permanent)
 *        408 / 429 / 5xx / timeout / network / ssrf → status = 'pending' + backoff
 *                                               if attempts remain; else 'dead'
 *   9. Emits `WEBHOOK_DELIVERY_FAILED` on every non-terminal failure and
 *      `WEBHOOK_DELIVERY_DEAD` on terminal giving-up.
 *
 * The backoff schedule is a table (not an exponential formula) for easier
 * auditing and per-environment tuning.
 *
 * ─── Idempotence & at-least-once delivery ───────────────────────────────
 *
 * `webhook_id` on the outbox row is stable across retries (set at INSERT
 * time, reused every attempt). Receivers use it as the dedup key per the
 * Standard Webhooks spec. A delivery that succeeds after the sender
 * thought it failed will be correctly deduped by a conforming receiver.
 *
 * ─── Not in this module ─────────────────────────────────────────────────
 *
 *   - Startup wiring in `app.ts` (Phase F).
 *   - Admin routes for manual replay / mute (Phase E).
 *   - The signer (Phase B) — we import it as-is.
 *   - The outbox poller (Phase C) — we share its queue handle via
 *     `getWebhookDeliveryQueue()` to keep the keyspace in sync.
 */

import { Worker, type Job, type ConnectionOptions } from 'bullmq';
import { Agent, fetch as undiciFetch } from 'undici';

import { getPool } from '../db/postgres.js';
import { logger } from '../utils/logger.js';
import { assertNonSsrfUrl, SsrfError } from '../utils/ssrf-guard.js';
import { decryptPat } from '../utils/crypto.js';
import { logAuditEvent } from './audit-service.js';
import { signWebhook } from './webhook-signer.js';
import {
  WEBHOOK_DELIVERY_QUEUE,
  getWebhookDeliveryQueue,
} from './webhook-outbox-poller.js';

// ─── Tunables / defaults ─────────────────────────────────────────────────

const DEFAULT_CONCURRENCY = 16;
const DEFAULT_PER_JOB_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_ATTEMPTS = 8;
const DEFAULT_RESPONSE_BODY_CAP_BYTES = 1024;
const DEFAULT_USER_AGENT =
  'Compendiq-Webhook/1.0 (+https://compendiq.com/docs/webhooks)';

/**
 * Backoff schedule — `attempt n` waits `BACKOFF_SECONDS[n - 1]` seconds
 * before the next dispatch. Table-driven by design (plan §1.4 "easier to
 * audit + change"). The eighth entry is the last wait the worker will
 * honour; attempt 9 (9th overall) becomes `dead` without a further retry.
 *
 *   attempt 1 →   5s
 *   attempt 2 →  30s
 *   attempt 3 →   2 min
 *   attempt 4 →   5 min
 *   attempt 5 →  30 min
 *   attempt 6 →   2 h
 *   attempt 7 →   5 h
 *   attempt 8 →  final attempt, then dead
 */
const BACKOFF_SECONDS: readonly number[] = [
  5,
  30,
  2 * 60,
  5 * 60,
  30 * 60,
  2 * 60 * 60,
  5 * 60 * 60,
];

// ─── Public option + data types ──────────────────────────────────────────

export interface WebhookDeliveryOptions {
  /** Worker concurrency. Default 16. */
  concurrency?: number;
  /** Per-job overall HTTP deadline (headers + body). Default 10_000 ms. */
  perJobTimeoutMs?: number;
  /** Attempts before giving up. Default 8 (matches the backoff table). */
  maxAttempts?: number;
  /** Max bytes of response body persisted in `webhook_deliveries`. Default 1024. */
  responseBodyCap?: number;
  /** `User-Agent` header string. Default see `DEFAULT_USER_AGENT`. */
  userAgent?: string;
}

/**
 * Shape of the job data enqueued by the outbox poller. Accepts BOTH the
 * camelCase form the poller actually emits and the snake_case form
 * documented in the delivery spec — tests drive the service with the
 * snake_case form directly.
 */
export interface OutboxJobData {
  /** `webhook_outbox.id` — UUID. */
  id: string;
  /** `webhook_subscriptions.id` — UUID. */
  subscription_id: string;
  /** Receiver-stable dedup key. UUID. */
  webhook_id: string;
  event_type: string;
  /** The JSON-serialisable domain payload. */
  payload: unknown;
}

export interface DeliveryOutcome {
  outcome: 'success' | 'failure' | 'timeout' | 'ssrf_blocked';
  httpStatus?: number;
  errorMessage?: string;
  /**
   * True when the outbox row moved to a terminal state (`done` on
   * success, `dead` on permanent-4xx or exhausted retries). False when
   * the row was reset to `pending` with a future `next_dispatch_at`.
   */
  terminal: boolean;
}

// ─── Internal types ──────────────────────────────────────────────────────

interface SubscriptionRow {
  id: string;
  url: string;
  secret_enc: Buffer;
  secret_secondary_enc: Buffer | null;
  active: boolean;
}

interface RuntimeConfig {
  perJobTimeoutMs: number;
  maxAttempts: number;
  responseBodyCap: number;
  userAgent: string;
}

// ─── Redis connection (mirror poller + queue-service) ────────────────────

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

// ─── Module state ────────────────────────────────────────────────────────

let worker: Worker | null = null;
let cachedTeardown: (() => Promise<void>) | null = null;
let runtimeConfig: RuntimeConfig = {
  perJobTimeoutMs: DEFAULT_PER_JOB_TIMEOUT_MS,
  maxAttempts: DEFAULT_MAX_ATTEMPTS,
  responseBodyCap: DEFAULT_RESPONSE_BODY_CAP_BYTES,
  userAgent: DEFAULT_USER_AGENT,
};

// ─── Undici Agent ────────────────────────────────────────────────────────
//
// Single shared Agent across all subscriptions for v0.4 volume. Per-sub
// isolation is a v0.5 concern (see plan §6 "Poison-pill URLs"). The
// connect/headers deadlines are set to the per-job budget so a host that
// accepts the SYN but never sends headers doesn't outrun `AbortSignal`.

let webhookAgent: Agent | null = null;

function getWebhookAgent(perJobTimeoutMs: number): Agent {
  if (!webhookAgent) {
    webhookAgent = new Agent({
      connectTimeout: perJobTimeoutMs,
      headersTimeout: perJobTimeoutMs,
      bodyTimeout: perJobTimeoutMs,
    });
  }
  return webhookAgent;
}

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * Start the delivery worker. Called from `app.ts` after
 * `initWebhookOutboxPoller`. Idempotent — a second call returns the
 * original teardown without starting a second worker.
 */
export async function initWebhookDeliveryWorker(
  opts: WebhookDeliveryOptions = {},
): Promise<() => Promise<void>> {
  if (cachedTeardown) {
    logger.debug('webhook-delivery worker already initialised — returning existing teardown');
    return cachedTeardown;
  }

  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
  runtimeConfig = {
    perJobTimeoutMs: opts.perJobTimeoutMs ?? DEFAULT_PER_JOB_TIMEOUT_MS,
    maxAttempts: opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    responseBodyCap: opts.responseBodyCap ?? DEFAULT_RESPONSE_BODY_CAP_BYTES,
    userAgent: opts.userAgent ?? DEFAULT_USER_AGENT,
  };

  // Eagerly build the Agent so the first job doesn't pay the allocation
  // inside the per-job timeout window.
  getWebhookAgent(runtimeConfig.perJobTimeoutMs);

  // Ensure the shared queue handle exists before the worker starts — the
  // poller may not have initialised yet in some embeddings (tests).
  getWebhookDeliveryQueue();

  worker = new Worker(
    WEBHOOK_DELIVERY_QUEUE,
    async (job: Job) => runWorkerJob(job),
    {
      connection: getRedisConnectionOpts(),
      concurrency,
    },
  );

  worker.on('error', (err) => {
    logger.error({ err }, 'webhook-delivery: worker error');
  });

  logger.info({ concurrency, ...runtimeConfig }, 'webhook-delivery: worker started');

  cachedTeardown = async () => {
    if (worker) {
      await worker.close().catch((err) => {
        logger.error({ err }, 'webhook-delivery: error closing worker');
      });
      worker = null;
    }
    if (webhookAgent) {
      await webhookAgent.close().catch(() => {
        /* best effort */
      });
      webhookAgent = null;
    }
    cachedTeardown = null;
    logger.info('webhook-delivery: worker stopped');
  };

  return cachedTeardown;
}

/**
 * Test-only: run one delivery against a real subscription row and a real
 * outbox row. Exposed so integration tests can drive the core per-job
 * flow without spinning up BullMQ.
 */
export async function __deliverOnce(
  outboxRow: OutboxJobData,
  overrides: WebhookDeliveryOptions = {},
): Promise<DeliveryOutcome> {
  const cfg: RuntimeConfig = {
    perJobTimeoutMs:
      overrides.perJobTimeoutMs ?? runtimeConfig.perJobTimeoutMs,
    maxAttempts: overrides.maxAttempts ?? runtimeConfig.maxAttempts,
    responseBodyCap:
      overrides.responseBodyCap ?? runtimeConfig.responseBodyCap,
    userAgent: overrides.userAgent ?? runtimeConfig.userAgent,
  };
  return deliverOne(outboxRow, cfg);
}

/**
 * Test-only: reset module state so a fresh test can start from a known
 * baseline. Does NOT close the queue handle (the poller module owns that).
 */
export function __resetWebhookDeliveryWorkerForTests(): void {
  worker = null;
  cachedTeardown = null;
  webhookAgent = null;
  runtimeConfig = {
    perJobTimeoutMs: DEFAULT_PER_JOB_TIMEOUT_MS,
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    responseBodyCap: DEFAULT_RESPONSE_BODY_CAP_BYTES,
    userAgent: DEFAULT_USER_AGENT,
  };
}

// ─── Worker entry point ─────────────────────────────────────────────────

/**
 * Translate a BullMQ job into the internal `OutboxJobData` shape. The
 * poller currently enqueues camelCase keys; we accept both forms so a
 * future schema tidy-up on the poller side doesn't break in-flight jobs.
 */
function normaliseJobData(raw: Record<string, unknown>): OutboxJobData | null {
  const outboxId =
    (raw.id as string | undefined) ?? (raw.outboxId as string | undefined);
  const subscriptionId =
    (raw.subscription_id as string | undefined) ??
    (raw.subscriptionId as string | undefined);
  const webhookId =
    (raw.webhook_id as string | undefined) ??
    (raw.webhookId as string | undefined);
  const eventType =
    (raw.event_type as string | undefined) ??
    (raw.eventType as string | undefined);
  const payload = raw.payload;

  if (!outboxId || !subscriptionId || !webhookId || !eventType) {
    return null;
  }
  return {
    id: outboxId,
    subscription_id: subscriptionId,
    webhook_id: webhookId,
    event_type: eventType,
    payload,
  };
}

async function runWorkerJob(job: Job): Promise<string> {
  const data = normaliseJobData(job.data as Record<string, unknown>);
  if (!data) {
    logger.error({ jobId: job.id, data: job.data }, 'webhook-delivery: malformed job data');
    return 'error:malformed';
  }
  const outcome = await deliverOne(data, runtimeConfig);
  // BullMQ job semantics: we swallow the retry inside the DB (updating
  // outbox.status + next_dispatch_at) rather than letting BullMQ retry
  // the job. Always return success to stop BullMQ from re-invoking us.
  return `${outcome.outcome}:${outcome.terminal ? 'terminal' : 'retry'}`;
}

// ─── Core delivery logic ────────────────────────────────────────────────

async function deliverOne(
  outbox: OutboxJobData,
  cfg: RuntimeConfig,
): Promise<DeliveryOutcome> {
  // Count prior attempts (webhook_deliveries rows) to figure out which
  // attempt number this is. Counting rows is the source of truth so a
  // retry after a crash gets the right number even if the outbox row
  // didn't record any in-flight metadata.
  const priorAttempts = await countPriorAttempts(outbox.id);
  const attemptNumber = priorAttempts + 1;

  // 1 — Load subscription. Missing / inactive → terminal dead.
  const subscription = await loadSubscription(outbox.subscription_id);
  if (!subscription || !subscription.active) {
    await recordDelivery({
      outboxId: outbox.id,
      subscriptionId: outbox.subscription_id,
      webhookId: outbox.webhook_id,
      attemptNumber,
      status: 'failure',
      errorMessage: 'subscription_missing_or_inactive',
      durationMs: 0,
    });
    await markOutboxDead(outbox.id);
    await emitAudit('WEBHOOK_DELIVERY_DEAD', outbox, {
      reason: 'subscription_missing_or_inactive',
      attemptNumber,
    });
    return {
      outcome: 'failure',
      errorMessage: 'subscription_missing_or_inactive',
      terminal: true,
    };
  }

  // 2 — Decrypt the primary secret. A decrypt failure is a
  // configuration problem that retrying won't fix — terminate dead.
  let secret: string;
  try {
    secret = decryptSubscriptionSecret(subscription.secret_enc);
  } catch (err) {
    const errorMessage = `secret_decrypt_failed: ${describeError(err)}`;
    await recordDelivery({
      outboxId: outbox.id,
      subscriptionId: outbox.subscription_id,
      webhookId: outbox.webhook_id,
      attemptNumber,
      status: 'failure',
      errorMessage,
      durationMs: 0,
    });
    await markOutboxDead(outbox.id);
    await emitAudit('WEBHOOK_DELIVERY_DEAD', outbox, {
      reason: 'secret_decrypt_failed',
      attemptNumber,
    });
    return { outcome: 'failure', errorMessage, terminal: true };
  }

  // 3 — SSRF guard. A block counts against the retry budget so a
  // persistently-misconfigured URL eventually lands in dead rather than
  // looping. Transient DNS flakes have a chance to recover on a later
  // attempt within the schedule.
  try {
    await assertNonSsrfUrl(subscription.url);
  } catch (err) {
    const isSsrf = err instanceof SsrfError;
    const errorMessage = describeError(err);
    await recordDelivery({
      outboxId: outbox.id,
      subscriptionId: outbox.subscription_id,
      webhookId: outbox.webhook_id,
      attemptNumber,
      status: isSsrf ? 'ssrf_blocked' : 'failure',
      errorMessage,
      durationMs: 0,
    });
    return finishRetryable(outbox, attemptNumber, cfg, {
      outcome: isSsrf ? 'ssrf_blocked' : 'failure',
      errorMessage,
    });
  }

  // 4 — Serialise payload deterministically for *this* request. The
  // receiver contract is that the byte-sequence fed to the signer is
  // the byte-sequence delivered — we do NOT canonicalise, receivers do.
  const body = JSON.stringify({
    type: outbox.event_type,
    data: outbox.payload,
  });

  // 5 — Sign.
  const now = new Date();
  const signedHeaders = signWebhook({
    secret,
    webhookId: outbox.webhook_id,
    timestamp: now,
    payload: body,
  });

  // 6 — POST via undici with two stacked deadlines.
  const start = Date.now();
  let response: Awaited<ReturnType<typeof undiciFetch>> | null = null;
  let thrown: unknown = null;
  try {
    response = await undiciFetch(subscription.url, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(cfg.perJobTimeoutMs),
      dispatcher: getWebhookAgent(cfg.perJobTimeoutMs),
      headers: {
        'content-type': 'application/json',
        'user-agent': cfg.userAgent,
        'X-Compendiq-Event': outbox.event_type,
        'webhook-id': signedHeaders['webhook-id'],
        'webhook-timestamp': signedHeaders['webhook-timestamp'],
        'webhook-signature': signedHeaders['webhook-signature'],
      },
      body,
    });
  } catch (err) {
    thrown = err;
  }
  const durationMs = Date.now() - start;

  // 7 — Classify the result.
  if (thrown) {
    const isTimeout = isAbortOrTimeout(thrown);
    const errorMessage = describeError(thrown);
    await recordDelivery({
      outboxId: outbox.id,
      subscriptionId: outbox.subscription_id,
      webhookId: outbox.webhook_id,
      attemptNumber,
      status: isTimeout ? 'timeout' : 'failure',
      errorMessage,
      durationMs,
    });
    return finishRetryable(outbox, attemptNumber, cfg, {
      outcome: isTimeout ? 'timeout' : 'failure',
      errorMessage,
    });
  }

  // response is non-null here
  const httpStatus = response!.status;
  const responseBody = await safeReadBody(response!, cfg.responseBodyCap);

  if (httpStatus >= 200 && httpStatus < 300) {
    await recordDelivery({
      outboxId: outbox.id,
      subscriptionId: outbox.subscription_id,
      webhookId: outbox.webhook_id,
      attemptNumber,
      status: 'success',
      httpStatus,
      responseBody,
      durationMs,
    });
    await markOutboxDone(outbox.id);
    return { outcome: 'success', httpStatus, terminal: true };
  }

  // Non-2xx — permanent vs retryable branch.
  await recordDelivery({
    outboxId: outbox.id,
    subscriptionId: outbox.subscription_id,
    webhookId: outbox.webhook_id,
    attemptNumber,
    status: 'failure',
    httpStatus,
    responseBody,
    errorMessage: `HTTP ${httpStatus}`,
    durationMs,
  });

  if (isPermanentFailureStatus(httpStatus)) {
    await markOutboxDead(outbox.id);
    await emitAudit('WEBHOOK_DELIVERY_DEAD', outbox, {
      reason: 'permanent_http_status',
      httpStatus,
      attemptNumber,
    });
    return {
      outcome: 'failure',
      httpStatus,
      errorMessage: `HTTP ${httpStatus}`,
      terminal: true,
    };
  }

  return finishRetryable(outbox, attemptNumber, cfg, {
    outcome: 'failure',
    httpStatus,
    errorMessage: `HTTP ${httpStatus}`,
  });
}

/**
 * Finalise a retryable-category failure: either schedule the next
 * attempt (update outbox back to `pending` with a future
 * `next_dispatch_at`) or — if the attempt budget is exhausted — mark
 * the row `dead` and emit `WEBHOOK_DELIVERY_DEAD`.
 *
 * A `WEBHOOK_DELIVERY_FAILED` audit is emitted on every non-terminal
 * retryable failure; `WEBHOOK_DELIVERY_DEAD` on the terminal one.
 */
async function finishRetryable(
  outbox: OutboxJobData,
  attemptNumber: number,
  cfg: RuntimeConfig,
  result: { outcome: DeliveryOutcome['outcome']; httpStatus?: number; errorMessage?: string },
): Promise<DeliveryOutcome> {
  if (attemptNumber >= cfg.maxAttempts) {
    await markOutboxDead(outbox.id);
    await emitAudit('WEBHOOK_DELIVERY_DEAD', outbox, {
      reason: 'attempts_exhausted',
      attemptNumber,
      outcome: result.outcome,
      httpStatus: result.httpStatus,
    });
    return { ...result, terminal: true };
  }

  const waitSeconds = backoffSeconds(attemptNumber);
  await reschedulePending(outbox.id, waitSeconds);
  await emitAudit('WEBHOOK_DELIVERY_FAILED', outbox, {
    attemptNumber,
    outcome: result.outcome,
    httpStatus: result.httpStatus,
    nextDispatchInSec: waitSeconds,
  });
  return { ...result, terminal: false };
}

// ─── Backoff table ──────────────────────────────────────────────────────

/**
 * Resolve the wait time (seconds) before the NEXT attempt after
 * `attemptNumber` failed. Clamps at the last table entry so callers that
 * (mis-)config `maxAttempts` beyond the table get a sensible fallback.
 */
export function backoffSeconds(attemptNumber: number): number {
  // attempt 1 failed → use slot [0]; attempt n failed → slot [n-1].
  const idx = Math.max(0, attemptNumber - 1);
  const clamped = Math.min(idx, BACKOFF_SECONDS.length - 1);
  return BACKOFF_SECONDS[clamped]!;
}

// ─── HTTP status classification ─────────────────────────────────────────

/**
 * 4xx responses are permanent by default EXCEPT 408 (Request Timeout)
 * and 429 (Too Many Requests) which are defined as retryable by the
 * relevant RFCs and the Standard Webhooks convention.
 */
function isPermanentFailureStatus(httpStatus: number): boolean {
  if (httpStatus < 400 || httpStatus >= 500) return false;
  if (httpStatus === 408 || httpStatus === 429) return false;
  return true;
}

function isAbortOrTimeout(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const name = (err as { name?: unknown }).name;
  const code = (err as { code?: unknown }).code;
  if (name === 'TimeoutError' || name === 'AbortError') return true;
  if (typeof code === 'string' && (code === 'UND_ERR_HEADERS_TIMEOUT' ||
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    code === 'UND_ERR_BODY_TIMEOUT' ||
    code === 'ABORT_ERR')) {
    return true;
  }
  return false;
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return String(err);
  } catch {
    return 'unknown error';
  }
}

async function safeReadBody(
  response: { text(): Promise<string> },
  cap: number,
): Promise<string> {
  try {
    const text = await response.text();
    return text.length > cap ? text.slice(0, cap) : text;
  } catch {
    return '';
  }
}

// ─── DB helpers ─────────────────────────────────────────────────────────

async function countPriorAttempts(outboxId: string): Promise<number> {
  const res = await getPool().query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM webhook_deliveries WHERE outbox_id = $1`,
    [outboxId],
  );
  return parseInt(res.rows[0]?.c ?? '0', 10);
}

async function loadSubscription(id: string): Promise<SubscriptionRow | null> {
  const res = await getPool().query<SubscriptionRow>(
    `SELECT id, url, secret_enc, secret_secondary_enc, active
       FROM webhook_subscriptions
      WHERE id = $1`,
    [id],
  );
  return res.rows[0] ?? null;
}

/**
 * `secret_enc` is a BYTEA column. We stored the versioned `encryptPat()`
 * ciphertext string as UTF-8 bytes, so reversing the path is one
 * `Buffer.toString('utf8')` + `decryptPat`. This keeps a single crypto
 * utility for the repo — no new AES primitives for webhooks.
 */
function decryptSubscriptionSecret(secretEnc: Buffer): string {
  const asText = secretEnc.toString('utf8');
  return decryptPat(asText);
}

async function markOutboxDone(outboxId: string): Promise<void> {
  await getPool().query(
    `UPDATE webhook_outbox SET status = 'done' WHERE id = $1`,
    [outboxId],
  );
}

async function markOutboxDead(outboxId: string): Promise<void> {
  await getPool().query(
    `UPDATE webhook_outbox SET status = 'dead' WHERE id = $1`,
    [outboxId],
  );
}

/**
 * Return the row to `pending` with `next_dispatch_at = NOW() + waitSec`
 * and clear the BullMQ jobId so the poller re-claims it cleanly.
 */
async function reschedulePending(outboxId: string, waitSec: number): Promise<void> {
  await getPool().query(
    `UPDATE webhook_outbox
        SET status = 'pending',
            next_dispatch_at = NOW() + ($2::text || ' seconds')::interval,
            dispatched_at = NULL,
            bullmq_job_id = NULL
      WHERE id = $1`,
    [outboxId, String(waitSec)],
  );
}

interface RecordDeliveryInput {
  outboxId: string;
  subscriptionId: string;
  webhookId: string;
  attemptNumber: number;
  status: 'success' | 'failure' | 'timeout' | 'ssrf_blocked';
  httpStatus?: number;
  responseBody?: string;
  errorMessage?: string;
  durationMs: number;
}

async function recordDelivery(input: RecordDeliveryInput): Promise<void> {
  await getPool().query(
    `INSERT INTO webhook_deliveries
        (outbox_id, subscription_id, webhook_id, attempt_number,
         status, http_status, response_body, error_message, duration_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      input.outboxId,
      input.subscriptionId,
      input.webhookId,
      input.attemptNumber,
      input.status,
      input.httpStatus ?? null,
      input.responseBody ?? null,
      input.errorMessage ?? null,
      input.durationMs,
    ],
  );
}

// ─── Audit ──────────────────────────────────────────────────────────────

async function emitAudit(
  action: 'WEBHOOK_DELIVERY_FAILED' | 'WEBHOOK_DELIVERY_DEAD',
  outbox: OutboxJobData,
  metadata: Record<string, unknown>,
): Promise<void> {
  await logAuditEvent(
    null,
    action,
    'webhook_subscription',
    outbox.subscription_id,
    {
      outboxId: outbox.id,
      webhookId: outbox.webhook_id,
      eventType: outbox.event_type,
      ...metadata,
    },
  );
}
