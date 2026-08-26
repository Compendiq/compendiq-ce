/**
 * In-process Y.Doc rooms with incremental Redis fan-out (#1444/#1445).
 *
 * Subscribe-and-queue before BYTEA load; `Y.applyUpdate(..., 'redis')` must
 * not republish; awareness uses y-protocols, never Y.applyUpdate. Persistence
 * (BYTEA + HTML snapshot) lives in collab-persistence.ts.
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
import { prefixedRedisChannel } from '../utils/prefixed-redis-channel.js';
import { vitestIntOr } from '../utils/safe-int.js';
import { getRedisClient } from './redis-cache.js';
import * as persist from './collab-persistence.js';

export const COLLAB_ACTIVE_TTL_SEC = vitestIntOr('COLLAB_ACTIVE_TTL_SEC', 45);
export const COLLAB_PING_INTERVAL_MS = vitestIntOr('COLLAB_PING_INTERVAL_MS', 15_000);
export const COLLAB_READONLY_DROP_LIMIT = 8;
export const COLLAB_EMPTY_ROOM_GRACE_MS = vitestIntOr('COLLAB_EMPTY_ROOM_GRACE_MS', 10_000);
export const COLLAB_COMMIT_DUMP_TIMEOUT_MS = vitestIntOr('COLLAB_COMMIT_DUMP_TIMEOUT_MS', 2_000);

const CHANNEL_PREFIX = prefixedRedisChannel('collab:doc:');
const CHANNEL_PATTERN = `${CHANNEL_PREFIX}*`;
const ACTIVE_PREFIX = 'collab:active:';

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MESSAGE_QUERY_AWARENESS = 3;
export const MESSAGE_CONTROL = 4;

export type CollabControl =
  | { type: 'pages_version'; version: number }
  | { type: 'doc_reset' }
  | { type: 'tombstone' };

export type CollabBusKind =
  | 'sync'
  | 'awareness'
  | 'control'
  | 'tombstone'
  | 'freeze'
  | 'state_dump_request'
  | 'state_dump';

export type CollabBusMessage = {
  origin: string;
  kind: CollabBusKind;
  update?: string;
  code?: number;
  reason?: string;
};

export interface CollabIdentity {
  id: string;
  name: string;
  color: string;
}

export interface CollabSocket {
  id: string;
  ws: WebSocket;
  userId: string;
  writable: boolean;
  readonlyDrops: number;
  identity?: CollabIdentity;
  awarenessClientIds: Set<number>;
}

export interface CollabRoom {
  pageId: number;
  epoch: number;
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  sockets: Map<string, CollabSocket>;
  inboundQueue: CollabBusMessage[];
  attached: boolean;
  flushing: boolean;
  emptyGrace: ReturnType<typeof setTimeout> | null;
  persistTimer: ReturnType<typeof setTimeout> | null;
  persistChain: Promise<void>;
  persistable: boolean;
  dumpReceived: boolean;
  pagesVersion: number;
  lastWriterUserId: string | null;
  /** Redis SET suffixes (`room`, conn ids, `grace`) this room instance owns. */
  heldActiveSuffixes: Set<string>;
}

export type CollabInboundResult = 'ok' | 'dropped' | 'close_4403';

export interface CollabRuntime {
  podId: string;
  getOrCreateRoom: (pageId: number) => Promise<CollabRoom>;
  getRoom: (pageId: number) => CollabRoom | undefined;
  attachSocket: (pageId: number, socket: Omit<CollabSocket, 'readonlyDrops' | 'awarenessClientIds'>) => Promise<CollabSocket>;
  detachSocket: (pageId: number, connId: string) => Promise<void>;
  handleInboundFrame: (pageId: number, connId: string, buf: Uint8Array) => CollabInboundResult;
  refreshActiveTtl: (pageId: number) => Promise<void>;
  tombstone: (pageId: number, code: number, reason?: string) => Promise<void>;
  tombstoneAll: (code: number, reason?: string) => Promise<void>;
  broadcastControl: (pageId: number, control: CollabControl) => void;
  waitForPeerStateDump: (pageId: number, timeoutMs?: number) => Promise<boolean>;
  /** Flush, SREM this pod's members, destroy the Y.Doc. No-op if sockets remain. */
  dropRoom: (pageId: number) => Promise<void>;
  /** Rebuild BYTEA from inbound HTML, `doc_reset`, close sockets 1001. */
  resetFromHtml: (pageId: number, html: string) => Promise<void>;
  close: () => Promise<void>;
}

let defaultRuntime: CollabRuntime | null = null;

function activeKey(pageId: number): string {
  return `${ACTIVE_PREFIX}${pageId}`;
}

function docChannel(pageId: number): string {
  return `${CHANNEL_PREFIX}${pageId}`;
}

/** Pub/sub name for a page. Exported so tests publish on the same (possibly worker-prefixed) channel. */
export function collabDocChannel(pageId: number): string {
  return docChannel(pageId);
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
  const dumpWaiters = new Map<number, Array<(ok: boolean) => void>>();
  let nextEpoch = 1;
  let subscriber: RedisClientType | null = null;

  function resolveDumpWaiters(pageId: number, ok: boolean): void {
    const waiters = dumpWaiters.get(pageId);
    if (!waiters || waiters.length === 0) return;
    dumpWaiters.delete(pageId);
    for (const resolve of waiters) resolve(ok);
  }

  async function waitForPeerStateDump(
    pageId: number,
    timeoutMs: number = COLLAB_COMMIT_DUMP_TIMEOUT_MS,
  ): Promise<boolean> {
    if (rooms.get(pageId)?.dumpReceived) return true;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const pending = dumpWaiters.get(pageId);
        if (pending) {
          dumpWaiters.set(pageId, pending.filter((w) => w !== onDump));
          if ((dumpWaiters.get(pageId)?.length ?? 0) === 0) dumpWaiters.delete(pageId);
        }
        resolve(false);
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      const onDump = (ok: boolean): void => {
        clearTimeout(timer);
        resolve(ok);
      };
      const list = dumpWaiters.get(pageId) ?? [];
      list.push(onDump);
      dumpWaiters.set(pageId, list);
      if (rooms.get(pageId)?.dumpReceived) {
        clearTimeout(timer);
        resolveDumpWaiters(pageId, true);
      }
    });
  }

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
    try {
      if (msg.kind === 'state_dump_request') {
        const dump = Y.encodeStateAsUpdate(room.doc);
        void publish(room.pageId, { origin: podId, kind: 'state_dump', update: b64(dump) });
        logger.info({ pageId: room.pageId }, 'collab.state_dump');
        return;
      }
      if (msg.kind === 'freeze') {
        freezeRoom(room);
        return;
      }
      if (msg.kind === 'tombstone') {
        const code = typeof msg.code === 'number' ? msg.code : 4404;
        const reason = msg.reason ?? 'tombstone';
        if (reason === 'doc_reset') freezeRoom(room);
        void closeRoomSockets(room, code, reason).then(() => {
          rooms.delete(room.pageId);
        });
        return;
      }
      if ((msg.kind === 'sync' || msg.kind === 'state_dump') && msg.update) {
        // Join dumps must still apply while persistable is false (BYTEA
        // missing). Freeze/doc_reset is resettingPageIds — that dump is the
        // old CRDT and must not land or unfreeze the room.
        if (msg.kind === 'state_dump' && persist.isCollabResetting(room.pageId)) return;
        const buf = fromB64(msg.update);
        Y.applyUpdate(room.doc, buf, 'redis');
        forwardUpdate(room, buf);
        if (msg.kind === 'state_dump') {
          room.dumpReceived = true;
          if (!persist.isCollabResetting(room.pageId)) {
            room.persistable = true;
          }
          resolveDumpWaiters(room.pageId, true);
        }
        return;
      }
      if (msg.kind === 'awareness' && msg.update) {
        const buf = fromB64(msg.update);
        awarenessProtocol.applyAwarenessUpdate(room.awareness, buf, 'redis');
        forwardAwareness(room, buf);
        return;
      }
      if (msg.kind === 'control' && msg.update) {
        const control = JSON.parse(Buffer.from(msg.update, 'base64').toString('utf8')) as CollabControl;
        sendControl(room, control);
      }
    } catch (err) {
      logger.warn({ err, pageId: room.pageId, kind: msg.kind }, 'collab: bus apply failed');
    }
  }

  function flush(room: CollabRoom): void {
    if (room.flushing) return;
    room.flushing = true;
    try {
      while (room.inboundQueue.length > 0) {
        const msg = room.inboundQueue.shift()!;
        try {
          applyBusMessage(room, msg);
        } catch (err) {
          logger.warn({ err, pageId: room.pageId, kind: msg.kind }, 'collab: bus apply failed');
        }
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

  function freezeRoom(room: CollabRoom): void {
    room.persistable = false;
    persist.beginCollabReset(room.pageId);
    if (room.persistTimer) {
      clearTimeout(room.persistTimer);
      room.persistTimer = null;
    }
  }

  async function closeRoomSockets(room: CollabRoom, code: number, reason: string): Promise<void> {
    if (reason === 'doc_reset') {
      // Backup for proxies that strip the close reason; only on sockets we
      // are about to close, never as a room-wide invitation to rejoin.
      const frame = encodeControlFrame({ type: 'doc_reset' });
      for (const sock of room.sockets.values()) sendBin(sock.ws, frame);
    }
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
    if (room.persistTimer) {
      clearTimeout(room.persistTimer);
      room.persistTimer = null;
    }
    if (reason === 'doc_reset') {
      await room.persistChain;
    } else {
      await persist.flushCollabPersist(room);
    }
    persist.endCollabReset(room.pageId);
    try {
      room.doc.destroy();
    } catch {
      // already destroyed
    }
  }

  async function sremSuffixes(pageId: number, suffixes: Iterable<string>): Promise<void> {
    const members = [...suffixes].map((s) => `${podId}:${s}`);
    if (members.length === 0) return;
    try {
      await main.sRem(activeKey(pageId), members);
    } catch (err) {
      logger.debug({ err, pageId }, 'collab: srem active members failed');
    }
  }

  async function dropRoom(pageId: number): Promise<void> {
    const room = rooms.get(pageId);
    if (!room) return;
    // A reconnect during grace can fire this timer after sockets are back.
    if (room.sockets.size > 0) {
      if (room.emptyGrace) {
        clearTimeout(room.emptyGrace);
        room.emptyGrace = null;
      }
      return;
    }
    const epoch = room.epoch;
    const held = [...room.heldActiveSuffixes];
    rooms.delete(pageId);
    if (room.emptyGrace) {
      clearTimeout(room.emptyGrace);
      room.emptyGrace = null;
    }
    await persist.flushCollabPersist(room);
    persist.endCollabReset(pageId);
    const successor = rooms.get(pageId);
    const toDrop = successor && successor.epoch !== epoch
      ? held.filter((s) => s !== 'room')
      : held;
    await sremSuffixes(pageId, toDrop);
    try {
      room.doc.destroy();
    } catch {
      // already destroyed
    }
  }

  function stampAwarenessIdentity(update: Uint8Array, user: CollabIdentity): Uint8Array {
    return awarenessProtocol.modifyAwarenessUpdate(update, (state) => {
      if (state == null) return null;
      const rec = { ...state };
      delete rec.user;
      return { ...rec, user };
    });
  }

  function encodeControlFrame(control: CollabControl): Uint8Array {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_CONTROL);
    encoding.writeVarString(encoder, JSON.stringify(control));
    return encoding.toUint8Array(encoder);
  }

  function sendControl(room: CollabRoom, control: CollabControl): void {
    const frame = encodeControlFrame(control);
    for (const sock of room.sockets.values()) sendBin(sock.ws, frame);
  }

  function broadcastControl(pageId: number, control: CollabControl): void {
    const room = rooms.get(pageId);
    if (room) {
      sendControl(room, control);
      if (control.type === 'pages_version') room.pagesVersion = control.version;
    }
    void publish(pageId, {
      origin: podId,
      kind: 'control',
      update: Buffer.from(JSON.stringify(control), 'utf8').toString('base64'),
    });
  }

  function wireDoc(room: CollabRoom): void {
    room.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin !== persist.COLLAB_LOAD_ORIGIN) persist.scheduleCollabPersist(room);
      if (origin === 'redis' || origin === persist.COLLAB_LOAD_ORIGIN) return;
      const except = typeof origin === 'string' ? origin : undefined;
      void publish(room.pageId, { origin: podId, kind: 'sync', update: b64(update) });
      forwardUpdate(room, update, except);
    });
    room.awareness.on('update', ({ added, updated, removed }: {
      added: number[];
      updated: number[];
      removed: number[];
    }, origin: unknown) => {
      if (typeof origin === 'string' && origin !== 'redis') {
        const sock = room.sockets.get(origin);
        if (sock) {
          for (const id of added.concat(updated)) sock.awarenessClientIds.add(id);
          for (const id of removed) sock.awarenessClientIds.delete(id);
        }
      }
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
    // Room is not a participant; constructor seeds `{}` under doc.clientID.
    awareness.setLocalState(null);
    const room: CollabRoom = {
      pageId,
      epoch: nextEpoch++,
      doc,
      awareness,
      sockets: new Map(),
      inboundQueue: [],
      attached: false,
      flushing: false,
      emptyGrace: null,
      persistTimer: null,
      persistChain: Promise.resolve(),
      persistable: false,
      dumpReceived: false,
      pagesVersion: 0,
      lastWriterUserId: null,
      heldActiveSuffixes: new Set(['room']),
    };
    wireDoc(room);
    rooms.set(pageId, room);

    // Spec join order: SADD then BYTEA so PUT 409s during init.
    await saddActive(pageId, 'room');

    try {
      const loaded = await persist.loadOrInitCollabDoc(pageId, room.doc);
      if (loaded !== 'missing') {
        room.pagesVersion = loaded.pagesVersion;
        room.persistable = true;
      }
    } catch (err) {
      rooms.delete(pageId);
      await sremActive(pageId, 'room');
      try { room.doc.destroy(); } catch { /* */ }
      logger.warn({ err, pageId }, 'collab: persist init failed');
      throw err;
    }

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
    const isQueryAwareness = buf[0] === MESSAGE_QUERY_AWARENESS;

    if (!sock.writable) {
      if (!isSyncStep1 && !isAwareness && !isQueryAwareness) {
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
        let update = decoding.readVarUint8Array(decoder);
        if (sock.identity) update = stampAwarenessIdentity(update, sock.identity);
        awarenessProtocol.applyAwarenessUpdate(room.awareness, update, connId);
        return 'ok';
      }
      if (messageType === MESSAGE_QUERY_AWARENESS) {
        sendAwarenessSnapshot(room, sock.ws);
        return 'ok';
      }
    } catch (err) {
      logger.debug({ err, pageId }, 'collab: inbound frame parse failed');
      return 'dropped';
    }
    return 'dropped';
  }

  function sendAwarenessSnapshot(room: CollabRoom, ws: WebSocket): void {
    const ids = [...room.awareness.getStates().keys()];
    if (ids.length === 0) return;
    const encoded = awarenessProtocol.encodeAwarenessUpdate(room.awareness, ids);
    sendBin(ws, encodeAwarenessFrame(encoded));
  }

  async function attachSocket(
    pageId: number,
    socket: Omit<CollabSocket, 'readonlyDrops' | 'awarenessClientIds'>,
  ): Promise<CollabSocket> {
    const room = await getOrCreateRoom(pageId);
    if (room.emptyGrace) {
      // Reconnect during grace: last member (or :grace sentinel) is still in
      // collab:active. Cancel the drop; SADD the new connId regardless.
      clearTimeout(room.emptyGrace);
      room.emptyGrace = null;
      await sremActive(pageId, 'grace');
      room.heldActiveSuffixes.delete('grace');
    }
    const full: CollabSocket = { ...socket, readonlyDrops: 0, awarenessClientIds: new Set() };
    room.sockets.set(full.id, full);
    await saddActive(pageId, full.id);
    room.heldActiveSuffixes.add(full.id);
    sendAwarenessSnapshot(room, full.ws);
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
      if (sock && sock.awarenessClientIds.size > 0) {
        awarenessProtocol.removeAwarenessStates(room.awareness, [...sock.awarenessClientIds], connId);
      }
      await sremActive(pageId, connId);
      room.heldActiveSuffixes.delete(connId);
      return;
    }
    await persist.flushCollabPersist(room);
    // Last editor out: keep this member (and a :grace sentinel) in
    // collab:active until the in-memory Y.Doc is dropped, so PUT still 409s
    // during the reconnect window. Idempotent — do not replace an armed timer.
    if (room.emptyGrace) return;
    await saddActive(pageId, 'grace');
    room.heldActiveSuffixes.add('grace');
    await refreshActiveTtl(pageId);
    room.emptyGrace = setTimeout(() => {
      void dropRoom(pageId);
    }, COLLAB_EMPTY_ROOM_GRACE_MS);
    if (typeof room.emptyGrace.unref === 'function') room.emptyGrace.unref();
  }

  async function resetFromHtml(pageId: number, html: string): Promise<void> {
    persist.beginCollabReset(pageId);
    const room = rooms.get(pageId);
    if (room) freezeRoom(room);
    // Freeze peers before BYTEA replace so their persistChain cannot land after it.
    await publish(pageId, { origin: podId, kind: 'freeze', reason: 'doc_reset' });
    try {
      if (room) await room.persistChain;
      await persist.replaceCollabDocFromHtml(pageId, html);
      await tombstone(pageId, 1001, 'doc_reset');
    } finally {
      persist.endCollabReset(pageId);
    }
  }

  async function tombstone(pageId: number, code: number, reason = 'tombstone'): Promise<void> {
    const room = rooms.get(pageId);
    if (room) {
      await closeRoomSockets(room, code, reason);
      rooms.delete(pageId);
    }
    await publish(pageId, { origin: podId, kind: 'tombstone', code, reason });
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
      const held = room ? [...room.heldActiveSuffixes] : [];
      if (room) {
        await closeRoomSockets(room, 1001, 'shutdown');
        persist.endCollabReset(id);
        rooms.delete(id);
      }
      await sremSuffixes(id, held);
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
    broadcastControl,
    waitForPeerStateDump,
    dropRoom,
    resetFromHtml,
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

export async function resetCollabRoomFromHtml(pageId: number, html: string): Promise<void> {
  const runtime = getDefaultCollabRuntime();
  if (runtime) {
    await runtime.resetFromHtml(pageId, html);
    return;
  }
  await persist.replaceCollabDocFromHtml(pageId, html);
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
