/**
 * In-process Y.Doc rooms with incremental Redis fan-out (#1444).
 *
 * Persistence is in-memory this PR (BYTEA is the next child). Subscribe-and-
 * queue before attaching the doc; `Y.applyUpdate(..., 'redis')` must not
 * republish; awareness uses y-protocols, never Y.applyUpdate.
 */
import { randomUUID } from 'node:crypto';
import type { RedisClientType } from 'redis';
import type { WebSocket } from 'ws';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import { logger } from '../utils/logger.js';
import { getRedisClient } from './redis-cache.js';
import { COLLAB_INIT_LOCK_KEY } from '../db/advisory-locks.js';
import { getPool } from '../db/postgres.js';

export const COLLAB_ACTIVE_TTL_SEC = 45;
export const COLLAB_PING_INTERVAL_MS = 15_000;
export const COLLAB_READONLY_DROP_LIMIT = 8;
export const COLLAB_EMPTY_ROOM_GRACE_MS = 10_000;

const CHANNEL_PREFIX = 'collab:doc:';
const CHANNEL_PATTERN = 'collab:doc:*';
const ACTIVE_PREFIX = 'collab:active:';

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

export type CollabBusKind =
  | 'sync'
  | 'awareness'
  | 'control'
  | 'tombstone'
  | 'state_dump_request'
  | 'state_dump';

export type CollabBusMessage = {
  origin: string;
  kind: CollabBusKind;
  update?: string;
};

export interface CollabSocket {
  id: string;
  ws: WebSocket;
  userId: string;
  writable: boolean;
  readonlyDrops: number;
}

export interface CollabRoom {
  pageId: number;
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  sockets: Map<string, CollabSocket>;
  inboundQueue: CollabBusMessage[];
  attached: boolean;
  flushing: boolean;
  emptyGrace: ReturnType<typeof setTimeout> | null;
}

export type CollabInboundResult = 'ok' | 'dropped' | 'close_4403';

export interface CollabRuntime {
  podId: string;
  getOrCreateRoom: (pageId: number) => Promise<CollabRoom>;
  getRoom: (pageId: number) => CollabRoom | undefined;
  attachSocket: (pageId: number, socket: Omit<CollabSocket, 'readonlyDrops'>) => Promise<CollabSocket>;
  detachSocket: (pageId: number, connId: string) => Promise<void>;
  handleInboundFrame: (pageId: number, connId: string, buf: Uint8Array) => CollabInboundResult;
  refreshActiveTtl: (pageId: number) => Promise<void>;
  tombstone: (pageId: number, code: number, reason?: string) => Promise<void>;
  tombstoneAll: (code: number, reason?: string) => Promise<void>;
  close: () => Promise<void>;
}

let defaultRuntime: CollabRuntime | null = null;

function activeKey(pageId: number): string {
  return `${ACTIVE_PREFIX}${pageId}`;
}

function docChannel(pageId: number): string {
  return `${CHANNEL_PREFIX}${pageId}`;
}

function parseChannel(channel: string): number | null {
  if (!channel.startsWith(CHANNEL_PREFIX)) return null;
  const id = Number(channel.slice(CHANNEL_PREFIX.length));
  return Number.isInteger(id) && id > 0 ? id : null;
}

function b64(buf: Uint8Array): string {
  return Buffer.from(buf).toString('base64');
}

function fromB64(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64'));
}

function encodeUpdateFrame(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  encoding.writeVarUint(encoder, 2);
  encoding.writeVarUint8Array(encoder, update);
  return encoding.toUint8Array(encoder);
}

function encodeAwarenessFrame(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
  encoding.writeVarUint8Array(encoder, update);
  return encoding.toUint8Array(encoder);
}

function sendBin(ws: WebSocket, data: Uint8Array): void {
  if (ws.readyState !== 1) return;
  try {
    ws.send(data);
  } catch (err) {
    logger.debug({ err }, 'collab: socket send failed');
  }
}

export async function createCollabRuntime(
  main: RedisClientType,
  podId: string = randomUUID(),
): Promise<CollabRuntime> {
  const rooms = new Map<number, CollabRoom>();
  const inflight = new Map<number, Promise<CollabRoom>>();
  let subscriber: RedisClientType | null = null;

  async function publish(pageId: number, msg: CollabBusMessage): Promise<void> {
    try {
      await main.publish(docChannel(pageId), JSON.stringify(msg));
    } catch (err) {
      logger.warn({ err, pageId }, 'collab.bus_error');
    }
  }

  async function saddActive(pageId: number, connId: string): Promise<void> {
    try {
      await main.sAdd(activeKey(pageId), `${podId}:${connId}`);
      await main.expire(activeKey(pageId), COLLAB_ACTIVE_TTL_SEC);
    } catch (err) {
      logger.warn({ err, pageId }, 'collab: active SADD failed');
    }
  }

  async function sremActive(pageId: number, connId: string): Promise<void> {
    try {
      await main.sRem(activeKey(pageId), `${podId}:${connId}`);
    } catch (err) {
      logger.warn({ err, pageId }, 'collab: active SREM failed');
    }
  }

  async function refreshActiveTtl(pageId: number): Promise<void> {
    try {
      await main.expire(activeKey(pageId), COLLAB_ACTIVE_TTL_SEC);
    } catch (err) {
      logger.debug({ err, pageId }, 'collab: expire failed');
    }
  }

  function forwardUpdate(room: CollabRoom, update: Uint8Array, exceptConnId?: string): void {
    const frame = encodeUpdateFrame(update);
    for (const [id, sock] of room.sockets) {
      if (exceptConnId && id === exceptConnId) continue;
      sendBin(sock.ws, frame);
    }
  }

  function forwardAwareness(room: CollabRoom, update: Uint8Array, exceptConnId?: string): void {
    const frame = encodeAwarenessFrame(update);
    for (const [id, sock] of room.sockets) {
      if (exceptConnId && id === exceptConnId) continue;
      sendBin(sock.ws, frame);
    }
  }

  function applyBusMessage(room: CollabRoom, msg: CollabBusMessage): void {
    if (msg.origin === podId) return;
    if (msg.kind === 'state_dump_request') {
      const dump = Y.encodeStateAsUpdate(room.doc);
      void publish(room.pageId, { origin: podId, kind: 'state_dump', update: b64(dump) });
      logger.info({ pageId: room.pageId }, 'collab.state_dump');
      return;
    }
    if (msg.kind === 'tombstone') {
      closeRoomSockets(room, 4404, 'tombstone');
      rooms.delete(room.pageId);
      return;
    }
    if ((msg.kind === 'sync' || msg.kind === 'state_dump') && msg.update) {
      const buf = fromB64(msg.update);
      Y.applyUpdate(room.doc, buf, 'redis');
      forwardUpdate(room, buf);
      return;
    }
    if (msg.kind === 'awareness' && msg.update) {
      const buf = fromB64(msg.update);
      awarenessProtocol.applyAwarenessUpdate(room.awareness, buf, 'redis');
      forwardAwareness(room, buf);
    }
  }

  function flush(room: CollabRoom): void {
    if (room.flushing) return;
    room.flushing = true;
    try {
      while (room.inboundQueue.length > 0) {
        const msg = room.inboundQueue.shift()!;
        applyBusMessage(room, msg);
      }
    } finally {
      room.flushing = false;
    }
  }

  function enqueue(room: CollabRoom, msg: CollabBusMessage): void {
    if (msg.origin === podId) return;
    if (!room.attached) {
      room.inboundQueue.push(msg);
      return;
    }
    room.inboundQueue.push(msg);
    flush(room);
  }

  function closeRoomSockets(room: CollabRoom, code: number, reason: string): void {
    for (const sock of room.sockets.values()) {
      try {
        sock.ws.close(code, reason);
      } catch {
        // already closing
      }
    }
    room.sockets.clear();
    if (room.emptyGrace) {
      clearTimeout(room.emptyGrace);
      room.emptyGrace = null;
    }
    room.doc.destroy();
  }

  async function dropRoom(pageId: number): Promise<void> {
    const room = rooms.get(pageId);
    if (!room) return;
    rooms.delete(pageId);
    if (room.emptyGrace) clearTimeout(room.emptyGrace);
    try {
      await main.del(activeKey(pageId));
    } catch {
      // best-effort
    }
    try {
      room.doc.destroy();
    } catch {
      // already destroyed
    }
  }

  function wireDoc(room: CollabRoom): void {
    room.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === 'redis') return;
      const except = typeof origin === 'string' ? origin : undefined;
      void publish(room.pageId, { origin: podId, kind: 'sync', update: b64(update) });
      forwardUpdate(room, update, except);
    });
    room.awareness.on('update', ({ added, updated, removed }: {
      added: number[];
      updated: number[];
      removed: number[];
    }, origin: unknown) => {
      if (origin === 'redis') return;
      const changed = added.concat(updated, removed);
      if (changed.length === 0) return;
      const encoded = awarenessProtocol.encodeAwarenessUpdate(room.awareness, changed);
      const except = typeof origin === 'string' ? origin : undefined;
      void publish(room.pageId, { origin: podId, kind: 'awareness', update: b64(encoded) });
      forwardAwareness(room, encoded, except);
    });
  }

  async function actuallyCreate(pageId: number): Promise<CollabRoom> {
    const existing = rooms.get(pageId);
    if (existing) return existing;

    const doc = new Y.Doc();
    const awareness = new awarenessProtocol.Awareness(doc);
    const room: CollabRoom = {
      pageId,
      doc,
      awareness,
      sockets: new Map(),
      inboundQueue: [],
      attached: false,
      flushing: false,
      emptyGrace: null,
    };
    wireDoc(room);
    rooms.set(pageId, room);

    try {
      const pool = getPool();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock($1, $2)', [COLLAB_INIT_LOCK_KEY, pageId]);
        await client.query('COMMIT');
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch { /* */ }
        logger.debug({ err, pageId }, 'collab: advisory lock skipped');
      } finally {
        client.release();
      }
    } catch (err) {
      logger.debug({ err, pageId }, 'collab: advisory lock skipped (no DB)');
    }

    await saddActive(pageId, 'room');

    try {
      const members = await main.sMembers(activeKey(pageId));
      const otherPod = members.some((m) => !m.startsWith(`${podId}:`));
      if (otherPod) {
        await publish(pageId, { origin: podId, kind: 'state_dump_request' });
      }
    } catch (err) {
      logger.debug({ err, pageId }, 'collab: active members read failed');
    }

    room.attached = true;
    flush(room);
    return room;
  }

  async function getOrCreateRoom(pageId: number): Promise<CollabRoom> {
    const existing = rooms.get(pageId);
    if (existing) return existing;
    const pending = inflight.get(pageId);
    if (pending) return pending;
    const p = actuallyCreate(pageId).finally(() => inflight.delete(pageId));
    inflight.set(pageId, p);
    return p;
  }

  function handleInboundFrame(pageId: number, connId: string, buf: Uint8Array): CollabInboundResult {
    const room = rooms.get(pageId);
    const sock = room?.sockets.get(connId);
    if (!room || !sock) return 'dropped';
    void refreshActiveTtl(pageId);

    if (buf.length < 1) return 'dropped';
    const isSyncStep1 = buf.length >= 2 && buf[0] === MESSAGE_SYNC && buf[1] === 0;
    const isAwareness = buf[0] === MESSAGE_AWARENESS;

    if (!sock.writable) {
      if (!isSyncStep1 && !isAwareness) {
        sock.readonlyDrops += 1;
        logger.info({ pageId, userId: sock.userId, connId: sock.id }, 'collab.readonly_drop');
        if (sock.readonlyDrops >= COLLAB_READONLY_DROP_LIMIT) return 'close_4403';
        return 'dropped';
      }
    }

    try {
      const decoder = decoding.createDecoder(buf);
      const messageType = decoding.readVarUint(decoder);
      if (messageType === MESSAGE_SYNC) {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_SYNC);
        syncProtocol.readSyncMessage(decoder, encoder, room.doc, connId);
        if (encoding.length(encoder) > 1) {
          sendBin(sock.ws, encoding.toUint8Array(encoder));
        }
        return 'ok';
      }
      if (messageType === MESSAGE_AWARENESS) {
        const update = decoding.readVarUint8Array(decoder);
        awarenessProtocol.applyAwarenessUpdate(room.awareness, update, connId);
        return 'ok';
      }
    } catch (err) {
      logger.debug({ err, pageId }, 'collab: inbound frame parse failed');
      return 'dropped';
    }
    return 'dropped';
  }

  async function attachSocket(
    pageId: number,
    socket: Omit<CollabSocket, 'readonlyDrops'>,
  ): Promise<CollabSocket> {
    const room = await getOrCreateRoom(pageId);
    if (room.emptyGrace) {
      // Reconnect during grace: last member (or :grace sentinel) is still in
      // collab:active. Cancel the drop; SADD the new connId regardless.
      clearTimeout(room.emptyGrace);
      room.emptyGrace = null;
      await sremActive(pageId, 'grace');
    }
    const full: CollabSocket = { ...socket, readonlyDrops: 0 };
    room.sockets.set(full.id, full);
    await saddActive(pageId, full.id);
    logger.info(
      { pageId, userId: full.userId, writable: full.writable, connId: full.id },
      'collab.join',
    );
    return full;
  }

  async function detachSocket(pageId: number, connId: string): Promise<void> {
    const room = rooms.get(pageId);
    if (!room) return;
    const sock = room.sockets.get(connId);
    room.sockets.delete(connId);
    if (sock) {
      logger.info(
        { pageId, userId: sock.userId, writable: sock.writable, connId },
        'collab.leave',
      );
    }
    if (room.sockets.size > 0) {
      await sremActive(pageId, connId);
      return;
    }
    // Last editor out: keep this member (and a :grace sentinel) in
    // collab:active until the in-memory Y.Doc is dropped, so PUT still 409s
    // during the reconnect window.
    await saddActive(pageId, 'grace');
    await refreshActiveTtl(pageId);
    room.emptyGrace = setTimeout(() => {
      void dropRoom(pageId);
    }, COLLAB_EMPTY_ROOM_GRACE_MS);
    if (typeof room.emptyGrace.unref === 'function') room.emptyGrace.unref();
  }

  async function tombstone(pageId: number, code: number, reason = 'tombstone'): Promise<void> {
    const room = rooms.get(pageId);
    if (room) {
      closeRoomSockets(room, code, reason);
      rooms.delete(pageId);
    }
    await publish(pageId, { origin: podId, kind: 'tombstone' });
    try {
      await main.del(activeKey(pageId));
    } catch {
      // best-effort
    }
    logger.info({ pageId, code }, 'collab.tombstone');
  }

  async function tombstoneAll(code: number, reason = 'tombstone'): Promise<void> {
    const ids = [...rooms.keys()];
    for (const id of ids) {
      await tombstone(id, code, reason);
    }
  }

  try {
    const sub = main.duplicate() as RedisClientType;
    sub.on('error', (err) => {
      logger.error({ err }, 'collab-room-service: subscriber client error');
    });
    await sub.connect();
    await sub.pSubscribe(CHANNEL_PATTERN, (message, channel) => {
      const pageId = parseChannel(channel);
      if (pageId === null) return;
      const room = rooms.get(pageId);
      if (!room) return;
      let msg: CollabBusMessage;
      try {
        msg = JSON.parse(message) as CollabBusMessage;
      } catch (err) {
        logger.warn({ err, message }, 'collab-room-service: failed to parse pub/sub payload');
        return;
      }
      enqueue(room, msg);
    });
    subscriber = sub;
    logger.info({ podId }, 'collab-room-service: subscriber active');
  } catch (err) {
    logger.warn({ err }, 'collab-room-service: subscriber init failed — falling back to single-pod mode');
    subscriber = null;
  }

  async function close(): Promise<void> {
    const ids = [...rooms.keys()];
    for (const id of ids) {
      const room = rooms.get(id);
      if (room) {
        closeRoomSockets(room, 1001, 'shutdown');
        rooms.delete(id);
      }
      try { await main.del(activeKey(id)); } catch { /* */ }
    }
    const sub = subscriber;
    subscriber = null;
    if (!sub) return;
    try {
      await sub.pUnsubscribe(CHANNEL_PATTERN);
      await sub.quit();
    } catch (err) {
      logger.warn({ err }, 'collab-room-service: teardown failed');
    }
  }

  return {
    podId,
    getOrCreateRoom,
    getRoom: (pageId) => rooms.get(pageId),
    attachSocket,
    detachSocket,
    handleInboundFrame,
    refreshActiveTtl,
    tombstone,
    tombstoneAll,
    close,
  };
}

async function teardownDefault(): Promise<void> {
  if (!defaultRuntime) return;
  await defaultRuntime.close();
  defaultRuntime = null;
}

export async function initCollabBus(main: RedisClientType): Promise<() => Promise<void>> {
  if (defaultRuntime) return teardownDefault;
  defaultRuntime = await createCollabRuntime(main);
  return teardownDefault;
}

export function getDefaultCollabRuntime(): CollabRuntime | null {
  return defaultRuntime;
}

export async function tombstoneCollabRoom(pageId: number, code: number, reason?: string): Promise<void> {
  if (!defaultRuntime) return;
  await defaultRuntime.tombstone(pageId, code, reason);
}

export async function tombstoneAllCollabRooms(code: number, reason?: string): Promise<void> {
  if (!defaultRuntime) return;
  await defaultRuntime.tombstoneAll(code, reason);
}

export async function refreshCollabActiveTtl(pageId: number): Promise<void> {
  if (defaultRuntime) {
    await defaultRuntime.refreshActiveTtl(pageId);
    return;
  }
  const redis = getRedisClient();
  if (!redis) return;
  try {
    await redis.expire(activeKey(pageId), COLLAB_ACTIVE_TTL_SEC);
  } catch {
    // best-effort
  }
}

export async function _resetCollabRoomsForTest(): Promise<void> {
  if (defaultRuntime) {
    await defaultRuntime.tombstoneAll(1001, 'test_reset');
  }
}
