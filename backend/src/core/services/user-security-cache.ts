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
 * every pod reachable via the cache-bus, invalidation is immediate — the
 * next lookup re-reads from Postgres, and a per-user generation fence stops
 * an in-flight load (whose SELECT may have snapshotted pre-COMMIT state)
 * from re-caching the stale result after the invalidation ran. Requests
 * already awaiting that in-flight load may still see the pre-mutation state
 * once — they raced the admin action either way — but it is never cached.
 * Pods without a working bus fall back to the TTL — at most
 * USER_SECURITY_CACHE_TTL_MS (30s) of staleness, far below any permitted
 * access-token lifetime (clamped to 24h in auth.ts).
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

// Invalidation fence (#756 review). An invalidation that lands while a
// loadFromDb SELECT is in flight cannot recall that query — and the row it
// read may predate the invalidating transaction's COMMIT. Without a fence
// the load would `cache.set` the stale "active/old-role" result AFTER the
// invalidation ran, re-caching it for a full TTL window on the very pod
// that handled the admin action. Every invalidation therefore bumps a
// per-user generation (full-cache clears bump `clearGeneration`); a load
// snapshots the fence before its SELECT and skips `cache.set` when the
// fence moved. `userGenerations` is never pruned — it only grows via
// admin privilege mutations on real user ids, so its size is bounded by
// the user count.
const userGenerations = new Map<string, number>();
let clearGeneration = 0;

interface InvalidationFence {
  userGeneration: number;
  clearGeneration: number;
}

function snapshotFence(userId: string): InvalidationFence {
  return {
    userGeneration: userGenerations.get(userId) ?? 0,
    clearGeneration,
  };
}

function fenceMoved(userId: string, before: InvalidationFence): boolean {
  return (
    (userGenerations.get(userId) ?? 0) !== before.userGeneration ||
    clearGeneration !== before.clearGeneration
  );
}

/** Local-pod part of an invalidation: drop the entry, fence the in-flight
 * load (its result may be a pre-COMMIT snapshot) and detach it from
 * `pending` so the next lookup starts a fresh post-COMMIT read instead of
 * joining the stale one. */
function invalidateLocal(userId: string): void {
  cache.delete(userId);
  pending.delete(userId);
  userGenerations.set(userId, (userGenerations.get(userId) ?? 0) + 1);
}

function clearAllLocal(): void {
  cache.clear();
  pending.clear();
  clearGeneration += 1;
}

export async function getUserSecurityState(userId: string): Promise<UserSecurityState> {
  const entry = cache.get(userId);
  if (entry && entry.expiresAt > Date.now()) {
    return entry.state;
  }

  // Stampede guard: concurrent requests for the same user during a cache
  // miss share a single in-flight query.
  const inFlight = pending.get(userId);
  if (inFlight) return inFlight;

  const load = loadFromDb(userId).finally(() => {
    // Only deregister our own load — an invalidation may have already
    // removed it and a newer (post-COMMIT) load may have taken the slot.
    if (pending.get(userId) === load) pending.delete(userId);
  });
  pending.set(userId, load);
  return load;
}

async function loadFromDb(userId: string): Promise<UserSecurityState> {
  const fence = snapshotFence(userId);
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

    // An invalidation landed while the SELECT was in flight → our row may be
    // a pre-COMMIT snapshot. Return it to the callers that were already
    // waiting (they raced the admin action either way) but do NOT cache it;
    // the next lookup re-reads the committed state.
    if (!fenceMoved(userId, fence)) {
      if (cache.size >= MAX_ENTRIES) evictForSpace();
      cache.set(userId, { state, expiresAt: Date.now() + USER_SECURITY_CACHE_TTL_MS });
    }
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
 * role change, delete). The local invalidation makes the change effective on
 * this pod immediately — it also fences any in-flight DB load whose SELECT
 * may have snapshotted pre-COMMIT state, so the stale result cannot be
 * re-cached afterwards. The publish covers the rest of the cluster (no-op in
 * single-pod mode, where the TTL is the backstop).
 */
export async function invalidateUserSecurityState(userId: string): Promise<void> {
  invalidateLocal(userId);
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
      invalidateLocal(userId);
    } else {
      // Malformed advice — fail safe by re-reading everyone on next request.
      clearAllLocal();
    }
  });

  // Redis pub/sub does not replay messages missed during a disconnect, so
  // cold-flush everything once the bus is back.
  onReconnect(() => clearAllLocal());
}

/** Test seam: clear cached state so tests don't leak entries across cases. */
export function _resetForTests(): void {
  cache.clear();
  pending.clear();
  userGenerations.clear();
  clearGeneration = 0;
  busWired = false;
}
