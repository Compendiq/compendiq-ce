/**
 * Generic cluster-wide cache-bus over Redis pub/sub (v0.4 epic §3.1).
 *
 * Primitives:
 *   - publish(channel, payload)   -> writes JSON-encoded payload on `main.publish`
 *   - subscribe(channel, handler) -> fires handler(parsed) on incoming messages;
 *                                    returns an unsubscribe function
 *   - onReconnect(handler)        -> fires after the subscriber reconnects
 *                                    (NOT on initial connect), so cached settings
 *                                    can cold-reload from Postgres
 *   - close()                     -> unsubscribes, quits the subscriber, unwires publisher
 *
 * Contract (cluster semantics):
 *   - At-most-once delivery; payloads are invalidation advice only. Subscribers
 *     treat each event as "go re-read from the authoritative store" and never
 *     trust state embedded in the payload.
 *   - On startup and after reconnect, subscribers cold-load from the store
 *     unconditionally. There is no missed-message catch-up.
 *
 * Soft-fail: if the subscriber cannot connect or subscribe, the bus falls back
 * to single-pod mode. publish() becomes a no-op; subscribe() returns a noop
 * unsubscribe. This matches the ssrf-allowlist-bus (issue #306) precedent and
 * keeps single-pod deployments (or a Redis outage) from cascading into hard
 * errors on every request.
 *
 * node-redis v5 note: a subscriber connection cannot also issue commands, so
 * we `main.duplicate()` a dedicated subscriber. Re-subscription after a
 * transient disconnect is handled by node-redis automatically.
 */

import type { RedisClientType } from 'redis';
import { logger } from '../utils/logger.js';

// Closed union of every channel the generic cache-bus carries. Lifted
// verbatim from epic §3.1 (.plans/v0.4-epic-2026-04.md in the EE repo);
// future features extend this list in the same PR they add the publisher.
export type CacheBusChannel =
  | 'provider:cache:bump'
  | 'provider:deleted'
  | 'admin:llm:settings'
  | 'ip_allowlist:changed'
  | 'confluence:allowlist:changed'
  | 'sync:conflict:policy:changed'
  | 'pii:policy:changed'
  | 'license:changed';

type Handler<T = unknown> = (payload: T) => void | Promise<void>;

interface BusState {
  main: RedisClientType;
  subscriber: RedisClientType;
  handlers: Map<CacheBusChannel, Set<Handler>>;
  redisSubscribed: Set<CacheBusChannel>;
  reconnectHandlers: Set<() => void | Promise<void>>;
  /** Skip the first 'ready' event — that's the initial connect, not a reconnect. */
  readySeen: boolean;
  active: boolean;
}

let state: BusState | null = null;

/**
 * Initialise the cache-bus with the given main Redis client. Returns a
 * teardown function; also exposed as `close()` for symmetry with the epic
 * §3.1 API.
 *
 * Second call while a bus is alive is a no-op and returns the original
 * teardown.
 */
export async function initCacheBus(main: RedisClientType): Promise<() => Promise<void>> {
  if (state) {
    logger.debug('redis-cache-bus: already initialised — skipping');
    return close;
  }

  // All subscriber setup — including `duplicate()` and event wiring — must
  // live inside the try/catch so a broken/mocked main client soft-fails to
  // single-pod mode instead of throwing synchronously. Mirrors the pattern
  // established by `ssrf-allowlist-bus.ts` (issue #306).
  let bootState: BusState;
  try {
    const subscriber = main.duplicate() as RedisClientType;

    bootState = {
      main,
      subscriber,
      handlers: new Map(),
      redisSubscribed: new Set(),
      reconnectHandlers: new Set(),
      readySeen: false,
      active: false,
    };

    subscriber.on('error', (err: unknown) => {
      logger.error({ err }, 'redis-cache-bus: subscriber client error');
    });

    subscriber.on('ready', () => {
      if (!bootState.readySeen) {
        bootState.readySeen = true;
        return;
      }
      for (const fn of bootState.reconnectHandlers) {
        try {
          const res = fn();
          if (res && typeof (res as Promise<void>).catch === 'function') {
            (res as Promise<void>).catch((err) => {
              logger.warn({ err }, 'redis-cache-bus: reconnect handler rejected');
            });
          }
        } catch (err) {
          logger.warn({ err }, 'redis-cache-bus: reconnect handler threw');
        }
      }
    });

    await subscriber.connect();
  } catch (err) {
    logger.warn(
      { err },
      'redis-cache-bus: subscriber init failed — falling back to single-pod mode',
    );
    return close;
  }

  bootState.active = true;
  state = bootState;

  logger.info('redis-cache-bus: active');
  return close;
}

export function isCacheBusActive(): boolean {
  return state?.active === true;
}

/**
 * Publish a JSON-encoded invalidation advice on the given channel. In
 * single-pod mode (bus inactive), this is a no-op.
 */
export async function publish(channel: CacheBusChannel, payload: unknown): Promise<void> {
  if (!state?.active) return;
  try {
    await state.main.publish(channel, JSON.stringify(payload));
  } catch (err) {
    logger.warn({ err, channel }, 'redis-cache-bus: publish failed');
  }
}

/**
 * Subscribe a handler to a channel. First subscription on a channel registers
 * the Redis SUBSCRIBE; subsequent subscriptions share the same Redis channel
 * and dispatch in-process to all registered handlers.
 *
 * Returns an unsubscribe function. In single-pod mode, returns a noop
 * unsubscribe; the handler will never fire.
 */
export function subscribe<T = unknown>(
  channel: CacheBusChannel,
  handler: Handler<T>,
): () => void {
  if (!state?.active) return noop;

  let handlers = state.handlers.get(channel);
  if (!handlers) {
    handlers = new Set();
    state.handlers.set(channel, handlers);
  }
  handlers.add(handler as Handler);

  if (!state.redisSubscribed.has(channel)) {
    state.redisSubscribed.add(channel);
    void state.subscriber
      .subscribe(channel, (message: string) => dispatch(channel, message))
      .catch((err: unknown) => {
        logger.warn({ err, channel }, 'redis-cache-bus: subscribe failed — handler inert for this channel');
        state?.redisSubscribed.delete(channel);
      });
  }

  return () => {
    const set = state?.handlers.get(channel);
    if (set) set.delete(handler as Handler);
  };
}

/**
 * Register a handler to run after the subscriber reconnects. Callers use this
 * to cold-reload cached state from Postgres once the bus is back (missed
 * invalidation messages during the disconnect window are not replayed).
 *
 * Returns an unsubscribe function.
 */
export function onReconnect(handler: () => void | Promise<void>): () => void {
  if (!state) return noop;
  state.reconnectHandlers.add(handler);
  return () => {
    state?.reconnectHandlers.delete(handler);
  };
}

/**
 * Tear down the bus: unsubscribe all Redis channels, quit the subscriber,
 * clear local state. Safe to call multiple times or when not initialised.
 */
export async function close(): Promise<void> {
  const s = state;
  if (!s) return;
  state = null;

  if (s.redisSubscribed.size > 0) {
    try {
      await s.subscriber.unsubscribe();
    } catch (err) {
      logger.warn({ err }, 'redis-cache-bus: unsubscribe failed during close');
    }
  }
  try {
    await s.subscriber.quit();
  } catch (err) {
    logger.warn({ err }, 'redis-cache-bus: subscriber quit failed');
  }
}

function dispatch(channel: CacheBusChannel, message: string): void {
  const handlers = state?.handlers.get(channel);
  if (!handlers || handlers.size === 0) return;

  let payload: unknown;
  try {
    payload = JSON.parse(message);
  } catch (err) {
    logger.warn({ err, channel, message }, 'redis-cache-bus: failed to parse event');
    return;
  }

  for (const handler of handlers) {
    try {
      const res = handler(payload);
      if (res && typeof (res as Promise<void>).catch === 'function') {
        (res as Promise<void>).catch((err) => {
          logger.warn({ err, channel }, 'redis-cache-bus: async handler rejected');
        });
      }
    } catch (err) {
      logger.warn({ err, channel }, 'redis-cache-bus: handler threw');
    }
  }
}

function noop(): void {
  /* no-op unsubscribe for single-pod mode */
}
