/**
 * Per-user security-state cache (#737).
 *
 * `authenticate` historically validated access tokens statelessly — `role`
 * came from the JWT payload and `deactivated_at` was only re-checked at
 * /login and /refresh. A deactivated or demoted user therefore kept full API
 * access until their access token expired (ACCESS_TOKEN_EXPIRY, env-tunable).
 *
 * This module gives the auth hot path a cheap liveness/role check:
 *
 *   - getUserSecurityState(userId) → active(role) | deactivated | missing |
 *     unknown. Backed by one `SELECT role, deactivated_at FROM users` per
 *     user per TTL window (30s); everything in between is a Map lookup.
 *   - invalidateUserSecurityState(userId) → clears the local entry AND
 *     publishes on the 'user:security:changed' cache-bus channel so peer
 *     pods drop their entries too (MULTI_INSTANCE deployments).
 *   - initUserSecurityCacheBus() → wires the subscriber + reconnect handler.
 *     Must run after initCacheBus(); idempotent (initProviderCacheBus
 *     precedent).
 *
 * Revocation-latency bound: on the pod that handles the admin action, and on
 * every pod reachable via the cache-bus, invalidation is immediate (the next
 * request re-reads from Postgres). Pods without a working bus fall back to
 * the TTL — at most USER_SECURITY_CACHE_TTL_MS (30s) of staleness, far below
 * any permitted access-token lifetime (capped at 24h in auth.ts).
 *
 * Soft-fail: DB errors return the stale last-known state when one exists,
 * otherwise 'unknown'. Callers treat 'unknown' as "proceed on token claims"
 * — mirroring the cached-setting precedent — so a transient DB blip cannot
 * turn into a 401 storm on the request hot path.
 */

import { query } from '../db/postgres.js';
import { logger } from '../utils/logger.js';
import { publish, subscribe, onReconnect } from './redis-cache-bus.js';

/** Upper bound on revocation latency for pods that miss the cache-bus event. */
export const USER_SECURITY_CACHE_TTL_MS = 30_000;

/** Safety valve so the cache cannot grow unbounded under adversarial subs. */
const MAX_ENTRIES = 10_000;

export type UserSecurityState =
  /** User exists and is active; `role` is the current DB role. */
  | { kind: 'active'; role: string }
  /** users.deactivated_at is set — reject the request. */
  | { kind: 'deactivated' }
  /** No users row for this id (hard-deleted) — reject the request. */
  | { kind: 'missing' }
  /** DB lookup failed and nothing cached — caller falls back to token claims. */
  | { kind: 'unknown' };

interface CacheEntry {
  state: UserSecurityState;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const pending = new Map<string, Promise<UserSecurityState>>();
let busWired = false;

export async function getUserSecurityState(userId: string): Promise<UserSecurityState> {
  const entry = cache.get(userId);
  if (entry && entry.expiresAt > Date.now()) {
    return entry.state;
  }

  // Stampede guard: concurrent requests for the same user during a cache
  // miss share a single in-flight query.
  const inFlight = pending.get(userId);
  if (inFlight) return inFlight;

  const load = loadFromDb(userId);
  pending.set(userId, load);
  return load;
}

async function loadFromDb(userId: string): Promise<UserSecurityState> {
  try {
    const res = await query<{ role: string; deactivated_at: Date | null }>(
      'SELECT role, deactivated_at FROM users WHERE id = $1',
      [userId],
    );
    const row = res.rows[0];
    const state: UserSecurityState = !row
      ? { kind: 'missing' }
      : row.deactivated_at !== null
        ? { kind: 'deactivated' }
        : { kind: 'active', role: row.role };

    if (cache.size >= MAX_ENTRIES) evictForSpace();
    cache.set(userId, { state, expiresAt: Date.now() + USER_SECURITY_CACHE_TTL_MS });
    return state;
  } catch (err) {
    logger.warn(
      { err, userId },
      'user-security-cache: lookup failed — soft-failing to last-known state',
    );
    // Keep serving the expired entry during a DB outage; the next request
    // retries the read. With no prior entry the caller proceeds on token
    // claims ('unknown') — same behaviour as before #737.
    const stale = cache.get(userId);
    return stale ? stale.state : { kind: 'unknown' };
  } finally {
    pending.delete(userId);
  }
}

function evictForSpace(): void {
  const now = Date.now();
  for (const [key, value] of cache) {
    if (value.expiresAt <= now) cache.delete(key);
  }
  // Still full of live entries → drop the oldest-inserted one (Map order).
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

/**
 * Drop the cached state for a user and broadcast the invalidation to peer
 * pods. Call after any privilege-boundary mutation (deactivate, reactivate,
 * role change, delete). The local delete makes the change effective on this
 * pod immediately; the publish covers the rest of the cluster (no-op in
 * single-pod mode, where the TTL is the backstop).
 */
export async function invalidateUserSecurityState(userId: string): Promise<void> {
  cache.delete(userId);
  await publish('user:security:changed', { userId });
}

/**
 * Wire the cluster subscriber. Idempotent — second call is a no-op. MUST be
 * called after `initCacheBus(app.redis)`; if the bus is inactive (single-pod
 * soft-fail) the subscription is a no-op and the TTL bounds staleness.
 */
export function initUserSecurityCacheBus(): void {
  if (busWired) return;
  busWired = true;

  subscribe<{ userId?: unknown }>('user:security:changed', (payload) => {
    const userId =
      payload && typeof payload === 'object' && typeof payload.userId === 'string'
        ? payload.userId
        : null;
    if (userId) {
      cache.delete(userId);
    } else {
      // Malformed advice — fail safe by re-reading everyone on next request.
      cache.clear();
    }
  });

  // Redis pub/sub does not replay messages missed during a disconnect, so
  // cold-flush everything once the bus is back.
  onReconnect(() => cache.clear());
}

/** Test seam: clear cached state so tests don't leak entries across cases. */
export function _resetForTests(): void {
  cache.clear();
  pending.clear();
  busWired = false;
}
