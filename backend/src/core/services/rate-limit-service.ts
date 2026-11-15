import { query } from '../db/postgres.js';
import { logger } from '../utils/logger.js';
import { logAuditEvent } from './audit-service.js';

// ─── Rate limit categories ────────────────────────────────────────────────────

interface RateLimitConfig {
  max: number;
  timeWindow: string;
}

interface RateLimits {
  global: RateLimitConfig;
  auth: RateLimitConfig;
  admin: RateLimitConfig;
  llmStream: RateLimitConfig;
  llmEmbedding: RateLimitConfig;
}

// ─── Defaults (hardcoded fallbacks) ───────────────────────────────────────────

const DEFAULTS: RateLimits = {
  // 100/min was too tight for a SPA: each Pages-list mount fires ~6 GETs
  // (list, filters, spaces, settings, pinned, embeddings status), so ~17
  // navigations in a minute already exhausted the budget and left
  // TanStack queries stuck in error state after retry exhaustion.
  global:       { max: 300, timeWindow: '1 minute' },
  auth:         { max: 5,   timeWindow: '1 minute' },
  admin:        { max: 20,  timeWindow: '1 minute' },
  llmStream:    { max: 10,  timeWindow: '1 minute' },
  llmEmbedding: { max: 5,   timeWindow: '1 minute' },
};

// Security floor: auth rate limits cannot go below this to prevent brute-force
const AUTH_MIN_FLOOR = 3;

// ─── DB keys ──────────────────────────────────────────────────────────────────

const RATE_LIMIT_KEYS = [
  'rate_limit_global_max',
  'rate_limit_auth_max',
  'rate_limit_admin_max',
  'rate_limit_llm_stream_max',
  'rate_limit_llm_embedding_max',
] as const;

// ─── In-process TTL cache with a soft-failing refresh (#1755) ─────────────────
//
// `getRateLimits()` sits on every rate-limited request (the global limiter's
// `max` and every per-route limit call it), and `@fastify/rate-limit` awaits
// `max()` outside its `skipOnError` guard. So the getter never rejects and
// never waits long: when the settings read fails or hangs it serves the last
// successfully loaded value (else DEFAULTS, which carry the auth floor), and
// the database sees one attempt per retry window instead of one per request.

// How long a successfully loaded value is served without touching the database.
const CACHE_TTL_MS = 60_000;
// After a failed read, no new attempt before this much time has passed: during
// an outage the database is asked once per window per process, not per request.
const FAILURE_RETRY_MS = 10_000;
// Longest a caller waits for an attempt (shared deadline from its start) before
// it is answered with the fallback; bounds request latency on a hanging database.
const REFRESH_WAIT_MS = 1_000;
// An attempt that has not settled this long after its start no longer blocks
// new attempts: a query on a stalled connection can stay pending for minutes
// (no statement timeout or keepAlive by default), and refreshes must not wait
// that long. Released lazily, by the next caller.
const REFRESH_ABANDON_MS = 30_000;

type AttemptOutcome = { ok: true; value: RateLimits } | { ok: false };

interface RefreshAttempt {
  startedAt: number;
  /** Resolves when the read settles; never rejects (no unhandled rejection). */
  outcome: Promise<AttemptOutcome>;
}

/** Last successfully loaded value; kept after expiry as the last-good fallback. */
let cache: { value: RateLimits; expiresAt: number } | null = null;
/** The one attempt allowed to apply its result (single-flight slot). */
let inFlight: RefreshAttempt | null = null;
/** Earliest time a new attempt may start after a failed one. */
let retryAt = 0;
/** Bumped by every write; an attempt started under an older generation is discarded. */
let generation = 0;

async function loadRateLimits(): Promise<RateLimits> {
  const result = await query<{ setting_key: string; setting_value: string }>(
    `SELECT setting_key, setting_value FROM admin_settings WHERE setting_key = ANY($1::text[])`,
    [RATE_LIMIT_KEYS as unknown as string[]],
  );

  const map: Record<string, string> = {};
  for (const row of result.rows) {
    map[row.setting_key] = row.setting_value;
  }

  return {
    global:       { max: parseInt(map['rate_limit_global_max'] ?? '', 10) || DEFAULTS.global.max, timeWindow: '1 minute' },
    auth:         { max: Math.max(AUTH_MIN_FLOOR, parseInt(map['rate_limit_auth_max'] ?? '', 10) || DEFAULTS.auth.max), timeWindow: '1 minute' },
    admin:        { max: parseInt(map['rate_limit_admin_max'] ?? '', 10) || DEFAULTS.admin.max, timeWindow: '1 minute' },
    llmStream:    { max: parseInt(map['rate_limit_llm_stream_max'] ?? '', 10) || DEFAULTS.llmStream.max, timeWindow: '1 minute' },
    llmEmbedding: { max: parseInt(map['rate_limit_llm_embedding_max'] ?? '', 10) || DEFAULTS.llmEmbedding.max, timeWindow: '1 minute' },
  };
}

/**
 * Start a read that takes the in-flight slot. Its result takes effect only
 * while it still owns the slot under the generation it started in; an attempt
 * that was abandoned or released by `upsertRateLimits()` changes nothing when
 * it settles late (neither the cache nor `retryAt`) and reports a failure, so
 * no caller is handed a superseded value.
 */
function startAttempt(): RefreshAttempt {
  const startedGeneration = generation;
  const attempt = { startedAt: Date.now() } as RefreshAttempt;
  const ownsSlot = () => inFlight === attempt && generation === startedGeneration;

  attempt.outcome = loadRateLimits().then(
    (value): AttemptOutcome => {
      if (!ownsSlot()) return { ok: false };
      cache = { value, expiresAt: Date.now() + CACHE_TTL_MS };
      retryAt = 0;
      inFlight = null;
      return { ok: true, value };
    },
    (err: unknown): AttemptOutcome => {
      if (!ownsSlot()) return { ok: false };
      logger.warn({ err }, 'rate-limit settings read failed — serving the last loaded limits (or defaults)');
      retryAt = Date.now() + FAILURE_RETRY_MS;
      inFlight = null;
      return { ok: false };
    },
  );
  return attempt;
}

/** Wait for `attempt` until its shared deadline; `fallback` if it does not deliver a value by then. */
async function awaitAttempt(attempt: RefreshAttempt, fallback: RateLimits): Promise<RateLimits> {
  const remaining = attempt.startedAt + REFRESH_WAIT_MS - Date.now();
  if (remaining <= 0) return fallback;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<AttemptOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false }), remaining);
    timer.unref();
  });
  try {
    const outcome = await Promise.race([attempt.outcome, deadline]);
    return outcome.ok ? outcome.value : fallback;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Getter ───────────────────────────────────────────────────────────────────

/** Never rejects; waits at most `REFRESH_WAIT_MS` for a refresh. */
export async function getRateLimits(): Promise<RateLimits> {
  const now = Date.now();
  if (cache && now < cache.expiresAt) {
    return cache.value;
  }

  // Last-good beats DEFAULTS so an outage never loosens an admin-tightened limit.
  const fallback = cache?.value ?? DEFAULTS;

  if (inFlight && now - inFlight.startedAt > REFRESH_ABANDON_MS) {
    logger.warn(
      { startedAt: new Date(inFlight.startedAt).toISOString() },
      'rate-limit settings read did not settle — abandoning it and allowing a new attempt',
    );
    inFlight = null;
  }
  if (!inFlight) {
    if (now < retryAt) return fallback;
    inFlight = startAttempt();
  }
  return awaitAttempt(inFlight, fallback);
}

// ─── Setter ───────────────────────────────────────────────────────────────────

type RateLimitUpdate = Partial<Record<keyof RateLimits, number>>;

const KEY_MAP: Record<keyof RateLimits, string> = {
  global: 'rate_limit_global_max',
  auth: 'rate_limit_auth_max',
  admin: 'rate_limit_admin_max',
  llmStream: 'rate_limit_llm_stream_max',
  llmEmbedding: 'rate_limit_llm_embedding_max',
};

export async function upsertRateLimits(updates: RateLimitUpdate, userId?: string): Promise<void> {
  // Enforce auth floor
  if (updates.auth !== undefined && updates.auth < AUTH_MIN_FLOOR) {
    updates.auth = AUTH_MIN_FLOOR;
  }

  for (const [category, max] of Object.entries(updates)) {
    if (max === undefined) continue;
    const key = KEY_MAP[category as keyof RateLimits];
    if (!key) continue;

    await query(
      `INSERT INTO admin_settings (setting_key, setting_value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (setting_key) DO UPDATE SET setting_value = $2, updated_at = NOW()`,
      [key, String(max)],
    );
  }

  // Invalidate: a pre-write attempt can neither be joined nor repopulate the
  // cache, and the next read starts a fresh one. The old value stays only as
  // the last-good fallback until that read succeeds.
  generation += 1;
  inFlight = null;
  retryAt = 0;
  if (cache) cache = { value: cache.value, expiresAt: 0 };

  if (userId) {
    await logAuditEvent(
      userId,
      'ADMIN_ACTION',
      'admin_settings',
      undefined,
      { action: 'update_rate_limits', changedCategories: Object.keys(updates) },
    );
  }
}

/** Exposed for testing */
export function _resetCache(): void {
  cache = null;
  inFlight = null;
  retryAt = 0;
  // Bumped rather than zeroed so an attempt from before the reset can never apply.
  generation += 1;
}
