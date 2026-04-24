/**
 * Real-time presence service (issue #301).
 *
 * Backs the "ghost avatar" indicator on a page view. Each viewer sends a
 * heartbeat every ~10s; active viewers are whoever has a heartbeat within the
 * last 20 seconds. Cross-pod fan-out is via Redis pub/sub on a dedicated
 * subscriber connection (node-redis v5 requires a separate connection for
 * pub/sub — commands and subscribe cannot share a client).
 *
 * Key layout (see issue #301):
 *   presence:viewers:{pageId}  ZSET, member=userId, score=unix-seconds, EXPIRE 30s
 *   presence:editing:{pageId}  SET of userIds currently editing, EXPIRE 30s
 *   presence:meta:{userId}     HASH (name, role), EXPIRE 90s
 *   presence:page:{pageId}     pub/sub channel, payload = JSON viewer list
 *
 * Active-viewer filter: ZRANGEBYSCORE with floor = now - ACTIVE_WINDOW_SEC.
 *
 * Subscriber lifecycle: a single duplicated Redis connection per process
 * runs PSUBSCRIBE on `presence:page:*`. In-process listeners are tracked in
 * a Map<pageId, Set<listener>> — SSE routes register/unregister themselves.
 */

import type { RedisClientType } from 'redis';
import { logger } from '../utils/logger.js';

/** Heartbeat entries within this many seconds count as "active". */
export const ACTIVE_WINDOW_SEC = 20;

/** TTL on the per-page ZSET key — last-resort eviction if a heartbeat never arrives. */
export const VIEWERS_TTL_SEC = 30;

/** TTL on the per-user meta HASH — refreshed on every heartbeat. */
export const META_TTL_SEC = 90;

function viewersKey(pageId: string): string {
  return `presence:viewers:${pageId}`;
}

function editingKey(pageId: string): string {
  return `presence:editing:${pageId}`;
}

function metaKey(userId: string): string {
  return `presence:meta:${userId}`;
}

function channelFor(pageId: string): string {
  return `presence:page:${pageId}`;
}

const CHANNEL_PATTERN = 'presence:page:*';

export interface PresenceMeta {
  name: string;
  role: string;
}

export interface PresenceViewer {
  userId: string;
  name: string;
  role: string;
  isEditing: boolean;
}

type PresenceListener = (viewers: PresenceViewer[]) => void;

// ── Module-level state (one per process) ─────────────────────────────────

let _mainClient: RedisClientType | null = null;
let _subscriber: RedisClientType | null = null;
let _subscriberReady: Promise<void> | null = null;
const _listeners: Map<string, Set<PresenceListener>> = new Map();

function parseChannel(channel: string): string | null {
  if (!channel.startsWith('presence:page:')) return null;
  return channel.slice('presence:page:'.length);
}

/**
 * Initialise the presence pub/sub subscriber for this process. Idempotent —
 * subsequent calls return immediately. Call at Fastify bootstrap and wire the
 * returned teardown into the onClose hook.
 */
export async function initPresenceBus(main: RedisClientType): Promise<() => Promise<void>> {
  _mainClient = main;

  if (_subscriberReady) return teardown;

  _subscriberReady = (async () => {
    try {
      const subscriber = main.duplicate() as RedisClientType;
      subscriber.on('error', (err) => {
        logger.error({ err }, 'presence-service: subscriber client error');
      });
      await subscriber.connect();
      await subscriber.pSubscribe(CHANNEL_PATTERN, (message, channel) => {
        const pageId = parseChannel(channel);
        if (!pageId) return;
        const listeners = _listeners.get(pageId);
        if (!listeners || listeners.size === 0) return;
        let viewers: PresenceViewer[];
        try {
          viewers = JSON.parse(message) as PresenceViewer[];
        } catch (err) {
          logger.warn({ err, message }, 'presence-service: failed to parse pub/sub payload');
          return;
        }
        for (const fn of listeners) {
          try {
            fn(viewers);
          } catch (err) {
            logger.warn({ err, pageId }, 'presence-service: listener threw');
          }
        }
      });
      _subscriber = subscriber;
      logger.info('presence-service: subscriber active');
    } catch (err) {
      logger.warn({ err }, 'presence-service: subscriber init failed — falling back to single-pod mode');
      _subscriber = null;
    }
  })();

  await _subscriberReady;
  return teardown;
}

async function teardown(): Promise<void> {
  const sub = _subscriber;
  _subscriber = null;
  _subscriberReady = null;
  _listeners.clear();
  if (!sub) return;
  try {
    await sub.pUnsubscribe(CHANNEL_PATTERN);
    await sub.quit();
  } catch (err) {
    logger.warn({ err }, 'presence-service: teardown failed');
  }
}

/**
 * Record or refresh a heartbeat for a user on a page. Also writes the per-user
 * meta hash (name, role) and publishes the updated viewer list to peer pods.
 *
 * Callers: POST /api/pages/:id/presence/heartbeat.
 */
export async function recordHeartbeat(
  pageId: string,
  userId: string,
  isEditing: boolean,
  meta: PresenceMeta,
): Promise<void> {
  const client = _mainClient;
  if (!client) {
    logger.warn('presence-service: main client not initialised, ignoring heartbeat');
    return;
  }

  const now = Math.floor(Date.now() / 1000);

  // Editing state lives in Redis so publishes are authoritative in multi-pod
  // deployments — otherwise each pod's local view would cause pencil-badge
  // oscillation. SREM has no TTL refresh; stale entries age out via the
  // viewers-key TTL refresh on the next SADD.
  const editingOp = isEditing
    ? [
        client.sAdd(editingKey(pageId), userId),
        client.expire(editingKey(pageId), VIEWERS_TTL_SEC),
      ]
    : [client.sRem(editingKey(pageId), userId)];

  try {
    await Promise.all([
      client.zAdd(viewersKey(pageId), { score: now, value: userId }),
      client.expire(viewersKey(pageId), VIEWERS_TTL_SEC),
      client.hSet(metaKey(userId), { name: meta.name, role: meta.role }),
      client.expire(metaKey(userId), META_TTL_SEC),
      ...editingOp,
    ]);
    const viewers = await getActiveViewers(pageId);
    await client.publish(channelFor(pageId), JSON.stringify(viewers));
  } catch (err) {
    logger.error({ err, pageId, userId }, 'presence-service: heartbeat failed');
  }
}

/**
 * Return the list of active viewers for a page. Uses ZRANGEBYSCORE with the
 * `now - ACTIVE_WINDOW_SEC` floor so heartbeat entries older than 20 seconds
 * are ignored even if the ZSET TTL hasn't kicked in yet.
 */
export async function getActiveViewers(pageId: string): Promise<PresenceViewer[]> {
  const client = _mainClient;
  if (!client) return [];

  const now = Math.floor(Date.now() / 1000);
  const floor = now - ACTIVE_WINDOW_SEC;

  try {
    const userIds = await client.zRangeByScore(viewersKey(pageId), floor, '+inf');
    if (userIds.length === 0) return [];

    const editingSet = new Set(await client.sMembers(editingKey(pageId)));
    const out: PresenceViewer[] = [];

    // Parallel HGETALL — small N so no pipeline needed.
    const metas = await Promise.all(userIds.map((uid) => client.hGetAll(metaKey(uid))));
    for (let i = 0; i < userIds.length; i++) {
      const uid = userIds[i]!;
      const raw = metas[i] ?? {};
      // node-redis returns {} for missing keys. If meta expired we still want
      // to emit a best-effort entry — the UI can fall back to the userId.
      out.push({
        userId: uid,
        name: typeof raw.name === 'string' && raw.name.length > 0 ? raw.name : uid,
        role: typeof raw.role === 'string' ? raw.role : '',
        isEditing: editingSet.has(uid),
      });
    }

    // Order: editing viewers first, then by userId for determinism.
    out.sort((a, b) => {
      if (a.isEditing !== b.isEditing) return a.isEditing ? -1 : 1;
      return a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0;
    });
    return out;
  } catch (err) {
    logger.error({ err, pageId }, 'presence-service: getActiveViewers failed');
    return [];
  }
}

/**
 * Remove a viewer from a page's presence list (best-effort beforeunload signal).
 * Publishes the updated viewer list afterwards so peer pods drop the ghost.
 */
export async function removeViewer(pageId: string, userId: string): Promise<void> {
  const client = _mainClient;
  if (!client) return;

  try {
    await Promise.all([
      client.zRem(viewersKey(pageId), userId),
      client.sRem(editingKey(pageId), userId),
    ]);
    const viewers = await getActiveViewers(pageId);
    await client.publish(channelFor(pageId), JSON.stringify(viewers));
  } catch (err) {
    logger.error({ err, pageId, userId }, 'presence-service: removeViewer failed');
  }
}

/**
 * Subscribe to presence updates for a page. Returns an unsubscribe function.
 *
 * The pub/sub subscriber is shared across all pageIds — this helper registers
 * a local listener in the in-process Map. When the first listener for a page
 * arrives we do NOT need to re-subscribe to Redis because the PSUBSCRIBE on
 * `presence:page:*` already routes all page events to the process.
 *
 * Callers: GET /api/pages/:id/presence (SSE stream).
 */
export function subscribeToPage(pageId: string, onUpdate: PresenceListener): () => void {
  let set = _listeners.get(pageId);
  if (!set) {
    set = new Set();
    _listeners.set(pageId, set);
  }
  set.add(onUpdate);
  return () => {
    const current = _listeners.get(pageId);
    if (!current) return;
    current.delete(onUpdate);
    if (current.size === 0) _listeners.delete(pageId);
  };
}

/**
 * Reset all module state. Tests only — production callers should use the
 * teardown returned by `initPresenceBus`.
 */
export async function _resetForTest(): Promise<void> {
  await teardown();
  _mainClient = null;
}
