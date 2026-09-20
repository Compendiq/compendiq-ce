/**
 * In-process Y.Doc rooms with incremental Redis fan-out (#1444/#1445/#276).
 *
 * Writable rooms own a durable PageRuntimeAdmission. Redis is delivery and
 * liveness advice only; PostgreSQL lifecycle/runtime state fences every client
 * mutation, peer update/state dump, BYTEA write, and snapshot.
 */
import { randomUUID } from 'node:crypto';
import type { RedisClientType } from 'redis';
import type { PoolClient } from 'pg';
import type { WebSocket } from 'ws';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import {
  PageLifecycleEventSchema,
  type CollabWritableAdmissionControl,
  type PageLifecycleEvent,
} from '@compendiq/contracts';
import { query } from '../db/postgres.js';
import { logger } from '../utils/logger.js';
import { prefixedRedisChannel } from '../utils/prefixed-redis-channel.js';
import { vitestIntOr } from '../utils/safe-int.js';
import { getRedisClient } from './redis-cache.js';
import { onReconnect, subscribe } from './redis-cache-bus.js';
import {
  admitPageRuntime,
  deferPageRequestAdmissionRelease,
  PageWriteError,
  releasePageRuntime,
  withPageWriteTransaction,
  type PageRuntimeAdmission,
} from './page-write-admission.js';
import * as persist from './collab-persistence.js';
import { yDocToHtml } from './collab-schema.js';

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
const SYNC_STEP1 = 0;
const SYNC_STEP2 = 1;
const SYNC_UPDATE = 2;

export type CollabControl =
  | { type: 'pages_version'; version: number }
  | { type: 'doc_reset' }
  | { type: 'tombstone' }
  | PageLifecycleEvent
  | CollabWritableAdmissionControl
  | { type: 'permission_loss'; reason: 'edit_permission_revoked' }
  | {
      type: 'writable_refused';
      reason: 'lifecycle_revision_required' | 'lifecycle_revision_stale';
      expectedLifecycleRevision: string | null;
      currentLifecycleRevision: string;
    };

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
  lifecycleRevision?: string;
  admission?: PageRuntimeAdmission;
  requestId?: string;
  requestedAdmissions?: string[];
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
  writableRefusalReason?: 'lifecycle_revision_required' | 'lifecycle_revision_stale';
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
  persistError: unknown | null;
  persistable: boolean;
  initializing: Promise<boolean> | null;
  pagesVersion: number;
  lastWriterUserId: string | null;
  heldActiveSuffixes: Set<string>;
  admission: PageRuntimeAdmission | null;
  lifecycleRevision: string;
  isFrozen: boolean;
  baselineId: string | null;
  demotionReason: 'page_frozen' | 'lifecycle_changed' | null;
  hasPersistedDoc: boolean;
}

export type CollabInboundResult = 'ok' | 'dropped' | 'close_4403';

export interface CollabRuntime {
  podId: string;
  getOrCreateRoom: (pageId: number) => Promise<CollabRoom>;
  getRoom: (pageId: number) => CollabRoom | undefined;
  attachSocket: (
    pageId: number,
    socket: Omit<CollabSocket, 'readonlyDrops' | 'awarenessClientIds' | 'writableRefusalReason'> & {
      expectedLifecycleRevision?: string | null;
    },
  ) => Promise<CollabSocket>;
  detachSocket: (pageId: number, connId: string) => Promise<void>;
  demoteSocket: (pageId: number, connId: string) => Promise<void>;
  handleInboundFrame: (pageId: number, connId: string, buf: Uint8Array) => Promise<CollabInboundResult>;
  refreshActiveTtl: (pageId: number) => Promise<void>;
  tombstone: (pageId: number, code: number, reason?: string) => Promise<void>;
  tombstoneAll: (code: number, reason?: string) => Promise<void>;
  broadcastControl: (pageId: number, control: CollabControl) => void;
  prepareCommitSnapshot: (
    pageId: number,
    userId: string,
    expectedLifecycleRevision: string,
  ) => Promise<{ admission: PageRuntimeAdmission; html: string; documentState: Y.Snapshot }>;
  handleLifecycleEvent: (event: PageLifecycleEvent) => Promise<void>;
  refreshLifecycleRooms: () => Promise<void>;
  dropRoom: (pageId: number) => Promise<void>;
  resetFromHtml: (pageId: number, html: string) => Promise<void>;
  close: () => Promise<void>;
}

let defaultRuntime: CollabRuntime | null = null;
let lifecycleBusUnsubscribe: (() => void) | null = null;
let lifecycleReconnectUnsubscribe: (() => void) | null = null;

function activeKey(pageId: number): string {
  return `${ACTIVE_PREFIX}${pageId}`;
}

function docChannel(pageId: number): string {
  return `${CHANNEL_PREFIX}${pageId}`;
}

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

function fromB64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64'));
}

function encodeUpdateFrame(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  encoding.writeVarUint(encoder, SYNC_UPDATE);
  encoding.writeVarUint8Array(encoder, update);
  return encoding.toUint8Array(encoder);
}

function encodeAwarenessFrame(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
  encoding.writeVarUint8Array(encoder, update);
  return encoding.toUint8Array(encoder);
}

function encodeControlFrame(control: CollabControl): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_CONTROL);
  encoding.writeVarString(encoder, JSON.stringify(control));
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

function lifecycleControl(room: CollabRoom): PageLifecycleEvent {
  return {
    type: 'page_lifecycle',
    pageId: room.pageId,
    lifecycleRevision: room.lifecycleRevision,
    isFrozen: room.isFrozen,
    baselineId: room.baselineId,
  };
}

function parseSyncSubtype(buf: Uint8Array): { messageType: number; syncSubtype: number | null } | null {
  try {
    const decoder = decoding.createDecoder(buf);
    const messageType = decoding.readVarUint(decoder);
    return {
      messageType,
      syncSubtype: messageType === MESSAGE_SYNC ? decoding.readVarUint(decoder) : null,
    };
  } catch {
    return null;
  }
}

function validAdmission(value: unknown): value is PageRuntimeAdmission {
  if (!value || typeof value !== 'object') return false;
  return 'id' in value && typeof value.id === 'string'
    && 'runtimeId' in value && typeof value.runtimeId === 'string'
    && 'pageId' in value && typeof value.pageId === 'number'
    && 'purpose' in value && value.purpose === 'collab_room'
    && 'lifecycleRevision' in value && typeof value.lifecycleRevision === 'string';
}

export async function createCollabRuntime(
  main: RedisClientType,
  podId: string = randomUUID(),
): Promise<CollabRuntime> {
  const rooms = new Map<number, CollabRoom>();
  const inflight = new Map<number, Promise<CollabRoom>>();
  const ownership = new Map<number, Promise<void>>();
  const dumpRounds = new Map<number, {
    id: string;
    lifecycleRevision: string;
    remaining: Set<string>;
    finish: (ok: boolean) => void;
  }>();
  let transportGeneration = 0;
  let nextEpoch = 1;
  let subscriber: RedisClientType | null = null;
  let closing = false;

  // Join validation and admission retirement are one ownership transition.
  // A socket count checked before an await cannot protect a joining writer.
  function withRoomOwnership<T>(pageId: number, operation: () => Promise<T>): Promise<T> {
    const result = (ownership.get(pageId) ?? Promise.resolve()).then(operation);
    const settled = result.then(() => undefined, () => undefined);
    ownership.set(pageId, settled);
    void settled.then(() => {
      if (ownership.get(pageId) === settled) ownership.delete(pageId);
    });
    return result;
  }

  function transportAvailable(): boolean {
    return main.isReady && subscriber?.isReady === true;
  }

  function unavailableSnapshot(): PageWriteError {
    return new PageWriteError(
      503, 'collab_state_unavailable',
      'The current collaborative state could not be confirmed across all room owners',
    );
  }

  async function roomOwners(client: PoolClient, room: CollabRoom): Promise<PageRuntimeAdmission[]> {
    const result = await client.query<{
      id: string;
      runtime_id: string;
      purpose: string;
      lifecycle_revision: string;
      fenced_at: Date | null;
      quiesced_at: Date | null;
    }>(
      `SELECT admission.id::text, admission.runtime_id, admission.purpose, admission.lifecycle_revision::text,
              runtime.fenced_at, runtime.quiesced_at
         FROM page_runtime_admissions admission
         JOIN page_writer_runtimes runtime ON runtime.runtime_id = admission.runtime_id
        WHERE admission.page_id = $1 AND admission.released_at IS NULL
          AND admission.purpose <> 'collab_request'
        ORDER BY admission.id`,
      [room.pageId],
    );
    if (result.rows.some((owner) =>
      owner.purpose !== 'collab_room'
      || owner.lifecycle_revision !== room.lifecycleRevision
      || owner.fenced_at !== null || owner.quiesced_at !== null)) {
      throw unavailableSnapshot();
    }
    return result.rows.map((owner) => ({
      id: owner.id, runtimeId: owner.runtime_id, pageId: room.pageId,
      lifecycleRevision: owner.lifecycle_revision, purpose: 'collab_room',
    }));
  }

  async function mergePersistedRoom(client: PoolClient, room: CollabRoom): Promise<void> {
    if (rooms.get(room.pageId) !== room) throw unavailableSnapshot();
    const canonical = room.hasPersistedDoc ? room.doc : new Y.Doc();
    try {
      if (!(await persist.mergePersistedCollabDoc(client, room.pageId, canonical))) {
        throw unavailableSnapshot();
      }
      if (canonical !== room.doc) adoptPersistedDocument(room, canonical);
    } catch (error) {
      if (canonical !== room.doc) canonical.destroy();
      throw error;
    }
  }

  async function withFreshRoomState<T>(
    room: CollabRoom,
    admission: PageRuntimeAdmission,
    snapshot: () => T,
  ): Promise<T> {
    const generation = transportGeneration;
    const assertCurrent = (): void => {
      if (!transportAvailable() || generation !== transportGeneration
        || rooms.get(room.pageId) !== room || room.isFrozen || room.demotionReason !== null
        || room.lifecycleRevision !== admission.lifecycleRevision) throw unavailableSnapshot();
    };
    assertCurrent();
    const owners = await withPageWriteTransaction([room.pageId], async (client) => {
      const currentOwners = await roomOwners(client, room);
      if (currentOwners.length === 0) throw unavailableSnapshot();
      await mergePersistedRoom(client, room);
      assertCurrent();
      return currentOwners;
    }, { admission });
    const remaining = new Set<string>();
    for (const owner of owners) {
      if (owner.id !== room.admission?.id) remaining.add(owner.id);
    }
    if (remaining.size > 0) {
      const requestId = randomUUID();
      let timer: NodeJS.Timeout;
      const received = new Promise<boolean>((resolve) => {
        const finish = (ok: boolean): void => {
          clearTimeout(timer);
          if (dumpRounds.get(room.pageId)?.id === requestId) dumpRounds.delete(room.pageId);
          resolve(ok);
        };
        timer = setTimeout(() => finish(false), COLLAB_COMMIT_DUMP_TIMEOUT_MS);
        timer.unref();
        dumpRounds.set(room.pageId, {
          id: requestId, lifecycleRevision: room.lifecycleRevision, remaining, finish,
        });
      });
      // Never await a Redis offline queue past this round's deadline.
      void main.publish(docChannel(room.pageId), JSON.stringify({
        origin: podId, kind: 'state_dump_request', requestId,
        requestedAdmissions: [...remaining], lifecycleRevision: room.lifecycleRevision,
      } satisfies CollabBusMessage)).catch(() => {
        const round = dumpRounds.get(room.pageId);
        if (round?.id === requestId) round.finish(false);
      });
      if (!(await received)) throw unavailableSnapshot();
    }
    return withPageWriteTransaction([room.pageId], async (client) => {
      const currentOwners = await roomOwners(client, room);
      if (currentOwners.length !== owners.length
        || currentOwners.some((owner, index) => owner.id !== owners[index]!.id)) throw unavailableSnapshot();
      await mergePersistedRoom(client, room);
      assertCurrent();
      return snapshot();
    }, { admission });
  }

  async function refreshReaderRoom(room: CollabRoom): Promise<void> {
    if (room.isFrozen || room.demotionReason !== null) return;
    const owners = await withPageWriteTransaction([room.pageId], (client) => roomOwners(client, room));
    const supportingAdmission = owners[0];
    if (supportingAdmission) await withFreshRoomState(room, supportingAdmission, () => undefined);
  }

  async function publish(pageId: number, message: CollabBusMessage): Promise<void> {
    try {
      await main.publish(docChannel(pageId), JSON.stringify(message));
    } catch (err) {
      logger.warn({ err, pageId }, 'collab.bus_error');
    }
  }

  async function saddActive(pageId: number, suffix: string): Promise<void> {
    try {
      await main.sAdd(activeKey(pageId), `${podId}:${suffix}`);
      await main.expire(activeKey(pageId), COLLAB_ACTIVE_TTL_SEC);
    } catch (err) {
      logger.warn({ err, pageId }, 'collab: active SADD failed');
    }
  }

  async function sremSuffixes(pageId: number, suffixes: Iterable<string>): Promise<void> {
    const members = [...suffixes].map((suffix) => `${podId}:${suffix}`);
    if (members.length === 0) return;
    try {
      await main.sRem(activeKey(pageId), members);
    } catch (err) {
      logger.debug({ err, pageId }, 'collab: active SREM failed');
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
    for (const [id, socket] of room.sockets) {
      if (exceptConnId && id === exceptConnId) continue;
      sendBin(socket.ws, frame);
    }
  }

  function forwardAwareness(room: CollabRoom, update: Uint8Array, exceptConnId?: string): void {
    const frame = encodeAwarenessFrame(update);
    for (const [id, socket] of room.sockets) {
      if (exceptConnId && id === exceptConnId) continue;
      sendBin(socket.ws, frame);
    }
  }

  function sendControl(room: CollabRoom, control: CollabControl): void {
    const frame = encodeControlFrame(control);
    for (const socket of room.sockets.values()) sendBin(socket.ws, frame);
  }

  function freezeTransientRoom(room: CollabRoom): void {
    room.persistable = false;
    persist.beginCollabReset(room.pageId);
    if (room.persistTimer) {
      clearTimeout(room.persistTimer);
      room.persistTimer = null;
    }
  }

  async function validateAndApplyPeerUpdate(
    room: CollabRoom,
    message: CollabBusMessage,
  ): Promise<boolean> {
    if (
      room.isFrozen
      || room.demotionReason !== null
      || message.lifecycleRevision !== room.lifecycleRevision
      || !validAdmission(message.admission)
      || message.admission.pageId !== room.pageId
      || message.admission.lifecycleRevision !== room.lifecycleRevision
      || !message.update
    ) return false;
    try {
      const update = fromB64(message.update);
      const accepted = await withPageWriteTransaction([room.pageId], async (client) => {
        if (!room.hasPersistedDoc) {
          const persisted = await client.query<{ doc_state: Buffer }>(
            'SELECT doc_state FROM page_collaborative_docs WHERE page_id = $1',
            [room.pageId],
          );
          if (!persisted.rows[0] || rooms.get(room.pageId) !== room) return false;
          const canonical = new Y.Doc();
          try {
            Y.applyUpdate(canonical, new Uint8Array(persisted.rows[0].doc_state), persist.COLLAB_LOAD_ORIGIN);
            adoptPersistedDocument(room, canonical);
          } catch (error) {
            canonical.destroy();
            throw error;
          }
        }
        if (rooms.get(room.pageId) !== room || room.isFrozen || room.demotionReason !== null) return false;
        Y.applyUpdate(room.doc, update, 'redis');
        forwardUpdate(room, update);
        return true;
      }, { admission: message.admission });
      if (!accepted) return false;
      return true;
    } catch (err) {
      logger.info({ err, pageId: room.pageId, kind: message.kind }, 'collab.stale_peer_update');
      return false;
    }
  }

  async function applyBusMessage(room: CollabRoom, message: CollabBusMessage): Promise<void> {
    if (message.origin === podId) return;
    try {
      if (message.kind === 'state_dump_request') {
        if (typeof message.requestId !== 'string' || !Array.isArray(message.requestedAdmissions)) return;
        await room.initializing;
        const admission = room.admission;
        if (!admission || message.lifecycleRevision !== room.lifecycleRevision
          || !message.requestedAdmissions.includes(admission.id)) return;
        const dump = await withPageWriteTransaction([room.pageId], async (client) => {
          await mergePersistedRoom(client, room);
          if (rooms.get(room.pageId) !== room || room.admission?.id !== admission.id) return null;
          return Y.encodeStateAsUpdate(room.doc);
        }, { admission });
        if (!dump || !transportAvailable()) return;
        await publish(room.pageId, {
          origin: podId, kind: 'state_dump', requestId: message.requestId,
          update: b64(dump), lifecycleRevision: room.lifecycleRevision, admission,
        });
        return;
      }
      if (message.kind === 'freeze') {
        freezeTransientRoom(room);
        return;
      }
      if (message.kind === 'tombstone') {
        const code = typeof message.code === 'number' ? message.code : 4404;
        const reason = message.reason ?? 'tombstone';
        if (reason === 'doc_reset') freezeTransientRoom(room);
        await withRoomOwnership(room.pageId, async () => {
          if (rooms.get(room.pageId) !== room) return;
          await closeRoomSockets(room, code, reason);
          rooms.delete(room.pageId);
        });
        return;
      }
      if (message.kind === 'state_dump' && message.update) {
        const round = dumpRounds.get(room.pageId);
        if (!round || message.requestId !== round.id
          || message.lifecycleRevision !== round.lifecycleRevision
          || !validAdmission(message.admission) || !round.remaining.has(message.admission.id)
          || persist.isCollabResetting(room.pageId)) return;
        if (await validateAndApplyPeerUpdate(room, message)) {
          round.remaining.delete(message.admission.id);
          if (round.remaining.size === 0) round.finish(true);
        }
        return;
      }
      if (message.kind === 'sync' && message.update) {
        await validateAndApplyPeerUpdate(room, message);
        return;
      }
      if (message.kind === 'awareness' && message.update) {
        const update = fromB64(message.update);
        awarenessProtocol.applyAwarenessUpdate(room.awareness, update, 'redis');
        forwardAwareness(room, update);
        return;
      }
      if (message.kind === 'control' && message.update) {
        const decoded: unknown = JSON.parse(Buffer.from(message.update, 'base64').toString('utf8'));
        if (!decoded || typeof decoded !== 'object' || !('type' in decoded)) return;
        if (decoded.type === 'pages_version' && 'version' in decoded && typeof decoded.version === 'number') {
          room.pagesVersion = decoded.version;
          sendControl(room, { type: 'pages_version', version: decoded.version });
        } else if (decoded.type === 'doc_reset') {
          sendControl(room, { type: 'doc_reset' });
        } else if (decoded.type === 'tombstone') {
          sendControl(room, { type: 'tombstone' });
        }
      }
    } catch (err) {
      logger.warn({ err, pageId: room.pageId, kind: message.kind }, 'collab: bus apply failed');
    }
  }

  async function flush(room: CollabRoom): Promise<void> {
    if (room.flushing) return;
    room.flushing = true;
    try {
      while (room.inboundQueue.length > 0) {
        const message = room.inboundQueue.shift()!;
        await applyBusMessage(room, message);
      }
    } finally {
      room.flushing = false;
      if (room.inboundQueue.length > 0) void flush(room);
    }
  }

  function enqueue(room: CollabRoom, message: CollabBusMessage): void {
    if (message.origin === podId) return;
    room.inboundQueue.push(message);
    if (room.attached) void flush(room);
  }

  function stampAwarenessIdentity(update: Uint8Array, user: CollabIdentity): Uint8Array {
    return awarenessProtocol.modifyAwarenessUpdate(update, (state) => {
      if (state == null) return null;
      const record = { ...state };
      delete record.user;
      return { ...record, user };
    });
  }

  function sendAwarenessSnapshot(room: CollabRoom, ws: WebSocket): void {
    const ids = [...room.awareness.getStates().keys()];
    if (ids.length === 0) return;
    sendBin(ws, encodeAwarenessFrame(awarenessProtocol.encodeAwarenessUpdate(room.awareness, ids)));
  }

  async function releaseAdmissionIfNoWriters(room: CollabRoom): Promise<void> {
    if (rooms.get(room.pageId) !== room) return;
    if ([...room.sockets.values()].some((socket) => socket.writable)) return;
    const admission = room.admission;
    if (!admission) return;
    await persist.flushCollabPersist(room);
    // Socket demotion/disconnection remains immediate while a flush is in
    // flight; joins and retirement share the ownership queue.
    if (
      [...room.sockets.values()].some((socket) => socket.writable)
      || room.admission?.id !== admission.id
    ) return;
    await releasePageRuntime(admission);
    room.admission = null;
    room.persistable = false;
    room.lastWriterUserId = null;
    const held = [...room.heldActiveSuffixes];
    room.heldActiveSuffixes.clear();
    await sremSuffixes(room.pageId, held);
  }

  async function demoteSocket(pageId: number, connId: string): Promise<void> {
    const room = rooms.get(pageId);
    const socket = room?.sockets.get(connId);
    if (!room || !socket || !socket.writable) return;
    socket.writable = false;
    sendBin(socket.ws, encodeControlFrame({ type: 'permission_loss', reason: 'edit_permission_revoked' }));
    await sremSuffixes(pageId, [connId]);
    room.heldActiveSuffixes.delete(connId);
    try {
      await withRoomOwnership(pageId, () => releaseAdmissionIfNoWriters(room));
    } catch (err) {
      logger.warn({ err, pageId }, 'collab: permission demotion flush failed; admission retained');
    }
  }

  function wireDoc(room: CollabRoom): void {
    room.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === persist.COLLAB_MERGE_ORIGIN) {
        forwardUpdate(room, update);
        return;
      }
      if (origin !== persist.COLLAB_LOAD_ORIGIN) persist.scheduleCollabPersist(room);
      if (origin === 'redis' || origin === persist.COLLAB_LOAD_ORIGIN) return;
      const admission = room.admission;
      if (!admission) return;
      const except = typeof origin === 'string' ? origin : undefined;
      void publish(room.pageId, {
        origin: podId,
        kind: 'sync',
        update: b64(update),
        lifecycleRevision: room.lifecycleRevision,
        admission,
      });
      forwardUpdate(room, update, except);
    });
    room.awareness.on('update', ({ added, updated, removed }: {
      added: number[];
      updated: number[];
      removed: number[];
    }, origin: unknown) => {
      if (typeof origin === 'string' && origin !== 'redis') {
        const socket = room.sockets.get(origin);
        if (socket) {
          for (const id of added.concat(updated)) socket.awarenessClientIds.add(id);
          for (const id of removed) socket.awarenessClientIds.delete(id);
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

  /** HTML-only readers have provisional Yjs identities, never a writable seed. */
  function adoptPersistedDocument(room: CollabRoom, canonical: Y.Doc): void {
    if (room.hasPersistedDoc) {
      // A peer may have adopted the same canonical seed while initialization
      // awaited its SQL commit. Merge that seed without losing newer updates.
      Y.applyUpdate(room.doc, Y.encodeStateAsUpdate(canonical), persist.COLLAB_LOAD_ORIGIN);
      canonical.destroy();
      return;
    }
    const readers = [...room.sockets.values()];
    room.sockets.clear();
    for (const reader of readers) {
      sendBin(reader.ws, encodeControlFrame({ type: 'doc_reset' }));
      try { reader.ws.close(1001, 'doc_reset'); } catch { /* already closing */ }
    }
    room.awareness.destroy();
    room.doc.destroy();
    room.doc = canonical;
    room.awareness = new awarenessProtocol.Awareness(canonical);
    room.awareness.setLocalState(null);
    room.hasPersistedDoc = true;
    wireDoc(room);
  }

  async function actuallyCreate(pageId: number): Promise<CollabRoom> {
    const existing = rooms.get(pageId);
    if (existing) return existing;
    const doc = new Y.Doc();
    const awareness = new awarenessProtocol.Awareness(doc);
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
      persistError: null,
      persistable: false,
      initializing: null,
      pagesVersion: 0,
      lastWriterUserId: null,
      heldActiveSuffixes: new Set(),
      admission: null,
      lifecycleRevision: '0',
      isFrozen: false,
      baselineId: null,
      demotionReason: null,
      hasPersistedDoc: false,
    };
    wireDoc(room);
    rooms.set(pageId, room);
    try {
      const loaded = await persist.loadOrInitCollabDoc(pageId, room.doc);
      if (loaded === 'missing') {
        rooms.delete(pageId);
        room.doc.destroy();
        throw new Error('Collaborative page is missing');
      }
      room.pagesVersion = loaded.pagesVersion;
      room.lifecycleRevision = loaded.lifecycleRevision;
      room.isFrozen = loaded.isFrozen;
      room.baselineId = loaded.baselineId;
      room.hasPersistedDoc = loaded.hasPersistedDoc;

      room.attached = true;
      void flush(room);
      return room;
    } catch (err) {
      rooms.delete(pageId);
      try { room.doc.destroy(); } catch { /* already destroyed */ }
      logger.warn({ err, pageId }, 'collab: persist init failed');
      throw err;
    }
  }

  async function getOrCreateRoom(pageId: number): Promise<CollabRoom> {
    if (closing) {
      throw new PageWriteError(503, 'collab_state_unavailable', 'Collaboration runtime is closing');
    }
    const creating = inflight.get(pageId);
    if (creating) return creating;
    const existing = rooms.get(pageId);
    if (existing) {
      // Once the last writer's flush released its admission, an ordinary HTTP
      // write may delete the BYTEA row while this clean room waits out its
      // grace period. Rebuild from PostgreSQL on the next join rather than
      // reviving the pre-write heap document.
      if (
        existing.sockets.size === 0
        && !existing.admission
        && existing.heldActiveSuffixes.size === 0
      ) {
        clearTimeout(existing.emptyGrace ?? undefined);
        existing.emptyGrace = null;
        rooms.delete(pageId);
        persist.endCollabReset(pageId);
        existing.doc.destroy();
      } else {
        return existing;
      }
    }
    const created = actuallyCreate(pageId).finally(() => inflight.delete(pageId));
    inflight.set(pageId, created);
    return created;
  }

  async function ensureWritableAdmission(
    room: CollabRoom,
    userId: string,
    expectedLifecycleRevision?: string,
  ): Promise<boolean> {
    if (room.admission) {
      // An unreadable admission is not an absent one. Keep ownership and
      // surface the failure rather than leaking this token behind a new one.
      await withPageWriteTransaction([room.pageId], async () => undefined, { admission: room.admission });
      return expectedLifecycleRevision === undefined
        || room.admission.lifecycleRevision === expectedLifecycleRevision;
    }
    const initializing = (async () => {
      let acquired: PageRuntimeAdmission | null = null;
      try {
        acquired = await admitPageRuntime(room.pageId, userId, 'collab_room');
        if (
          expectedLifecycleRevision !== undefined
          && acquired.lifecycleRevision !== expectedLifecycleRevision
        ) {
          await releasePageRuntime(acquired);
          room.lifecycleRevision = acquired.lifecycleRevision;
          room.persistable = false;
          room.demotionReason = 'lifecycle_changed';
          return false;
        }
        const wasProvisional = !room.hasPersistedDoc;
        if (wasProvisional) {
          const canonical = new Y.Doc();
          try {
            const loaded = await persist.loadOrInitCollabDoc(room.pageId, canonical, acquired);
            if (loaded === 'missing') {
              throw new PageWriteError(409, 'collab_state_unavailable', 'The collaborative page is no longer available');
            }
            adoptPersistedDocument(room, canonical);
            room.pagesVersion = loaded.pagesVersion;
          } catch (error) {
            canonical.destroy();
            throw error;
          }
        }
        room.admission = acquired;
        room.lifecycleRevision = acquired.lifecycleRevision;
        room.isFrozen = false;
        room.baselineId = null;
        room.demotionReason = null;
        room.persistable = true;
        room.lastWriterUserId = userId;
        await saddActive(room.pageId, 'room');
        room.heldActiveSuffixes.add('room');
        return true;
      } catch (err) {
        if (acquired) {
          room.admission ??= acquired;
          try {
            await releasePageRuntime(acquired);
            room.admission = null;
            room.persistable = false;
          } catch (releaseError) {
            logger.warn(
              { err: releaseError, pageId: room.pageId },
              'collab: failed join retained its durable admission',
            );
          }
        }
        if (err instanceof PageWriteError && err.reason === 'page_is_frozen') {
          const state = await query<{
            lifecycle_revision: string;
            baseline_id: string | null;
          }>('SELECT lifecycle_revision::text, baseline_id FROM pages WHERE id = $1', [room.pageId]);
          const row = state.rows[0];
          if (row) {
            room.lifecycleRevision = row.lifecycle_revision;
            room.isFrozen = row.baseline_id !== null;
            room.baselineId = row.baseline_id;
            room.demotionReason = 'page_frozen';
          }
          return false;
        }
        throw err;
      }
    })();
    room.initializing = initializing;
    try {
      return await initializing;
    } finally {
      room.initializing = null;
    }
  }

  async function prepareCommitSnapshot(
    pageId: number,
    userId: string,
    expectedLifecycleRevision: string,
  ): Promise<{ admission: PageRuntimeAdmission; html: string; documentState: Y.Snapshot }> {
    const room = await getOrCreateRoom(pageId);
    let admission: PageRuntimeAdmission | undefined;
    try {
      admission = await admitPageRuntime(pageId, userId, 'collab_request');
      if (admission.lifecycleRevision !== expectedLifecycleRevision) {
        throw new PageWriteError(
          409, 'stale_lifecycle',
          'The page lifecycle changed after the collaborative editing session began',
        );
      }
      const snapshot = await withFreshRoomState(room, admission, () => ({
        html: yDocToHtml(room.doc),
        documentState: Y.snapshot(room.doc),
      }));
      return { admission, ...snapshot };
    } catch (error) {
      if (admission) {
        try {
          await releasePageRuntime(admission);
        } catch (releaseError) {
          deferPageRequestAdmissionRelease(admission);
          logger.warn({ err: releaseError, pageId }, 'collab: snapshot request cleanup deferred');
        }
      }
      throw error;
    } finally {
      if (room.sockets.size === 0 && !room.admission) {
        await dropRoomOwned(pageId, room).catch((error) => {
          logger.warn({ err: error, pageId }, 'collab: transient snapshot room cleanup deferred');
        });
      }
    }
  }

  function recordReadonlyViolation(room: CollabRoom, socket: CollabSocket): CollabInboundResult {
    socket.readonlyDrops += 1;
    logger.info({ pageId: room.pageId, userId: socket.userId, connId: socket.id }, 'collab.readonly_drop');
    return socket.readonlyDrops >= COLLAB_READONLY_DROP_LIMIT ? 'close_4403' : 'dropped';
  }

  async function handleInboundFrame(
    pageId: number,
    connId: string,
    buf: Uint8Array,
  ): Promise<CollabInboundResult> {
    const room = rooms.get(pageId);
    const socket = room?.sockets.get(connId);
    if (!room || !socket) return 'dropped';
    void refreshActiveTtl(pageId);
    const header = parseSyncSubtype(buf);
    if (!header) return 'dropped';

    const syncMutation = header.messageType === MESSAGE_SYNC
      && (header.syncSubtype === SYNC_STEP2 || header.syncSubtype === SYNC_UPDATE);
    const allowedReadonly = header.messageType === MESSAGE_AWARENESS
      || header.messageType === MESSAGE_QUERY_AWARENESS
      || (header.messageType === MESSAGE_SYNC && header.syncSubtype === SYNC_STEP1);
    if (syncMutation && !transportAvailable()) {
      socket.writable = false;
      try { socket.ws.close(1001, 'collab_transport_unavailable'); } catch { /* already closing */ }
      return 'dropped';
    }
    if (!socket.writable && !allowedReadonly) return recordReadonlyViolation(room, socket);
    if (header.messageType === MESSAGE_SYNC && !allowedReadonly && !syncMutation) {
      return socket.writable ? 'dropped' : recordReadonlyViolation(room, socket);
    }

    try {
      if (header.messageType === MESSAGE_SYNC) {
        const apply = (): void => {
          const decoder = decoding.createDecoder(buf);
          decoding.readVarUint(decoder);
          const encoder = encoding.createEncoder();
          encoding.writeVarUint(encoder, MESSAGE_SYNC);
          syncProtocol.readSyncMessage(decoder, encoder, room.doc, connId);
          if (encoding.length(encoder) > 1) sendBin(socket.ws, encoding.toUint8Array(encoder));
        };
        if (syncMutation) {
          const admission = room.admission;
          if (!admission) {
            socket.writable = false;
            return recordReadonlyViolation(room, socket);
          }
          try {
            let applied = false;
            await withPageWriteTransaction([pageId], async () => {
              // Disconnect/demotion can win while this frame waits for the
              // lifecycle lock. It must not write behind their final flush.
              if (rooms.get(pageId) !== room || room.sockets.get(connId) !== socket
                || !socket.writable || room.admission?.id !== admission.id) return;
              apply();
              applied = true;
            }, { admission });
            if (!applied) return 'dropped';
          } catch (err) {
            // A failed read is not a released token. Keep ownership until
            // the disconnect flush or an authoritative retirement confirms it.
            socket.writable = false;
            logger.info({ err, pageId, connId }, 'collab.packet_fenced');
            try { socket.ws.close(1001, 'collab_validation_unavailable'); } catch { /* already closing */ }
            return 'dropped';
          }
        } else {
          apply();
        }
        return 'ok';
      }
      if (header.messageType === MESSAGE_AWARENESS) {
        const decoder = decoding.createDecoder(buf);
        decoding.readVarUint(decoder);
        let update = decoding.readVarUint8Array(decoder);
        if (socket.identity) update = stampAwarenessIdentity(update, socket.identity);
        awarenessProtocol.applyAwarenessUpdate(room.awareness, update, connId);
        return 'ok';
      }
      if (header.messageType === MESSAGE_QUERY_AWARENESS) {
        sendAwarenessSnapshot(room, socket.ws);
        return 'ok';
      }
    } catch (err) {
      logger.debug({ err, pageId }, 'collab: inbound frame parse failed');
    }
    return 'dropped';
  }

  async function attachSocket(
    pageId: number,
    socket: Omit<CollabSocket, 'readonlyDrops' | 'awarenessClientIds' | 'writableRefusalReason'> & {
      expectedLifecycleRevision?: string | null;
    },
  ): Promise<CollabSocket> {
    let room = await getOrCreateRoom(pageId);
    const expectedLifecycleRevision = socket.expectedLifecycleRevision;
    // Bind every join to authoritative PostgreSQL lifecycle state. A client
    // revision is never evidence that an in-memory room is stale (otherwise a
    // forged future revision could demote active editors).
    await applyAuthoritativeLifecycle(room);
    if (rooms.get(pageId) !== room) room = await getOrCreateRoom(pageId);
    if (room.demotionReason && room.sockets.size === 0) {
      await dropRoomOwned(pageId, room);
      room = await getOrCreateRoom(pageId);
    }
    if (room.emptyGrace) {
      clearTimeout(room.emptyGrace);
      room.emptyGrace = null;
    }
    let refusalReason: CollabSocket['writableRefusalReason'];
    if (socket.writable && expectedLifecycleRevision === null) {
      refusalReason = 'lifecycle_revision_required';
    } else if (
      socket.writable
      && expectedLifecycleRevision !== undefined
      && expectedLifecycleRevision !== room.lifecycleRevision
    ) {
      refusalReason = 'lifecycle_revision_stale';
    }
    const writable = socket.writable
      && refusalReason === undefined
      && room.demotionReason === null
      && await ensureWritableAdmission(
        room,
        socket.userId,
        expectedLifecycleRevision ?? undefined,
      );
    if (writable && room.admission) {
      try {
        await withFreshRoomState(room, room.admission, () => undefined);
      } catch (error) {
        await releaseAdmissionIfNoWriters(room).catch((cleanupError) => {
          logger.warn({ err: cleanupError, pageId }, 'collab: failed join retained its admission');
        });
        throw error;
      }
    }
    if (!socket.writable) await refreshReaderRoom(room);
    if (
      socket.writable
      && !writable
      && refusalReason === undefined
      && !room.isFrozen
      && expectedLifecycleRevision !== undefined
    ) {
      refusalReason = 'lifecycle_revision_stale';
    }
    const full: CollabSocket = {
      id: socket.id,
      ws: socket.ws,
      userId: socket.userId,
      writable,
      readonlyDrops: 0,
      awarenessClientIds: new Set(),
      ...(socket.identity ? { identity: socket.identity } : {}),
      ...(refusalReason ? { writableRefusalReason: refusalReason } : {}),
    };
    if (full.ws.readyState !== 1) {
      full.writable = false;
      await releaseAdmissionIfNoWriters(room);
      return full;
    }
    room.sockets.set(full.id, full);
    if (writable) {
      await saddActive(pageId, full.id);
      room.heldActiveSuffixes.add(full.id);
    }
    // A close or permission loss may have arrived during Redis bookkeeping.
    if (rooms.get(pageId) !== room || room.sockets.get(full.id) !== full || full.ws.readyState !== 1) {
      full.writable = false;
      room.sockets.delete(full.id);
      await releaseAdmissionIfNoWriters(room);
      return full;
    }
    sendAwarenessSnapshot(room, full.ws);
    sendBin(full.ws, encodeControlFrame(lifecycleControl(room)));
    if (full.writable) {
      sendBin(full.ws, encodeControlFrame({
        type: 'writable_admission',
        lifecycleRevision: room.lifecycleRevision,
      }));
    } else if (refusalReason) {
      sendBin(full.ws, encodeControlFrame({
        type: 'writable_refused',
        reason: refusalReason,
        expectedLifecycleRevision: expectedLifecycleRevision ?? null,
        currentLifecycleRevision: room.lifecycleRevision,
      }));
    } else if (!socket.writable) {
      sendBin(full.ws, encodeControlFrame({
        type: 'permission_loss',
        reason: 'edit_permission_revoked',
      }));
    }
    logger.info({ pageId, userId: full.userId, writable: full.writable, connId: full.id }, 'collab.join');
    return full;
  }

  async function detachSocket(pageId: number, connId: string): Promise<void> {
    const room = rooms.get(pageId);
    if (!room) return;
    const socket = room.sockets.get(connId);
    if (!socket) return;
    room.sockets.delete(connId);
    logger.info({ pageId, userId: socket.userId, writable: socket.writable, connId }, 'collab.leave');
    if (socket.awarenessClientIds.size > 0) {
      awarenessProtocol.removeAwarenessStates(room.awareness, [...socket.awarenessClientIds], connId);
    }
    if (socket.writable) {
      await sremSuffixes(pageId, [connId]);
      room.heldActiveSuffixes.delete(connId);
    }
    try {
      await withRoomOwnership(pageId, () => releaseAdmissionIfNoWriters(room));
    } catch (err) {
      logger.warn({ err, pageId }, 'collab: disconnect flush failed; admission retained');
    }
    if (
      room.sockets.size === 0
      && socket?.writableRefusalReason === 'lifecycle_revision_stale'
    ) {
      await dropRoom(pageId, room);
      return;
    }
    if (room.sockets.size > 0 || room.emptyGrace) return;
    if (room.demotionReason) {
      await dropRoom(pageId, room);
      return;
    }
    room.emptyGrace = setTimeout(() => {
      void dropRoom(pageId, room).catch((err) => {
        logger.warn({ err, pageId }, 'collab: empty room drop deferred');
      });
    }, COLLAB_EMPTY_ROOM_GRACE_MS);
    if (typeof room.emptyGrace.unref === 'function') room.emptyGrace.unref();
  }

  async function closeRoomSockets(room: CollabRoom, code: number, reason: string): Promise<void> {
    if (reason === 'doc_reset') {
      const frame = encodeControlFrame({ type: 'doc_reset' });
      for (const socket of room.sockets.values()) sendBin(socket.ws, frame);
    }
    for (const socket of room.sockets.values()) {
      try { socket.ws.close(code, reason); } catch { /* already closing */ }
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
    try {
      if (reason === 'doc_reset') {
        await room.persistChain.catch(() => undefined);
        if (room.admission) {
          const admission = room.admission;
          await releasePageRuntime(admission);
          if (room.admission?.id === admission.id) room.admission = null;
        }
      } else {
        await releaseAdmissionIfNoWriters(room);
      }
    } catch (err) {
      // The heap is going away regardless (shutdown, tombstone, or reset).
      // Retain an uncertain durable admission so another writer remains
      // fenced, but do not let one failed flush strand other rooms, timers, or
      // the Redis subscription during teardown.
      logger.warn({ err, pageId: room.pageId }, 'collab: room close retained durable admission');
    }
    await sremSuffixes(room.pageId, room.heldActiveSuffixes);
    room.heldActiveSuffixes.clear();
    persist.endCollabReset(room.pageId);
    room.doc.destroy();
  }

  async function dropRoomOwned(pageId: number, room = rooms.get(pageId)): Promise<void> {
    if (!room || rooms.get(pageId) !== room || room.sockets.size > 0) return;
    await releaseAdmissionIfNoWriters(room);
    if (rooms.get(pageId) !== room || room.sockets.size > 0 || room.admission) return;
    rooms.delete(pageId);
    if (room.emptyGrace) {
      clearTimeout(room.emptyGrace);
      room.emptyGrace = null;
    }
    await sremSuffixes(pageId, room.heldActiveSuffixes);
    persist.endCollabReset(pageId);
    room.doc.destroy();
  }

  function dropRoom(pageId: number, room = rooms.get(pageId)): Promise<void> {
    return withRoomOwnership(pageId, () => dropRoomOwned(pageId, room));
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

  async function applyAuthoritativeLifecycle(room: CollabRoom): Promise<void> {
    const result = await query<{
      lifecycle_revision: string;
      baseline_id: string | null;
    }>('SELECT lifecycle_revision::text, baseline_id FROM pages WHERE id = $1', [room.pageId]);
    const row = result.rows[0];
    if (!row || rooms.get(room.pageId) !== room || BigInt(row.lifecycle_revision) <= BigInt(room.lifecycleRevision)) return;
    room.lifecycleRevision = row.lifecycle_revision;
    room.isFrozen = row.baseline_id !== null;
    room.baselineId = row.baseline_id;
    const retiredAdmission = room.admission;
    dumpRounds.get(room.pageId)?.finish(false);
    room.persistable = false;
    room.demotionReason = room.isFrozen ? 'page_frozen' : 'lifecycle_changed';
    if (room.persistTimer) {
      clearTimeout(room.persistTimer);
      room.persistTimer = null;
    }
    for (const socket of room.sockets.values()) socket.writable = false;
    await sremSuffixes(room.pageId, room.heldActiveSuffixes);
    room.heldActiveSuffixes.clear();
    sendControl(room, lifecycleControl(room));
    // The browser retains its document as a read-only draft. Retire its old
    // server membership so it cannot prevent an explicit fresh join after thaw.
    const staleSockets = [...room.sockets.values()];
    room.sockets.clear();
    for (const socket of staleSockets) {
      try { socket.ws.close(1001, 'lifecycle_changed'); } catch { /* already closing */ }
    }
    await room.persistChain.catch(() => undefined);
    if (retiredAdmission) {
      await releasePageRuntime(retiredAdmission);
      if (room.admission?.id === retiredAdmission.id) room.admission = null;
    }
    await dropRoomOwned(room.pageId, room);
  }

  async function handleLifecycleEvent(event: PageLifecycleEvent): Promise<void> {
    const room = rooms.get(event.pageId);
    if (!room || BigInt(event.lifecycleRevision) <= BigInt(room.lifecycleRevision)) return;
    await applyAuthoritativeLifecycle(room);
  }

  async function refreshLifecycleRooms(): Promise<void> {
    await Promise.all([...rooms.values()].map((room) =>
      withRoomOwnership(room.pageId, () => applyAuthoritativeLifecycle(room))));
  }

  async function resetFromHtml(pageId: number, html: string): Promise<void> {
    persist.beginCollabReset(pageId);
    const room = rooms.get(pageId);
    if (room) freezeTransientRoom(room);
    await publish(pageId, {
      origin: podId,
      kind: 'freeze',
      reason: 'doc_reset',
      lifecycleRevision: room?.lifecycleRevision,
    });
    try {
      if (room) await room.persistChain.catch(() => undefined);
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
    try { await main.del(activeKey(pageId)); } catch { /* best effort */ }
    logger.info({ pageId, code }, 'collab.tombstone');
  }

  async function tombstoneAll(code: number, reason = 'tombstone'): Promise<void> {
    for (const id of [...rooms.keys()]) {
      await withRoomOwnership(id, () => tombstone(id, code, reason));
    }
  }

  function invalidateTransport(): void {
    if (closing) return;
    transportGeneration += 1;
    for (const round of dumpRounds.values()) round.finish(false);
    for (const room of rooms.values()) {
      for (const socket of room.sockets.values()) {
        socket.writable = false;
        try { socket.ws.close(1001, 'collab_transport_unavailable'); } catch { /* already closing */ }
      }
    }
  }

  main.on('reconnecting', invalidateTransport);
  main.on('end', invalidateTransport);
  try {
    const sub = main.duplicate() as RedisClientType;
    sub.on('error', (err) => logger.error({ err }, 'collab-room-service: subscriber client error'));
    sub.on('reconnecting', invalidateTransport);
    sub.on('end', invalidateTransport);
    await sub.connect();
    await sub.pSubscribe(CHANNEL_PATTERN, (message, channel) => {
      const pageId = parseChannel(channel);
      const room = pageId === null ? undefined : rooms.get(pageId);
      if (!room) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(message);
      } catch (err) {
        logger.warn({ err }, 'collab-room-service: failed to parse pub/sub payload');
        return;
      }
      if (!parsed || typeof parsed !== 'object' || !('origin' in parsed) || !('kind' in parsed)) return;
      const candidate = parsed as CollabBusMessage;
      if (typeof candidate.origin !== 'string' || typeof candidate.kind !== 'string') return;
      enqueue(room, candidate);
    });
    subscriber = sub;
    logger.info({ podId }, 'collab-room-service: subscriber active');
  } catch (err) {
    logger.warn({ err }, 'collab-room-service: subscriber unavailable; writable joins remain closed');
  }

  async function close(): Promise<void> {
    closing = true;
    main.off('reconnecting', invalidateTransport);
    main.off('end', invalidateTransport);
    for (const round of dumpRounds.values()) round.finish(false);
    await Promise.all([...ownership.values()]);
    for (const id of [...rooms.keys()]) {
      await withRoomOwnership(id, async () => {
        const room = rooms.get(id);
        if (!room) return;
        await closeRoomSockets(room, 1001, 'shutdown');
        rooms.delete(id);
      });
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
    getOrCreateRoom: (pageId) => withRoomOwnership(pageId, async () => {
      const room = await getOrCreateRoom(pageId);
      await refreshReaderRoom(room);
      return room;
    }),
    getRoom: (pageId) => rooms.get(pageId),
    attachSocket: (pageId, socket) => withRoomOwnership(pageId, () => attachSocket(pageId, socket)),
    detachSocket,
    demoteSocket,
    handleInboundFrame,
    refreshActiveTtl,
    tombstone: (pageId, code, reason) => withRoomOwnership(pageId, () => tombstone(pageId, code, reason)),
    tombstoneAll,
    broadcastControl,
    prepareCommitSnapshot: (pageId, userId, revision) =>
      withRoomOwnership(pageId, () => prepareCommitSnapshot(pageId, userId, revision)),
    handleLifecycleEvent: (event) =>
      withRoomOwnership(event.pageId, () => handleLifecycleEvent(event)),
    refreshLifecycleRooms,
    dropRoom,
    resetFromHtml: (pageId, html) => withRoomOwnership(pageId, () => resetFromHtml(pageId, html)),
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

/** Must be registered after initCacheBus; Main owns application startup order. */
export function initCollabLifecycleBus(): () => void {
  lifecycleBusUnsubscribe?.();
  lifecycleReconnectUnsubscribe?.();
  lifecycleBusUnsubscribe = subscribe<unknown>('page:lifecycle', async (payload) => {
    const parsed = PageLifecycleEventSchema.safeParse(payload);
    if (!parsed.success) {
      logger.warn({ issues: parsed.error.issues }, 'collab: invalid page lifecycle event');
      return;
    }
    await defaultRuntime?.handleLifecycleEvent(parsed.data);
  });
  lifecycleReconnectUnsubscribe = onReconnect(async () => {
    await defaultRuntime?.refreshLifecycleRooms();
  });
  return () => {
    lifecycleBusUnsubscribe?.();
    lifecycleReconnectUnsubscribe?.();
    lifecycleBusUnsubscribe = null;
    lifecycleReconnectUnsubscribe = null;
  };
}

export function getDefaultCollabRuntime(): CollabRuntime | null {
  return defaultRuntime;
}

export async function resetCollabRoomFromHtml(pageId: number, html: string): Promise<void> {
  const runtime = getDefaultCollabRuntime();
  if (runtime) await runtime.resetFromHtml(pageId, html);
  else await persist.replaceCollabDocFromHtml(pageId, html);
}

export async function tombstoneCollabRoom(pageId: number, code: number, reason?: string): Promise<void> {
  await defaultRuntime?.tombstone(pageId, code, reason);
}

export async function tombstoneAllCollabRooms(code: number, reason?: string): Promise<void> {
  await defaultRuntime?.tombstoneAll(code, reason);
}

export async function refreshCollabActiveTtl(pageId: number): Promise<void> {
  if (defaultRuntime) {
    await defaultRuntime.refreshActiveTtl(pageId);
    return;
  }
  const redis = getRedisClient();
  if (!redis) return;
  try { await redis.expire(activeKey(pageId), COLLAB_ACTIVE_TTL_SEC); } catch { /* best effort */ }
}

export async function _resetCollabRoomsForTest(): Promise<void> {
  await defaultRuntime?.tombstoneAll(1001, 'test_reset');
}
