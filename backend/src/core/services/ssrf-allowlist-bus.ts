/**
 * Redis pub/sub glue for the SSRF allowlist (issue #306).
 *
 * Lives outside `ssrf-guard.ts` so that tree can stay a pure utility module
 * without importing the redis client library. This file is the only place
 * that knows about `client.duplicate()` — per node-redis v5, subscriber
 * connections cannot run commands, so a dedicated connection is required.
 */

import type { RedisClientType } from 'redis';
import { logger } from '../utils/logger.js';
import {
  SSRF_ALLOWLIST_CHANNEL,
  applyAllowlistEventLocal,
  setSsrfAllowlistPublisher,
  type SsrfAllowlistEvent,
} from '../utils/ssrf-guard.js';

let _subscriber: RedisClientType | null = null;

/**
 * Wire the main Redis client as the publisher and start a duplicated
 * subscriber connection that listens on `SSRF_ALLOWLIST_CHANNEL`.
 *
 * Returns a teardown function the caller should invoke on graceful shutdown.
 * Safe to call exactly once per pod; a second call is a no-op.
 *
 * Fails soft: if the subscriber can't connect or subscribe we log a warning
 * and fall back to single-pod mode (local state still works, mutations are
 * not propagated — matches the behaviour before #306).
 */
export async function initSsrfAllowlistBus(main: RedisClientType): Promise<() => Promise<void>> {
  if (_subscriber) {
    logger.debug('ssrf-allowlist-bus: already initialised — skipping');
    return noopTeardown;
  }

  // Wire the publisher BEFORE awaiting `subscriber.connect()` / `subscribe()`.
  //
  // Rationale (see PR #309 review, finding #2):
  //   - Mutations that race the subscriber setup (e.g. a sync worker adds a
  //     Confluence origin while we're still inside this init) will still be
  //     broadcast to peer pods — they simply apply the event and stay in sync.
  //     Our own local `allowedOrigins` is authoritative for this pod regardless.
  //   - If the subscriber later fails to connect or subscribe, the catch block
  //     unwires the publisher again and we fall back to single-pod mode. Any
  //     broadcasts that went out during the race window are correct on peers;
  //     the only cost is a slightly misleading log sequence.
  //   - The alternative (wire publisher only after `subscribe()` returns) would
  //     open a race in the other direction — a mutation between "subscriber
  //     ready" and "publisher set" would NOT propagate, which is worse for
  //     coherency. Current ordering is the safer trade-off.
  setSsrfAllowlistPublisher((channel, message) => main.publish(channel, message));

  let subscriber: RedisClientType;
  try {
    subscriber = main.duplicate() as RedisClientType;
    subscriber.on('error', (err) => {
      logger.error({ err }, 'ssrf-allowlist-bus: subscriber client error');
    });
    await subscriber.connect();
    await subscriber.subscribe(SSRF_ALLOWLIST_CHANNEL, (message) => {
      try {
        const event = JSON.parse(message) as SsrfAllowlistEvent;
        applyAllowlistEventLocal(event);
      } catch (err) {
        logger.warn({ err, message }, 'ssrf-allowlist-bus: failed to parse event');
      }
    });
  } catch (err) {
    logger.warn(
      { err },
      'ssrf-allowlist-bus: subscriber init failed — falling back to single-pod mode',
    );
    setSsrfAllowlistPublisher(null);
    return noopTeardown;
  }

  _subscriber = subscriber;
  logger.info({ channel: SSRF_ALLOWLIST_CHANNEL }, 'ssrf-allowlist-bus: subscriber active');

  return async () => {
    if (!_subscriber) return;
    try {
      await _subscriber.unsubscribe(SSRF_ALLOWLIST_CHANNEL);
      await _subscriber.quit();
    } catch (err) {
      logger.warn({ err }, 'ssrf-allowlist-bus: teardown failed');
    } finally {
      _subscriber = null;
      setSsrfAllowlistPublisher(null);
    }
  };
}

async function noopTeardown(): Promise<void> {
  /* nothing to tear down */
}
