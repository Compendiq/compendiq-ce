// backend/src/domains/llm/services/cache-bus.ts
//
// LLM provider cache-bus — delegates fan-out to the generic Redis pub/sub
// bus (`core/services/redis-cache-bus.ts`) so provider-config invalidation
// propagates across every replica in a multi-pod deployment. This module
// is the call-site adapter between the LLM domain (resolver configCache,
// per-provider circuit breakers, undici dispatcher pools) and the cluster
// channels `provider:cache:bump` and `provider:deleted`.
//
// Sub-PR 1d of Compendiq/compendiq-ee#113. Replaces the previous
// process-local Set fan-out that silently desynced across replicas.
//
// ── Semantics (load-bearing, see ADR-024) ─────────────────────────────
//
// 1. **At-most-once delivery.** Pub/sub does not persist messages. A pod
//    that is reconnecting at the moment a bump or delete is published
//    will not see it. Subscribers cold-reload from Postgres after every
//    reconnect (handled at the `redis-cache-bus.onReconnect` level by the
//    resolver and any downstream cached state). The payload is advisory
//    only — handlers re-read from the authoritative store. The deleted-id
//    payload carries `providerId` strictly to scope the cleanup work, not
//    as state to "trust".
//
// 2. **Soft-fail to local fan-out.** When `isCacheBusActive()` is false
//    (single-pod dev, single-replica prod, transient Redis outage during
//    boot), we fall back to a process-local listener registry so existing
//    single-pod tests and request paths continue to work. `initCacheBus`
//    soft-fails to inactive on subscriber-init failure (see
//    `redis-cache-bus.ts` for that pathway), which is exactly the surface
//    we depend on here.
//
// 3. **Per-pod version counter (Option A).** `getProviderCacheVersion()`
//    returns a strictly-increasing per-pod counter. It is incremented
//    locally on every direct `bumpProviderCacheVersion()` call AND inside
//    the cluster-bus subscribe handler when a remote bump arrives, so
//    every pod observes "version went up — invalidate" deterministically.
//    The number itself is NOT cluster-coherent (pod A's version 7 may
//    align to pod B's version 4); only its monotone-increasing property
//    on a given pod is contractual. The resolver's configCache uses this
//    counter as a "did anything change since I last looked?" tripwire,
//    which works fine with per-pod monotonicity.
//
// 4. **Boot-path subscribe-vs-publish race (benign).** `subscribe()` is
//    fire-and-forget — node-redis acks the SUBSCRIBE asynchronously. If a
//    `bumpProviderCacheVersion()` runs between `initProviderCacheBus()`
//    and the subscriber being acked, the publishing pod will not see its
//    own bump (peer pods will). In practice this happens only on the
//    boot-path call from `bootstrapLlmProviders()`, where the local
//    `configCache` is empty anyway — there's nothing to invalidate. The
//    next direct `resolveUsecase()` reads from DB regardless because the
//    cached entry is missing. We accept the small window rather than
//    awaiting an opaque ack handshake; redis-cache-bus's `onReconnect`
//    hook handles the steady-state reconnection case separately.
//
// Existing exports preserved:
//   - bumpProviderCacheVersion()  → Promise<void>  (was sync)
//   - emitProviderDeleted(id)     → Promise<void>  (was sync)
//   - getProviderCacheVersion()   → number         (unchanged)
//   - onProviderCacheBump(l)      → unsubscribe    (unchanged)
//   - onProviderDeleted(l)        → unsubscribe    (unchanged)
//
// New export:
//   - initProviderCacheBus()      → wires the cluster subscriber. Must run
//                                   AFTER initCacheBus() and BEFORE the
//                                   first `bumpProviderCacheVersion()`
//                                   (e.g. before bootstrapLlmProviders()).

import {
  isCacheBusActive,
  publish,
  subscribe,
} from '../../../core/services/redis-cache-bus.js';
import { logger } from '../../../core/utils/logger.js';

let version = 0;

type Listener = (v: number) => void;
type DeletedListener = (id: string) => void;

const listeners = new Set<Listener>();
const deletedListeners = new Set<DeletedListener>();

/**
 * Wire the cluster subscriber. Idempotent — second call is a no-op so
 * test harnesses (or hot-reload during dev) don't double-register.
 *
 * MUST be called after `initCacheBus(app.redis)` so the bus state is
 * available; if the bus is inactive (single-pod soft-fail), this is a
 * no-op and the module operates in pure local-fan-out mode.
 */
let initialised = false;
export function initProviderCacheBus(): void {
  if (initialised) return;
  initialised = true;

  // Bus inactive → pure local mode. The subscribe() calls below would be
  // no-ops anyway (returns the noop unsubscribe), but skipping them keeps
  // the intent explicit and avoids a misleading "subscriber wired" log
  // in single-pod runs.
  if (!isCacheBusActive()) {
    logger.debug('llm cache-bus: single-pod mode (redis-cache-bus inactive) — local fan-out only');
    return;
  }

  // provider:cache:bump → bump the per-pod version, fan out to local listeners.
  subscribe<{ at?: number }>('provider:cache:bump', () => {
    version += 1;
    for (const l of listeners) {
      try {
        l(version);
      } catch (err) {
        logger.warn({ err }, 'llm cache-bus: bump listener threw on remote event');
      }
    }
  });

  // provider:deleted → fan out the providerId to local listeners.
  subscribe<{ providerId: string }>('provider:deleted', (payload) => {
    const id = payload?.providerId;
    if (typeof id !== 'string' || id.length === 0) {
      logger.warn({ payload }, 'llm cache-bus: provider:deleted payload missing providerId — ignoring');
      return;
    }
    for (const l of deletedListeners) {
      try {
        l(id);
      } catch (err) {
        logger.warn({ err, id }, 'llm cache-bus: deleted listener threw on remote event');
      }
    }
  });

  logger.info('llm cache-bus: cluster subscriber wired (provider:cache:bump, provider:deleted)');
}

/**
 * Bump the provider-config version. In multi-pod mode publishes on
 * `provider:cache:bump`; the local subscriber path bumps the per-pod
 * counter and fires local listeners. In single-pod mode (`isCacheBusActive()
 * === false`) we bump + fan out locally with no publish.
 *
 * Returns a Promise<void> because the cluster publish is async; callers
 * must `await` so a publish failure surfaces in logs from the calling
 * context rather than as an unhandled rejection.
 */
export async function bumpProviderCacheVersion(): Promise<void> {
  if (isCacheBusActive()) {
    // In cluster mode, the local pod also receives its own publish via the
    // subscriber path (Redis pub/sub fans back to all subscribers, including
    // the publisher). The version bump and listener fan-out happen inside
    // the subscribe handler — no need to do it here as well.
    await publish('provider:cache:bump', { at: Date.now() });
    return;
  }

  // Single-pod fallback: bump + fan out locally so existing tests and
  // single-replica deployments keep their semantics.
  version += 1;
  for (const l of listeners) {
    try {
      l(version);
    } catch (err) {
      logger.warn({ err }, 'llm cache-bus: bump listener threw');
    }
  }
}

export function getProviderCacheVersion(): number {
  return version;
}

export function onProviderCacheBump(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

// ─── Provider deletion (issue #267) ──────────────────────────────────────────
// Carries the deleted providerId so subscribers can drop per-id resources
// (circuit breakers, undici dispatchers, config-cache entries) that a plain
// `bumpProviderCacheVersion()` would miss. The bump listener only iterates
// the resolver's `configCache`; a provider whose breaker was created via
// "Test connection" before any use-case assignment is NOT in that cache and
// would otherwise leak forever. Emitted only from `deleteProvider()`.

/**
 * Emit a provider-deletion event. Cluster mode publishes on
 * `provider:deleted`; local pod receives the event via its own subscriber.
 * Single-pod mode fans out to local listeners directly.
 */
export async function emitProviderDeleted(id: string): Promise<void> {
  if (isCacheBusActive()) {
    await publish('provider:deleted', { providerId: id });
    return;
  }

  // Single-pod fallback.
  for (const l of deletedListeners) {
    try {
      l(id);
    } catch (err) {
      logger.warn({ err, id }, 'llm cache-bus: deleted listener threw');
    }
  }
}

export function onProviderDeleted(l: DeletedListener): () => void {
  deletedListeners.add(l);
  return () => deletedListeners.delete(l);
}
