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
  type CollabCommitUnknownControl,
  type CollabDocEpochControl,
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
  collabCommitDeadlineMs,
  deferPageRequestAdmissionRelease,
  isCollabCommitPending,
  isCollabCommitUnknown,
  PageWriteError,
  processCollabCommitLatches,
  readCollabCommitState,
  releasePageRuntime,
  releasePageRuntimeForDeletedPage,
  withCollabCommitKnown,
  withRedisCommandDeadline,
  withPageLifecycleRead,
  withPageWriteTransaction,
  type CollabCommitLatches,
  type PageRuntimeAdmission,
} from './page-write-admission.js';
import * as persist from './collab-persistence.js';
import {
  collabCarriesTaskIds,
  collabTaskItems,
  markAttachmentImages,
  markTaskIds,
  yDocToHtml,
  type AttachmentImageMarker,
  type CollabTaskItem,
  type TaskIdMarker,
} from './collab-schema.js';
import { isConfluenceTaskId } from './confluence-task-id.js';

export const COLLAB_ACTIVE_TTL_SEC = vitestIntOr('COLLAB_ACTIVE_TTL_SEC', 45);
export const COLLAB_PING_INTERVAL_MS = vitestIntOr('COLLAB_PING_INTERVAL_MS', 15_000);
export const COLLAB_READONLY_DROP_LIMIT = 8;
export const COLLAB_EMPTY_ROOM_GRACE_MS = vitestIntOr('COLLAB_EMPTY_ROOM_GRACE_MS', 10_000);
/**
 * Delay before retry `attempt` (from 0) of a last-writer release that its
 * page's own pending collaborative Save deferred (#1763): 1 s
 * (`COLLAB_DEFERRED_RELEASE_RETRY_MS`, read per call so a test can change it),
 * doubling, capped at 30 s.
 */
export function deferredReleaseDelayMs(attempt: number): number {
  return Math.min(vitestIntOr('COLLAB_DEFERRED_RELEASE_RETRY_MS', 1_000) * 2 ** attempt, 30_000);
}
/** Rounds allowed for the owner set to hold still before a read is refused. */
const OWNER_CORRELATION_ATTEMPTS = 3;

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
/**
 * Origin of the post-commit image-marker transaction (#1764). Not a connection
 * id, so `doc.on('update')` persists it, publishes it once as `sync` and sends
 * it to every socket; peers apply that `sync` as `'redis'` and never echo it.
 */
export const COLLAB_IMAGE_MARKER_ORIGIN = Symbol('collab-image-markers');
/** Origin of the post-commit task-id transaction (#1751); handled like COLLAB_IMAGE_MARKER_ORIGIN. */
export const COLLAB_TASK_ID_ORIGIN = Symbol('collab-task-ids');

export type CollabControl =
  | { type: 'pages_version'; version: number }
  | { type: 'doc_reset' }
  | { type: 'tombstone' }
  | PageLifecycleEvent
  | CollabWritableAdmissionControl
  | CollabDocEpochControl
  | CollabCommitUnknownControl
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
  | 'state_dump'
  | 'image_markers'
  | 'task_ids'
  | 'commit_unknown';

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
  markers?: AttachmentImageMarker[];
  taskIds?: TaskIdMarker[];
  /** The sender's document epoch (#2034). A pod older than that change sends none. */
  docEpoch?: string;
  /** On a `doc_reset` tombstone: a retire hint, a prompt to re-read the row, not a reset. */
  hint?: boolean;
  /** On a `commit_unknown` cue (#2035): the collaborative commit whose outcome its owner declared unknown. */
  intentId?: string;
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
  /**
   * The join's declaration fits the room's persisted document (#2034): it
   * named that document's epoch, or it said the client holds no document at
   * all (a claim the server cannot check; such a client has nothing of
   * another lineage to bring). Kept by the server for this socket; false for
   * every read-only socket and for a join that declared nothing.
   */
  lineageVerified: boolean;
  /** The join was refused for its document lineage: `doc_reset` was sent, the socket closed and never attached. */
  joinRefused?: 'doc_reset';
  /**
   * The unknown collaborative commit this socket was sent `commit_unknown`
   * for (#2035); a repeated cue for the same intent sends nothing more.
   */
  commitUnknownIntentId?: string;
  /**
   * The socket lost, or was not given, write authority only because the
   * page's own collaborative commit is unknown (#2035). Its mutating frames
   * are dropped without counting as read-only violations.
   */
  commitUnknownGated?: boolean;
}

/**
 * The gateway's reading of the join's lineage declaration (#2034), the
 * `expectedDocEpoch` and `expectedDocEmpty` parameters: nothing, "I hold no
 * document", "I hold the document of this epoch", or anything else.
 */
export type CollabDocEpochDeclaration =
  | { kind: 'absent' }
  | { kind: 'empty' }
  | { kind: 'malformed' }
  | { kind: 'declared'; epoch: string };

export type CollabSocketJoin = Pick<CollabSocket, 'id' | 'ws' | 'userId' | 'writable' | 'identity'> & {
  expectedLifecycleRevision?: string | null;
  /** Omitted means `absent`. */
  expectedDocEpoch?: CollabDocEpochDeclaration;
};

export type CollabCommitSnapshot = {
  admission: PageRuntimeAdmission;
  html: string;
  documentState: Y.Snapshot;
  /** The snapshot's task items, in the order of `html` (#1751). */
  taskItems: CollabTaskItem[];
  /** Whether the room's tasks carry Confluence task ids (#1751; collabCarriesTaskIds). */
  taskIdsCarried: boolean;
  /** Lineage of the snapshotted document; the Save's post-commit marks carry it (#2034). */
  docEpoch: string;
};

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
  /** Retry of a last-writer release that the page's own pending collaborative Save deferred (#1763). */
  deferredRelease: ReturnType<typeof setTimeout> | null;
  /** Above 0 while such a deferral is outstanding, including a retry that is running. */
  deferredReleaseAttempts: number;
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
  /**
   * `page_collaborative_docs.doc_epoch` of the row this document was loaded
   * from, seeded as or adopted from (#2034). Null exactly while the room has no
   * persisted document (`hasPersistedDoc` false).
   */
  docEpoch: string | null;
  /** A proven lineage retirement is queued; frames are dropped until it runs. */
  lineageRetiring: boolean;
  /** An older pod announced its in-place reset (untagged `freeze`): no persist and no state dump until its tombstone. */
  resetFrozen: boolean;
  /**
   * The page's collaborative commit that a cue or the Redis latch declared
   * unknown on this pod before its durable marker was read (#2035). It raises
   * `in_flight` to `unknown` for that intent only and is cleared when the
   * durable read shows another intent or none.
   */
  unknownCommitIntentId: string | null;
  onLineageChanged: (docEpoch: string) => void;
}

export type CollabInboundResult = 'ok' | 'dropped' | 'close_4403';

export interface CollabRuntime {
  podId: string;
  getOrCreateRoom: (pageId: number) => Promise<CollabRoom>;
  getRoom: (pageId: number) => CollabRoom | undefined;
  attachSocket: (pageId: number, socket: CollabSocketJoin) => Promise<CollabSocket>;
  detachSocket: (pageId: number, connId: string) => Promise<void>;
  demoteSocket: (pageId: number, connId: string) => Promise<void>;
  handleInboundFrame: (pageId: number, connId: string, buf: Uint8Array) => Promise<CollabInboundResult>;
  refreshActiveTtl: (pageId: number) => Promise<void>;
  tombstone: (pageId: number, code: number, reason?: string) => Promise<void>;
  tombstoneAll: (code: number, reason?: string) => Promise<void>;
  broadcastControl: (pageId: number, control: CollabControl) => void;
  /** After a settled Confluence commit, mark the images it uploaded in the owning room and the persisted document (#1764). */
  markUploadedImages: (
    pageId: number,
    admission: PageRuntimeAdmission,
    markers: readonly AttachmentImageMarker[],
    docEpoch: string,
  ) => Promise<void>;
  /** After a settled Confluence commit, store the task ids it wrote in the owning room and the persisted document (#1751). */
  markWrittenTaskIds: (
    pageId: number,
    admission: PageRuntimeAdmission,
    markers: readonly TaskIdMarker[],
    docEpoch: string,
  ) => Promise<void>;
  prepareCommitSnapshot: (
    pageId: number,
    userId: string,
    expectedLifecycleRevision: string,
  ) => Promise<CollabCommitSnapshot>;
  handleLifecycleEvent: (event: PageLifecycleEvent) => Promise<void>;
  refreshLifecycleRooms: () => Promise<void>;
  dropRoom: (pageId: number) => Promise<void>;
  /**
   * After an inbound publication deleted the page's collaborative row in its
   * own transaction: prompt the local room and, over Redis, every other pod's
   * room to re-read the row. A room retires only when its own row is gone or
   * replaced (#2034).
   */
  hintDocRetired: (pageId: number) => Promise<void>;
  /**
   * The owner's cue that the page's own collaborative commit failed after
   * dispatch (#2035): the local room and, over Redis, every other pod's room
   * re-read the durable state under the lifecycle lock and demote their
   * writable sockets while that intent is still pending. Never blocks. The cue
   * is only a prompt; the frame and join fences are the barrier.
   */
  announceCommitUnknown: (pageId: number, intentId: string) => void;
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

/** Markers from a peer's `image_markers` message; anything malformed marks nothing (#1764). */
function busImageMarkers(value: unknown): AttachmentImageMarker[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const markers: AttachmentImageMarker[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) return null;
    const { src, filename } = entry as Record<string, unknown>;
    if (
      typeof src !== 'string' || !src.startsWith('/api/attachments/')
      || typeof filename !== 'string' || filename.length === 0
    ) return null;
    markers.push({ src, filename });
  }
  return markers;
}

/**
 * Task ids from a peer's `task_ids` message; an empty list only records that
 * the room's tasks carry ids. Anything malformed marks nothing (#1751).
 */
function busTaskIdMarkers(value: unknown): TaskIdMarker[] | null {
  if (!Array.isArray(value)) return null;
  const markers: TaskIdMarker[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) return null;
    const { client, clock, taskId } = entry as Record<string, unknown>;
    if (
      !Number.isSafeInteger(client) || (client as number) < 0
      || !Number.isSafeInteger(clock) || (clock as number) < 0
      || typeof taskId !== 'string' || !isConfluenceTaskId(taskId)
    ) return null;
    markers.push({ client: client as number, clock: clock as number, taskId });
  }
  return markers;
}

/**
 * Why a best-effort post-commit mark did not happen (#1764, #1751). A refusal
 * by the page-write fence (the lifecycle changed, the page is frozen, another
 * write is pending, the admission was retired) is an expected outcome; the
 * next Save then uploads the image again, or takes the task id back from the
 * stored storage by its text. Anything else is a failure.
 */
function logMarksSkipped(
  kind: 'image_markers' | 'task_ids',
  error: unknown,
  pageId: number,
  step: 'room' | 'persisted',
): void {
  if (error instanceof PageWriteError) {
    logger.info({ pageId, step, reason: error.reason }, `collab.${kind}_refused`);
    return;
  }
  logger.warn({ err: error, pageId, step }, `collab.${kind}_failed`);
}

/** How a room's document lineage ended, as the rows prove it (#2034). */
type LineageEnd = 'superseded' | 'page_deleted';

/** How a join's epoch decision ends that join attempt without an admission (#2034). */
class JoinLineageRefusal extends Error {
  constructor(readonly outcome: 'refuse_socket' | 'stale_heap') {
    super(`collab join lineage: ${outcome}`);
    this.name = 'JoinLineageRefusal';
  }
}

function epochTag(room: CollabRoom): { docEpoch?: string } {
  return room.docEpoch === null ? {} : { docEpoch: room.docEpoch };
}

/** Both lists come from `roomOwners`, ordered by admission id. */
function sameOwners(a: readonly PageRuntimeAdmission[], b: readonly PageRuntimeAdmission[]): boolean {
  return a.length === b.length && a.every((owner, index) => owner.id === b[index]!.id);
}

/** A peer's epoch tag; a pod older than #2034 sends none, and anything else is treated as none. */
function busDocEpoch(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Whether a join with this declaration may be writable in a room that holds
 * the document `docEpoch` (#2034). A declaration names the lineage of the
 * client's `Y.Doc`; only the room of that lineage may admit it. `absent`
 * claims nothing and is admitted as before; `empty` names no epoch, so it
 * cannot differ from any.
 */
function declarationAdmits(declaration: CollabDocEpochDeclaration, docEpoch: string | null): boolean {
  return declaration.kind === 'absent'
    || declaration.kind === 'empty'
    || (declaration.kind === 'declared' && declaration.epoch === docEpoch);
}

/**
 * Whether a writable join with this declaration is lineage-verified in a room
 * that holds the document `docEpoch`: the client's document is that lineage,
 * or the client holds none. Only called after every check of the join passed.
 */
function declarationVerifies(declaration: CollabDocEpochDeclaration, docEpoch: string | null): boolean {
  if (docEpoch === null) return false;
  return declaration.kind === 'empty'
    || (declaration.kind === 'declared' && declaration.epoch === docEpoch);
}

/**
 * Admission precondition of a join (#2034): inside the admission transaction,
 * under the page lifecycle lock that every invalidation, seed and inbound
 * publication also takes. A throw leaves no admission behind. False when the
 * join gets no decision here: the page is gone, or its lifecycle is not the
 * one the join expected, which keeps its existing outcome (the admission is
 * released again).
 */
async function assertJoinLineage(
  client: PoolClient,
  room: CollabRoom,
  expectedLifecycleRevision: string | undefined,
  declaration: CollabDocEpochDeclaration,
): Promise<boolean> {
  const state = await client.query<{ lifecycle_revision: string; doc_epoch: string | null }>(
    `SELECT p.lifecycle_revision::text, d.doc_epoch::text
       FROM pages p
  LEFT JOIN page_collaborative_docs d ON d.page_id = p.id
      WHERE p.id = $1`,
    [room.pageId],
  );
  const row = state.rows[0];
  if (!row) return false;
  if (expectedLifecycleRevision !== undefined && row.lifecycle_revision !== expectedLifecycleRevision) return false;
  // A stale heap first: it is retired and the join decided again on a fresh room.
  if (room.docEpoch !== null && row.doc_epoch !== room.docEpoch) {
    throw new JoinLineageRefusal('stale_heap');
  }
  if (!declarationAdmits(declaration, row.doc_epoch)) {
    throw new JoinLineageRefusal('refuse_socket');
  }
  return true;
}

export type CollabRuntimeOptions = {
  /**
   * The unknown-commit latches of the process this runtime stands for (#2035).
   * Defaults to this process's own. A test that runs a second runtime as
   * another process gives it its own, so it does not see this process's set.
   */
  commitLatches?: CollabCommitLatches;
};

export async function createCollabRuntime(
  main: RedisClientType,
  podId: string = randomUUID(),
  options: CollabRuntimeOptions = {},
): Promise<CollabRuntime> {
  const commitLatches = options.commitLatches ?? processCollabCommitLatches;
  const rooms = new Map<number, CollabRoom>();
  const inflight = new Map<number, Promise<CollabRoom>>();
  const ownership = new Map<number, Promise<void>>();
  const dumpRounds = new Map<number, {
    id: string;
    lifecycleRevision: string;
    remaining: Set<string>;
    finish: (ok: boolean) => void;
  }>();
  /** Lineage revalidations in flight, one per room. */
  const lineageChecks = new Map<CollabRoom, { again: boolean; done: Promise<void> }>();
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

  function adoptPersistedBytes(room: CollabRoom, persisted: { docState: Uint8Array; docEpoch: string }): void {
    const canonical = new Y.Doc();
    try {
      Y.applyUpdate(canonical, persisted.docState, persist.COLLAB_LOAD_ORIGIN);
      adoptPersistedDocument(room, canonical, persisted.docEpoch);
    } catch (error) {
      canonical.destroy();
      throw error;
    }
  }

  /**
   * Bring the persisted document into the room under the caller's lifecycle
   * lock. A room that holds a persisted document merges only the row of its
   * own epoch; a missing or replaced row answers `collab_lineage_changed`
   * before any byte is applied. A provisional room never merges persisted
   * bytes into its HTML seed: it adopts the persisted generation as a new
   * document and takes that row's epoch.
   */
  async function mergePersistedRoom(client: PoolClient, room: CollabRoom): Promise<void> {
    if (rooms.get(room.pageId) !== room) throw unavailableSnapshot();
    if (room.docEpoch !== null) {
      await persist.mergePersistedCollabDoc(client, room.pageId, room.doc, room.docEpoch);
      return;
    }
    const persisted = await persist.readPersistedCollabDoc(client, room.pageId);
    if (!persisted || rooms.get(room.pageId) !== room) throw unavailableSnapshot();
    adoptPersistedBytes(room, persisted);
  }

  /**
   * Correlate every room owner's state before the caller reads the document.
   *
   * The owner set is re-read after the dump round because a snapshot that
   * misses an owner is not the current state. A set that CHANGED, though, is
   * ordinary rather than fatal: another pod joining or leaving while the round
   * is in flight is exactly what this service exists to handle, and failing
   * the first attempt turned a concurrent join into a 503 for a legitimate
   * writable join. Only a set that will not hold still across
   * `OWNER_CORRELATION_ATTEMPTS` rounds is genuinely unconfirmable — each
   * attempt still requires one stable set, so the commit guarantee is intact.
   */
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
    for (let attempt = 1; ; attempt += 1) {
      assertCurrent();
      const owners = await withPageWriteTransaction([room.pageId], async (client) => {
        const currentOwners = await roomOwners(client, room);
        if (currentOwners.length === 0) throw unavailableSnapshot();
        await mergePersistedRoom(client, room);
        assertCurrent();
        return currentOwners;
      }, { admission, ownCollabCommit: 'proceed' });
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
          // Production waits 2 s. Vitest keeps that for answered rounds (a peer
          // dump transaction queues on the page lifecycle lock, which a loaded
          // runner can hold for longer than any short override); it is read per
          // round so a test can shorten only a round it leaves unanswered.
          timer = setTimeout(() => finish(false), vitestIntOr('COLLAB_COMMIT_DUMP_TIMEOUT_MS', 2_000));
          timer.unref();
          dumpRounds.set(room.pageId, {
            id: requestId, lifecycleRevision: room.lifecycleRevision, remaining, finish,
          });
        });
        // Never await a Redis offline queue past this round's deadline.
        void main.publish(docChannel(room.pageId), JSON.stringify({
          origin: podId, kind: 'state_dump_request', requestId,
          requestedAdmissions: [...remaining], lifecycleRevision: room.lifecycleRevision,
          ...epochTag(room),
        } satisfies CollabBusMessage)).catch(() => {
          const round = dumpRounds.get(room.pageId);
          if (round?.id === requestId) round.finish(false);
        });
        if (!(await received)) {
          // A silent owner may have been retired for its lineage and have
          // released its admission: the request above is its revalidation
          // prompt (#2034). Only a changed owner set permits another round, and
          // that round is completely new (its own request id, a fresh owner
          // set), so a late answer to this expired one cannot satisfy it. An
          // unchanged set fails closed: a current or unresolved owner that
          // stays silent is never dropped from the quorum.
          assertCurrent();
          const ownersNow = await withPageWriteTransaction(
            [room.pageId],
            (client) => roomOwners(client, room),
            { admission, ownCollabCommit: 'proceed' },
          );
          if (sameOwners(ownersNow, owners) || attempt >= OWNER_CORRELATION_ATTEMPTS) {
            throw unavailableSnapshot();
          }
          continue;
        }
      }
      const settled = await withPageWriteTransaction([room.pageId], async (client) => {
        const currentOwners = await roomOwners(client, room);
        if (!sameOwners(currentOwners, owners)) return null;
        await mergePersistedRoom(client, room);
        assertCurrent();
        return { value: snapshot() };
      }, { admission, ownCollabCommit: 'proceed' });
      if (settled) return settled.value;
      if (attempt >= OWNER_CORRELATION_ATTEMPTS) throw unavailableSnapshot();
    }
  }

  async function refreshReaderRoom(room: CollabRoom): Promise<void> {
    if (room.isFrozen || room.demotionReason !== null) return;
    const owners = await withPageWriteTransaction(
      [room.pageId],
      (client) => roomOwners(client, room),
      { ownCollabCommit: 'proceed' },
    );
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

  /**
   * Only a pod older than #2034 announces an in-place reset (`freeze`, then an
   * untagged `doc_reset` tombstone). This room stops persisting and ignores
   * state dumps until that tombstone closes it.
   */
  function freezeTransientRoom(room: CollabRoom): void {
    room.persistable = false;
    room.resetFrozen = true;
    if (room.persistTimer) {
      clearTimeout(room.persistTimer);
      room.persistTimer = null;
    }
  }

  /**
   * The proof that a room's lineage ended, read in its own transaction under
   * the page lifecycle lock (#2034): `superseded` when the page exists and its
   * collaborative row is gone or carries another epoch, `page_deleted` when
   * the page row itself is gone. A hard delete cascades the collaborative row,
   * so that row's absence alone cannot tell the two apart. Null when the row
   * still carries `docEpoch`.
   */
  async function proveLineageEnded(room: CollabRoom, docEpoch: string): Promise<LineageEnd | null> {
    const row = await withPageLifecycleRead(
      room.pageId,
      (client) => persist.readCollabLineageRow(client, room.pageId),
    );
    if (row === 'page_absent') return 'page_deleted';
    return row.docEpoch === docEpoch ? null : 'superseded';
  }

  /**
   * Retire a room whose lineage ended (#2034). The caller holds the room's
   * ownership and a check against the row, under the page lifecycle lock,
   * proved `docEpoch` gone or replaced; that transaction has ended.
   *
   * `superseded`: `closeRoomSockets` with `doc_reset` sends the control, closes
   * every socket and releases the admission without a flush (there is nothing
   * left to write into); the editors keep their documents as read-only drafts.
   *
   * `page_deleted`: the page is gone, which is not a document reset. The room
   * gets the committed-delete teardown, the same `closeRoomSockets` call the
   * committed-delete tombstone makes (collab-tombstone.ts), with its release
   * handling, so the sockets hear `4404 committed_delete` whether this proof
   * or that tombstone reaches the room first.
   */
  async function retireRoomOwned(
    room: CollabRoom,
    docEpoch: string | null,
    end: LineageEnd = 'superseded',
  ): Promise<void> {
    // The proof names one heap at one epoch. A room that left the heap or
    // adopted another document meanwhile is not the one it was about.
    if (rooms.get(room.pageId) !== room || room.docEpoch !== docEpoch) {
      room.lineageRetiring = false;
      return;
    }
    if (end === 'page_deleted') {
      logger.info({ pageId: room.pageId, sockets: room.sockets.size }, 'collab.lineage_page_deleted');
      await closeRoomSockets(room, 4404, 'committed_delete');
    } else {
      logger.info({ pageId: room.pageId, sockets: room.sockets.size }, 'collab.lineage_retired');
      await closeRoomSockets(room, 1001, 'doc_reset');
    }
    if (rooms.get(room.pageId) === room) rooms.delete(room.pageId);
  }

  /**
   * Arrange that retirement from a caller that must not wait for room
   * ownership: the room's own persist chain, its inbound queue (a join can
   * hold the ownership while it waits for a dump on that queue) or a frame
   * handler. The returned promise never rejects.
   */
  function scheduleLineageRetirement(
    room: CollabRoom,
    docEpoch: string | null,
    end: LineageEnd = 'superseded',
  ): Promise<void> {
    if (room.lineageRetiring || rooms.get(room.pageId) !== room) return Promise.resolve();
    room.lineageRetiring = true;
    return withRoomOwnership(room.pageId, () => retireRoomOwned(room, docEpoch, end)).catch((error: unknown) => {
      room.lineageRetiring = false;
      logger.warn({ err: error, pageId: room.pageId }, 'collab: lineage retirement failed');
    });
  }

  async function checkRoomLineage(room: CollabRoom): Promise<void> {
    const docEpoch = room.docEpoch;
    if (docEpoch === null || room.lineageRetiring || rooms.get(room.pageId) !== room) return;
    let end: LineageEnd | null;
    try {
      end = await proveLineageEnded(room, docEpoch);
    } catch (error) {
      // An unreadable row proves nothing; the room keeps its state.
      logger.warn({ err: error, pageId: room.pageId }, 'collab: lineage revalidation unavailable');
      return;
    }
    if (end) await scheduleLineageRetirement(room, docEpoch, end);
  }

  /**
   * A retire hint or a peer message of another generation is only a prompt:
   * re-read the row under the page lifecycle lock and retire this room when,
   * and only when, that row is gone or carries another epoch. One read at a
   * time per room, with one follow-up for prompts that arrive meanwhile. The
   * inbound queue starts this and never awaits it.
   */
  function revalidateRoomLineage(room: CollabRoom): Promise<void> {
    const running = lineageChecks.get(room);
    if (running) {
      running.again = true;
      return running.done;
    }
    const check = { again: false, done: Promise.resolve() };
    check.done = (async () => {
      try {
        do {
          check.again = false;
          await checkRoomLineage(room);
        } while (check.again);
      } finally {
        lineageChecks.delete(room);
      }
    })();
    lineageChecks.set(room, check);
    return check.done;
  }

  /**
   * A tagged peer message of another generation than this room's carries no
   * bytes this room may consume and gets none in return. It is never itself
   * the reason for a retirement, only the prompt to check this room's row.
   */
  function promptedByForeignGeneration(room: CollabRoom, message: CollabBusMessage): boolean {
    if (
      typeof message.docEpoch !== 'string'
      || room.docEpoch === null
      || message.docEpoch === room.docEpoch
    ) return false;
    void revalidateRoomLineage(room);
    return true;
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
    if (promptedByForeignGeneration(room, message)) return false;
    const docEpoch = room.docEpoch;
    try {
      const update = fromB64(message.update);
      return await withPageWriteTransaction([room.pageId], async (client) => {
        if (rooms.get(room.pageId) !== room) return false;
        if (room.docEpoch === null) {
          // A provisional room never merges peer bytes into its HTML seed: it
          // adopts the persisted generation into a new document first.
          const persisted = await persist.readPersistedCollabDoc(client, room.pageId);
          if (!persisted || rooms.get(room.pageId) !== room) return false;
          adoptPersistedBytes(room, persisted);
        } else {
          // Two rooms can agree on a superseded epoch; only the row decides.
          await persist.assertCurrentCollabDocEpoch(client, room.pageId, room.docEpoch);
        }
        if (typeof message.docEpoch === 'string' && message.docEpoch !== room.docEpoch) return false;
        if (rooms.get(room.pageId) !== room || room.isFrozen || room.demotionReason !== null) return false;
        Y.applyUpdate(room.doc, update, 'redis');
        forwardUpdate(room, update);
        return true;
      }, { admission: message.admission, ownCollabCommit: 'proceed' });
    } catch (err) {
      if (persist.isCollabLineageChanged(err)) {
        void scheduleLineageRetirement(room, docEpoch);
        return false;
      }
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
        // A request of another generation is answered with nothing. It lets a
        // superseded owner whose retire hint was lost retire here, so the
        // requesting join can converge without it (#2034).
        if (promptedByForeignGeneration(room, message)) return;
        const admission = room.admission;
        if (!admission || message.lifecycleRevision !== room.lifecycleRevision
          || !message.requestedAdmissions.includes(admission.id)) return;
        const docEpoch = room.docEpoch;
        let dump: Uint8Array | null;
        try {
          dump = await withPageWriteTransaction([room.pageId], async (client) => {
            // The merge refuses unless the row still carries this room's
            // epoch, so a dump is only emitted for the current generation.
            await mergePersistedRoom(client, room);
            if (rooms.get(room.pageId) !== room || room.admission?.id !== admission.id) return null;
            return Y.encodeStateAsUpdate(room.doc);
          }, { admission, ownCollabCommit: 'proceed' });
        } catch (error) {
          if (!persist.isCollabLineageChanged(error)) throw error;
          void scheduleLineageRetirement(room, docEpoch);
          return;
        }
        if (!dump || !transportAvailable()) return;
        await publish(room.pageId, {
          origin: podId, kind: 'state_dump', requestId: message.requestId,
          update: b64(dump), lifecycleRevision: room.lifecycleRevision, admission,
          ...epochTag(room),
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
        if (reason === 'doc_reset' && message.hint === true) {
          // Retire hint: an inbound publication ended the lineage in its own
          // transaction. The row is the authority, never this message (#2034).
          void revalidateRoomLineage(room);
          return;
        }
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
          || room.resetFrozen) return;
        if (await validateAndApplyPeerUpdate(room, message)) {
          round.remaining.delete(message.admission.id);
          if (round.remaining.size === 0) round.finish(true);
        }
        return;
      }
      if (message.kind === 'image_markers') {
        const markers = busImageMarkers(message.markers);
        if (!markers || typeof message.lifecycleRevision !== 'string') return;
        await room.initializing;
        try {
          await markRoomImages(room, message.lifecycleRevision, markers, busDocEpoch(message.docEpoch));
        } catch (error) {
          logMarksSkipped('image_markers', error, room.pageId, 'room');
        }
        return;
      }
      if (message.kind === 'task_ids') {
        const markers = busTaskIdMarkers(message.taskIds);
        if (!markers || typeof message.lifecycleRevision !== 'string') return;
        await room.initializing;
        try {
          await markRoomTaskIds(room, message.lifecycleRevision, markers, busDocEpoch(message.docEpoch));
        } catch (error) {
          logMarksSkipped('task_ids', error, room.pageId, 'room');
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
          resumeAfterCommit(room);
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
    // A hard-deleted page leaves this flush no row to write (#1922). Only the
    // release below acts on it, and only after it re-proves the row absent.
    let pageNotFound: PageWriteError | null = null;
    try {
      await persist.flushCollabPersist(room);
    } catch (error) {
      if (persist.isCollabLineageChanged(error)) {
        // The room's row is gone or replaced, so nothing is left to flush
        // into. Retire the room; its editors keep their documents as drafts.
        await retireRoomOwned(room, room.docEpoch);
        return;
      }
      // The page's own pending collaborative Save fences this flush: a wait,
      // not a failure. Keep the admission and retry once it settles (#1763).
      // Every other failure propagates and keeps the admission (runbook).
      if (isCollabCommitPending(error)) {
        deferRelease(room);
        return;
      }
      if (!(error instanceof PageWriteError) || error.reason !== 'page_not_found') throw error;
      pageNotFound = error;
    }
    // Socket demotion/disconnection remains immediate while a flush is in
    // flight; joins and retirement share the ownership queue.
    if (
      [...room.sockets.values()].some((socket) => socket.writable)
      || room.admission?.id !== admission.id
    ) {
      if (pageNotFound) throw pageNotFound;
      return;
    }
    if (pageNotFound) {
      let released: boolean;
      try {
        released = await releasePageRuntimeForDeletedPage(admission);
      } catch (proofError) {
        logger.warn({ err: proofError, pageId: room.pageId }, 'collab: deleted-page release could not prove the page absent');
        throw pageNotFound;
      }
      if (!released) throw pageNotFound;
      logger.info({ pageId: room.pageId }, 'collab.release_deleted_page');
    } else {
      await releasePageRuntime(admission);
    }
    cancelDeferredRelease(room);
    room.admission = null;
    room.persistable = false;
    room.lastWriterUserId = null;
    const held = [...room.heldActiveSuffixes];
    room.heldActiveSuffixes.clear();
    await sremSuffixes(room.pageId, held);
  }

  function cancelDeferredRelease(room: CollabRoom): void {
    clearTimeout(room.deferredRelease ?? undefined);
    room.deferredRelease = null;
    room.deferredReleaseAttempts = 0;
  }

  function deferRelease(room: CollabRoom): void {
    if (room.deferredRelease) return;
    const delayMs = deferredReleaseDelayMs(room.deferredReleaseAttempts);
    room.deferredReleaseAttempts += 1;
    logger.info({ pageId: room.pageId, retryInMs: delayMs }, 'collab.release_deferred');
    room.deferredRelease = setTimeout(() => {
      room.deferredRelease = null;
      void retryDeferredRelease(room);
    }, delayMs);
    if (typeof room.deferredRelease.unref === 'function') room.deferredRelease.unref();
  }

  function retryDeferredRelease(room: CollabRoom): Promise<void> {
    return withRoomOwnership(room.pageId, async () => {
      await releaseAdmissionIfNoWriters(room);
      if (room.deferredRelease) return;
      room.deferredReleaseAttempts = 0;
      if (!room.admission && room.sockets.size === 0) await dropRoomOwned(room.pageId, room);
    }).catch((error: unknown) => {
      // A non-transient failure stops the retries and keeps the admission.
      room.deferredReleaseAttempts = 0;
      logger.warn({ err: error, pageId: room.pageId }, 'collab: deferred release failed; admission retained');
    });
  }

  /**
   * A `pages_version` control follows only a settled commit. Resume what that
   * commit's pending intent deferred now, not at the next backoff tick
   * (#1763): an outstanding last-writer release, which queues behind a retry
   * that is running right now, and, while a writer is connected (again), the
   * persist of the edits typed during the Save. Without a writer the release
   * flushes them.
   */
  function resumeAfterCommit(room: CollabRoom): void {
    if (room.deferredReleaseAttempts > 0) {
      cancelDeferredRelease(room);
      void retryDeferredRelease(room);
    }
    if (
      room.admission
      && isCollabCommitPending(room.persistError)
      && [...room.sockets.values()].some((socket) => socket.writable)
    ) {
      // `enqueuePersist` logs the outcome of this flush.
      void persist.flushCollabPersist(room).catch(() => undefined);
    }
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

  /** `commit_unknown`, once per socket and intent (#2035). */
  function tellCommitUnknown(socket: CollabSocket, intentId: string): void {
    if (socket.commitUnknownIntentId === intentId) return;
    socket.commitUnknownIntentId = intentId;
    sendBin(socket.ws, encodeControlFrame({ type: 'commit_unknown' }));
  }

  /**
   * Take write authority from one socket because the page's own collaborative
   * commit is unknown (#2035). Synchronous, so a caller can demote under the
   * page lifecycle lock. Per-socket accounting is that of a permission
   * demotion. `permission_loss` follows `commit_unknown` for a client that
   * predates the new control: it keeps its document as a read-only draft and
   * does not reconnect. The room admission, `persistable`, the `room` suffix
   * and a deferred release are left alone: the socket's close runs the
   * existing release path, which waits for the intent to settle.
   */
  function demoteForUnknownCommit(room: CollabRoom, socket: CollabSocket, intentId: string): void {
    socket.writable = false;
    socket.commitUnknownGated = true;
    room.heldActiveSuffixes.delete(socket.id);
    void sremSuffixes(room.pageId, [socket.id]);
    tellCommitUnknown(socket, intentId);
    sendBin(socket.ws, encodeControlFrame({ type: 'permission_loss', reason: 'edit_permission_revoked' }));
    try { socket.ws.close(1001, 'commit_unknown'); } catch { /* already closing */ }
    logger.info(
      { pageId: room.pageId, userId: socket.userId, connId: socket.id, intentId },
      'collab.commit_unknown_demoted',
    );
  }

  /**
   * A cue is only a prompt (#2035). One read of the durable state under the
   * page lifecycle lock decides: while `intentId` is still the page's pending
   * commit (already `unknown`, or `in_flight`, for which the owner's cue is
   * the evidence), the room latches it and every socket that is writable at
   * that instant is demoted, inside that transaction and without an await.
   * Settlement and a join's final step take the same lock, so a delayed or
   * repeated cue for a settled intent does nothing and can never reach a
   * socket that became writable afterwards. Read-only sockets are told and
   * stay connected. Never awaited by the room's inbound queue.
   */
  async function handleCommitUnknownCue(room: CollabRoom, intentId: string): Promise<void> {
    try {
      await withPageLifecycleRead(room.pageId, async (client) => {
        const durable = await readCollabCommitState(client, room.pageId);
        if (durable.state === 'none' || durable.intentId !== intentId) return;
        if (rooms.get(room.pageId) !== room) return;
        room.unknownCommitIntentId = intentId;
        for (const socket of [...room.sockets.values()]) {
          if (socket.writable) demoteForUnknownCommit(room, socket, intentId);
          else tellCommitUnknown(socket, intentId);
        }
      });
    } catch (error) {
      // Nothing was decided. The frame and join fences do not depend on the cue.
      logger.warn({ err: error, pageId: room.pageId, intentId }, 'collab: unknown-commit cue could not be checked');
    }
  }

  function announceCommitUnknown(pageId: number, intentId: string): void {
    const room = rooms.get(pageId);
    if (room) void handleCommitUnknownCue(room, intentId);
    // Bounded and cancellable: a cue that could not be written before its
    // deadline is dropped, not left queued for a later reconnect. The owner
    // repeats it on every marker retry.
    const cue: CollabBusMessage = { origin: podId, kind: 'commit_unknown', intentId };
    void withRedisCommandDeadline(
      main,
      collabCommitDeadlineMs(),
      (client) => client.publish(docChannel(pageId), JSON.stringify(cue)),
    ).catch((err: unknown) => {
      logger.warn({ err, pageId, intentId }, 'collab.commit_unknown_cue_unpublished');
    });
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
        ...epochTag(room),
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

  /**
   * HTML-only readers have provisional Yjs identities, never a writable seed.
   * `docEpoch` is the epoch of the row `canonical` was read from or seeded as.
   */
  function adoptPersistedDocument(room: CollabRoom, canonical: Y.Doc, docEpoch: string): void {
    if (room.docEpoch !== null) {
      // A peer may have adopted the same canonical seed while initialization
      // awaited its SQL commit. Merge that seed without losing newer updates,
      // but only within one lineage: another epoch is another document.
      if (room.docEpoch !== docEpoch) throw persist.collabLineageChanged();
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
    room.docEpoch = docEpoch;
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
      deferredRelease: null,
      deferredReleaseAttempts: 0,
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
      docEpoch: null,
      lineageRetiring: false,
      resetFrozen: false,
      unknownCommitIntentId: null,
      onLineageChanged: (docEpoch) => { void scheduleLineageRetirement(room, docEpoch); },
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
      room.docEpoch = loaded.docEpoch;

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
    expectedLifecycleRevision: string | undefined,
    declaration: CollabDocEpochDeclaration,
  ): Promise<boolean> {
    if (room.admission) {
      const admission = room.admission;
      // An unreadable admission is not an absent one. Keep ownership and
      // surface the failure rather than leaking this token behind a new one.
      // The same transaction reads the state of the page's own commit; an
      // unknown one is acted on only after the lifecycle and epoch outcomes,
      // which come first in the join outcome precedence (#2035).
      let unknownCommit: unknown = null;
      try {
        await withCollabCommitKnown(room.pageId, room, (assertCommitKnown) =>
          withPageWriteTransaction([room.pageId], assertCommitKnown, {
            admission,
            ownCollabCommit: 'proceed',
          }), commitLatches);
      } catch (error) {
        if (!isCollabCommitUnknown(error)) throw error;
        unknownCommit = error;
      }
      if (
        expectedLifecycleRevision !== undefined
        && admission.lifecycleRevision !== expectedLifecycleRevision
      ) return false;
      // The room already owns an admission, so only its own generation may
      // join it. A declaration is not evidence against the room; its row is.
      if (!declarationAdmits(declaration, room.docEpoch)) {
        void revalidateRoomLineage(room);
        throw new JoinLineageRefusal('refuse_socket');
      }
      if (unknownCommit) throw unknownCommit;
      return true;
    }
    const initializing = (async () => {
      let acquired: PageRuntimeAdmission | null = null;
      try {
        // The epoch decision, then the state of the page's own commit (#2035):
        // both under the lifecycle lock of the admission transaction, so a
        // join cannot acquire an admission after the unknown-outcome marker.
        acquired = await withCollabCommitKnown(room.pageId, room, (assertCommitKnown) =>
          admitPageRuntime(room.pageId, userId, 'collab_room', undefined, {
            precondition: async (client) => {
              if (await assertJoinLineage(client, room, expectedLifecycleRevision, declaration)) {
                await assertCommitKnown(client);
              }
            },
          }), commitLatches);
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
            if (loaded === 'missing' || loaded.docEpoch === null) {
              throw new PageWriteError(409, 'collab_state_unavailable', 'The collaborative page is no longer available');
            }
            adoptPersistedDocument(room, canonical, loaded.docEpoch);
            room.pagesVersion = loaded.pagesVersion;
          } catch (error) {
            canonical.destroy();
            throw error;
          }
        }
        // The precondition compared the declaration with the row inside the
        // admission transaction. A provisional room loads, seeds or adopts its
        // document in a later transaction, and the row can be deleted or
        // reseeded in between: the declaration must name the document this
        // room ended up with. The catch below releases the admission.
        if (!declarationAdmits(declaration, room.docEpoch)) {
          throw new JoinLineageRefusal('refuse_socket');
        }
        room.admission = acquired;
        room.lifecycleRevision = acquired.lifecycleRevision;
        room.isFrozen = false;
        room.baselineId = null;
        room.demotionReason = null;
        room.persistable = !room.resetFrozen;
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
  ): Promise<CollabCommitSnapshot> {
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
      const snapshot = await withFreshRoomState(room, admission, () => {
        // The merge just before this proved the row carries the room's epoch.
        const docEpoch = room.docEpoch;
        if (docEpoch === null) throw unavailableSnapshot();
        return {
          html: yDocToHtml(room.doc),
          documentState: Y.snapshot(room.doc),
          taskItems: collabTaskItems(room.doc),
          taskIdsCarried: collabCarriesTaskIds(room.doc),
          docEpoch,
        };
      });
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
      // A snapshot merge found this room's row gone or replaced: retire it.
      if (persist.isCollabLineageChanged(error)) await retireRoomOwned(room, room.docEpoch);
      throw error;
    } finally {
      if (room.sockets.size === 0 && !room.admission) {
        await dropRoomOwned(pageId, room).catch((error) => {
          logger.warn({ err: error, pageId }, 'collab: transient snapshot room cleanup deferred');
        });
      }
    }
  }

  /**
   * Mark uploaded images in place in a room this pod owns at the commit's
   * lifecycle revision, fenced like a client frame (handleInboundFrame).
   * `doc.on('update')` persists the transaction, publishes it once as an
   * incremental `sync` and sends it to every socket (#1764). False when this
   * pod owns no such room.
   */
  async function markRoomImages(
    room: CollabRoom,
    lifecycleRevision: string,
    markers: readonly AttachmentImageMarker[],
    docEpoch: string | undefined,
  ): Promise<boolean> {
    return markRoomDoc(room, lifecycleRevision, docEpoch, (doc) => {
      markAttachmentImages(doc, markers, COLLAB_IMAGE_MARKER_ORIGIN);
    });
  }

  /** The task ids a settled commit wrote, in place in a room this pod owns (#1751); as markRoomImages. */
  async function markRoomTaskIds(
    room: CollabRoom,
    lifecycleRevision: string,
    markers: readonly TaskIdMarker[],
    docEpoch: string | undefined,
  ): Promise<boolean> {
    return markRoomDoc(room, lifecycleRevision, docEpoch, (doc) => {
      markTaskIds(doc, markers, COLLAB_TASK_ID_ORIGIN);
    });
  }

  /**
   * Apply `mark` to an owned room's document under its admission; false when
   * this pod owns no such room. `docEpoch` is the lineage of the Save's
   * snapshot: a room of another lineage is not marked (#2034). A pod older
   * than that change sends none, and its marks are applied as before.
   */
  async function markRoomDoc(
    room: CollabRoom,
    lifecycleRevision: string,
    docEpoch: string | undefined,
    mark: (doc: Y.Doc) => void,
  ): Promise<boolean> {
    const admission = room.admission;
    // A room without a writable admission (read-only viewers) is not an owner:
    // it never persists, and it gets the marks with an owner's `sync` or the
    // next time it merges the persisted document.
    if (!admission || rooms.get(room.pageId) !== room || room.lifecycleRevision !== lifecycleRevision) {
      return false;
    }
    const roomEpoch = room.docEpoch;
    if (docEpoch !== undefined && docEpoch !== roomEpoch) return false;
    let owned = false;
    try {
      await withPageWriteTransaction([room.pageId], async (client) => {
        await persist.assertCurrentCollabDocEpoch(client, room.pageId, roomEpoch);
        // A disconnect, demotion or retirement can win the lifecycle lock first.
        // Like a client frame, this in-memory step writes no protected row, so the
        // page's own pending collaborative Save does not fence it (#1763).
        if (rooms.get(room.pageId) !== room || room.admission?.id !== admission.id) return;
        owned = true;
        mark(room.doc);
      }, { admission, ownCollabCommit: 'proceed' });
    } catch (error) {
      if (persist.isCollabLineageChanged(error)) void scheduleLineageRetirement(room, roomEpoch);
      throw error;
    }
    return owned;
  }

  /**
   * After a settled Confluence commit, mark the images it uploaded (#1764): in
   * place in the room this pod owns, else by asking the owning pods over
   * Redis; then in the persisted document every later room starts from. Best
   * effort: the Save has already succeeded, so a refusal is only logged and
   * costs one more upload on the next Save.
   */
  async function markUploadedImages(
    pageId: number,
    admission: PageRuntimeAdmission,
    markers: readonly AttachmentImageMarker[],
    docEpoch: string,
  ): Promise<void> {
    if (markers.length === 0) return;
    let inRoom = false;
    try {
      const room = rooms.get(pageId);
      inRoom = room ? await markRoomImages(room, admission.lifecycleRevision, markers, docEpoch) : false;
      // An owning pod applies the same transaction; its fan-out reaches every other pod.
      if (!inRoom) {
        await publish(pageId, {
          origin: podId,
          kind: 'image_markers',
          lifecycleRevision: admission.lifecycleRevision,
          markers: [...markers],
          docEpoch,
        });
      }
    } catch (error) {
      logMarksSkipped('image_markers', error, pageId, 'room');
    }
    try {
      const persisted = await persist.markPersistedAttachmentImages(pageId, admission, markers, docEpoch);
      logger.info({ pageId, images: markers.length, inRoom, persisted }, 'collab.image_markers');
    } catch (error) {
      logMarksSkipped('image_markers', error, pageId, 'persisted');
    }
  }

  /**
   * After a settled Confluence commit, store the task ids it wrote (#1751), as
   * markUploadedImages stores image markers: in place in the room this pod
   * owns, else by asking the owning pods over Redis; then in the persisted
   * document. The same transaction records that the room's tasks carry ids;
   * with no markers it records only that. Best effort: a task the marks miss
   * takes its id back from the stored storage on the next Save while its text
   * is unchanged.
   */
  async function markWrittenTaskIds(
    pageId: number,
    admission: PageRuntimeAdmission,
    markers: readonly TaskIdMarker[],
    docEpoch: string,
  ): Promise<void> {
    let inRoom = false;
    try {
      const room = rooms.get(pageId);
      inRoom = room ? await markRoomTaskIds(room, admission.lifecycleRevision, markers, docEpoch) : false;
      if (!inRoom) {
        await publish(pageId, {
          origin: podId,
          kind: 'task_ids',
          lifecycleRevision: admission.lifecycleRevision,
          taskIds: [...markers],
          docEpoch,
        });
      }
    } catch (error) {
      logMarksSkipped('task_ids', error, pageId, 'room');
    }
    try {
      const persisted = await persist.markPersistedTaskIds(pageId, admission, markers, docEpoch);
      logger.info({ pageId, tasks: markers.length, inRoom, persisted }, 'collab.task_ids');
    } catch (error) {
      logMarksSkipped('task_ids', error, pageId, 'persisted');
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
    // A retirement is queued: every socket of this room is about to get `doc_reset`.
    if (room.lineageRetiring) return 'dropped';
    void refreshActiveTtl(pageId);
    const header = parseSyncSubtype(buf);
    if (!header) return 'dropped';

    const syncMutation = header.messageType === MESSAGE_SYNC
      && (header.syncSubtype === SYNC_STEP2 || header.syncSubtype === SYNC_UPDATE);
    const allowedReadonly = header.messageType === MESSAGE_AWARENESS
      || header.messageType === MESSAGE_QUERY_AWARENESS
      || (header.messageType === MESSAGE_SYNC && header.syncSubtype === SYNC_STEP1);
    // A socket that holds no write authority only because the page's own
    // collaborative commit is unknown is not violating a read-only role: its
    // late frames are dropped without counting toward the drop limit (#2035).
    if (socket.commitUnknownGated && !socket.writable && !allowedReadonly) return 'dropped';
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
          const docEpoch = room.docEpoch;
          try {
            let applied = false;
            // The page's own pending collaborative Save does not fence an
            // in-memory apply: it publishes the snapshot it captured before
            // reserving, and this room's persist waits for it (#1763). That
            // holds for a Save in flight only: once its outcome is unknown,
            // nothing more is applied (#2035). A foreign pending write, a
            // stale lifecycle or admission, a fenced runtime or an unreadable
            // fence still closes below.
            await withCollabCommitKnown(pageId, room, (assertCommitKnown) =>
              withPageWriteTransaction([pageId], async (client) => {
                // The frame is applied on behalf of the current generation only:
                // the row must still carry this room's epoch (#2034).
                await persist.assertCurrentCollabDocEpoch(client, pageId, docEpoch);
                await assertCommitKnown(client);
                // Disconnect/demotion can win while this frame waits for the
                // lifecycle lock. It must not write behind their final flush.
                if (rooms.get(pageId) !== room || room.sockets.get(connId) !== socket
                  || !socket.writable || room.admission?.id !== admission.id) return;
                apply();
                applied = true;
              }, { admission, ownCollabCommit: 'proceed' }), commitLatches);
            if (!applied) return 'dropped';
          } catch (err) {
            if (persist.isCollabLineageChanged(err)) {
              // Nothing was applied. The retirement resets every socket of the
              // room, this one included; it is not awaited by the frame chain.
              logger.info({ pageId, connId }, 'collab.packet_lineage_changed');
              void scheduleLineageRetirement(room, docEpoch);
              return 'dropped';
            }
            if (isCollabCommitUnknown(err)) {
              // Nothing was applied, and the fenced transaction has ended.
              logger.info({ pageId, connId, intentId: err.intentId }, 'collab.packet_commit_unknown');
              if (room.sockets.get(connId) === socket && socket.writable) {
                demoteForUnknownCommit(room, socket, err.intentId);
              }
              // The room's other writers are demoted under the lifecycle lock,
              // exactly as a cue would; this handler does not wait for it.
              void handleCommitUnknownCue(room, err.intentId);
              return 'dropped';
            }
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

  /**
   * Step 3 of the join outcome precedence (#2034), before the admission: this
   * heap and the declaration against the row. The unlocked read only finds a
   * heap that may be stale; the proof is the read under the page lifecycle
   * lock, which also tells a deleted page from a replaced document. A stale
   * heap is decided first: it is retired and the join restarts against a
   * fresh room, which then answers the declaration.
   */
  async function decideJoinLineage(
    room: CollabRoom,
    declaration: CollabDocEpochDeclaration,
  ): Promise<'proceed' | 'refuse' | LineageEnd> {
    // Malformed is a mismatch, never absent, and needs no read.
    if (declaration.kind === 'malformed') return 'refuse';
    let rowEpoch = await persist.readCollabDocEpoch(room.pageId);
    if (room.docEpoch !== null && room.docEpoch !== rowEpoch) {
      const end = await proveLineageEnded(room, room.docEpoch);
      if (end) return end;
      rowEpoch = room.docEpoch;
    }
    return declarationAdmits(declaration, rowEpoch) ? 'proceed' : 'refuse';
  }

  /**
   * Refuse this join only: the socket is told its document changed and is
   * never attached. The room's other sockets and a running grace timer are
   * left alone; a room this join found or created empty, without an admission
   * and without that timer, is evicted now.
   */
  async function refuseJoinForLineage(room: CollabRoom, socket: CollabSocketJoin): Promise<CollabSocket> {
    if (rooms.get(room.pageId) === room && room.sockets.size === 0 && !room.admission && !room.emptyGrace) {
      await dropRoomOwned(room.pageId, room);
    }
    sendBin(socket.ws, encodeControlFrame({ type: 'doc_reset' }));
    try { socket.ws.close(1001, 'doc_reset'); } catch { /* already closing */ }
    logger.info({ pageId: room.pageId, userId: socket.userId, connId: socket.id }, 'collab.join_doc_reset');
    return {
      id: socket.id,
      ws: socket.ws,
      userId: socket.userId,
      writable: false,
      readonlyDrops: 0,
      awarenessClientIds: new Set(),
      lineageVerified: false,
      joinRefused: 'doc_reset',
      ...(socket.identity ? { identity: socket.identity } : {}),
    };
  }

  /** What a lineage failure during a join means for that join; null when `error` is not one it settles. */
  async function joinLineageOutcome(
    room: CollabRoom,
    socket: CollabSocketJoin,
    declaration: CollabDocEpochDeclaration,
    error: unknown,
  ): Promise<CollabSocket | 'restart' | null> {
    if (error instanceof JoinLineageRefusal) {
      if (error.outcome === 'refuse_socket') return refuseJoinForLineage(room, socket);
      await retireRoomOwned(room, room.docEpoch);
      return 'restart';
    }
    if (!persist.isCollabLineageChanged(error)) return null;
    // A seed, adoption or merge under the lifecycle lock found this room's row
    // gone or replaced. A join that named an epoch is answered `doc_reset`; one
    // that named none (undeclared, or an empty document) fails and its client
    // reconnects into a fresh room.
    await retireRoomOwned(room, room.docEpoch);
    return declaration.kind === 'declared' ? refuseJoinForLineage(room, socket) : null;
  }

  async function attachSocket(pageId: number, socket: CollabSocketJoin): Promise<CollabSocket> {
    for (let restarted = false; ; restarted = true) {
      const attached = await attachSocketOnce(pageId, socket);
      if (attached !== 'restart') return attached;
      // A stale heap was retired. The join restarts against a fresh room once;
      // a second stale heap in a row fails this join closed.
      if (restarted) throw persist.collabLineageChanged();
    }
  }

  async function attachSocketOnce(pageId: number, socket: CollabSocketJoin): Promise<CollabSocket | 'restart'> {
    let room = await getOrCreateRoom(pageId);
    if (room.lineageRetiring) {
      // A proven retirement is queued behind this join; finish it first.
      await retireRoomOwned(room, room.docEpoch);
      room = await getOrCreateRoom(pageId);
    }
    const expectedLifecycleRevision = socket.expectedLifecycleRevision;
    const declaration: CollabDocEpochDeclaration = socket.expectedDocEpoch ?? { kind: 'absent' };
    // Bind every join to authoritative PostgreSQL lifecycle state. A client
    // revision is never evidence that an in-memory room is stale (otherwise a
    // forged future revision could demote active editors).
    await applyAuthoritativeLifecycle(room);
    if (rooms.get(pageId) !== room) room = await getOrCreateRoom(pageId);
    if (room.demotionReason && room.sockets.size === 0) {
      await dropRoomOwned(pageId, room);
      room = await getOrCreateRoom(pageId);
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
    let writable = false;
    // Step 4 of the join outcome precedence (#2035): the page's own
    // collaborative commit is unknown, so this join, writable otherwise, is
    // attached read-only and told `commit_unknown`.
    let unknownCommitIntentId: string | null = null;
    // Only a join that would be writable gets an epoch decision (#2034) and
    // an unknown-commit decision; a join that stays read-only for permission
    // or lifecycle keeps its outcome.
    if (socket.writable && refusalReason === undefined && room.demotionReason === null) {
      // A frozen page is never writable: it keeps the outcome the refused
      // admission below gives it. Should the page have thawed since this room
      // read it, the admission precondition decides the declaration.
      const decision = room.isFrozen ? 'proceed' : await decideJoinLineage(room, declaration);
      if (decision === 'refuse') return refuseJoinForLineage(room, socket);
      if (decision !== 'proceed') {
        // A stale heap. For a deleted page the restart finds no page to load,
        // and the join fails as any join to a missing page does.
        await retireRoomOwned(room, room.docEpoch, decision);
        return 'restart';
      }
      try {
        writable = await ensureWritableAdmission(
          room,
          socket.userId,
          expectedLifecycleRevision ?? undefined,
          declaration,
        );
      } catch (error) {
        if (!isCollabCommitUnknown(error)) {
          const outcome = await joinLineageOutcome(room, socket, declaration, error);
          if (outcome) return outcome;
          throw error;
        }
        // No admission was acquired for this join.
        unknownCommitIntentId = error.intentId;
      }
      if (writable && room.admission) {
        try {
          await withFreshRoomState(room, room.admission, () => undefined);
        } catch (error) {
          const outcome = await joinLineageOutcome(room, socket, declaration, error);
          if (outcome) return outcome;
          await releaseAdmissionIfNoWriters(room).catch((cleanupError) => {
            logger.warn({ err: cleanupError, pageId }, 'collab: failed join retained its admission');
          });
          throw error;
        }
      }
    }
    if (!socket.writable || unknownCommitIntentId !== null) {
      try {
        await refreshReaderRoom(room);
      } catch (error) {
        if (persist.isCollabLineageChanged(error)) {
          // This heap holds a document whose row is gone or replaced.
          await retireRoomOwned(room, room.docEpoch);
          return 'restart';
        }
        // A gated join is attached to be told `commit_unknown`; a room state
        // that could not be refreshed does not turn that into a failed join.
        if (unknownCommitIntentId === null) throw error;
        logger.info({ err: error, pageId }, 'collab: gated join attached without a fresh room state');
      }
    }
    if (
      socket.writable
      && !writable
      && unknownCommitIntentId === null
      && refusalReason === undefined
      && !room.isFrozen
      && expectedLifecycleRevision !== undefined
    ) {
      refusalReason = 'lifecycle_revision_stale';
    }
    // Registered without write authority; only the final step grants it.
    const full: CollabSocket = {
      id: socket.id,
      ws: socket.ws,
      userId: socket.userId,
      writable: false,
      readonlyDrops: 0,
      awarenessClientIds: new Set(),
      lineageVerified: false,
      ...(socket.identity ? { identity: socket.identity } : {}),
      ...(refusalReason ? { writableRefusalReason: refusalReason } : {}),
    };
    if (full.ws.readyState !== 1) {
      await releaseAdmissionIfNoWriters(room);
      return full;
    }
    // Only a socket that is attached cancels the room's eviction; a refused
    // join leaves a running grace timer alone.
    if (room.emptyGrace) {
      clearTimeout(room.emptyGrace);
      room.emptyGrace = null;
    }
    room.sockets.set(full.id, full);
    if (writable) {
      await saddActive(pageId, full.id);
      room.heldActiveSuffixes.add(full.id);
    }
    // A close may have arrived during Redis bookkeeping.
    if (rooms.get(pageId) !== room || room.sockets.get(full.id) !== full || full.ws.readyState !== 1) {
      await unregisterJoin(room, full);
      await releaseAdmissionIfNoWriters(room);
      return full;
    }
    sendAwarenessSnapshot(room, full.ws);
    // Before the lifecycle and admission controls: the client pins this epoch
    // at its first sync. A provisional room has no persisted document to name.
    if (room.docEpoch !== null) {
      sendBin(full.ws, encodeControlFrame({ type: 'doc_epoch', epoch: room.docEpoch }));
    }
    sendBin(full.ws, encodeControlFrame(lifecycleControl(room)));
    if (writable) {
      let granted = false;
      try {
        granted = await grantWriteAuthority(room, full, declaration);
      } catch (error) {
        if (!isCollabCommitUnknown(error)) {
          // The fence refused: the socket is closed and cleaned up.
          await unregisterJoin(room, full);
          if (error instanceof JoinLineageRefusal) {
            // The room is current; only this join's declaration is not. An
            // admission it acquired goes before the join is answered.
            await releaseAdmissionIfNoWriters(room).catch((cleanupError) => {
              logger.warn({ err: cleanupError, pageId }, 'collab: refused join retained its admission');
            });
          }
          const outcome = await joinLineageOutcome(room, socket, declaration, error);
          if (outcome) return outcome;
          try { full.ws.close(1001, 'collab_validation_unavailable'); } catch { /* already closing */ }
          await releaseAdmissionIfNoWriters(room).catch((cleanupError) => {
            logger.warn({ err: cleanupError, pageId }, 'collab: failed join retained its admission');
          });
          throw error;
        }
        // The marker committed, or a latch arrived, after this join's admission.
        unknownCommitIntentId = error.intentId;
      }
      if (!granted && unknownCommitIntentId === null) {
        // The socket left during the join.
        await unregisterJoin(room, full);
        await releaseAdmissionIfNoWriters(room);
        return full;
      }
    }
    if (unknownCommitIntentId !== null) {
      // `permission_loss` follows for a client that predates `commit_unknown`:
      // it keeps its document as a read-only draft and does not reconnect.
      full.commitUnknownGated = true;
      tellCommitUnknown(full, unknownCommitIntentId);
      sendBin(full.ws, encodeControlFrame({ type: 'permission_loss', reason: 'edit_permission_revoked' }));
      if (writable) {
        // Gated at the final step. This socket never wrote: its active member
        // goes, and an admission without writers takes the existing release
        // path, which waits for the intent to settle.
        if (room.heldActiveSuffixes.delete(full.id)) await sremSuffixes(pageId, [full.id]);
        await releaseAdmissionIfNoWriters(room).catch((cleanupError) => {
          logger.warn({ err: cleanupError, pageId }, 'collab: gated join retained its admission');
        });
      }
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
    logger.info({
      pageId,
      userId: full.userId,
      writable: full.writable,
      lineageVerified: full.lineageVerified,
      commitUnknown: unknownCommitIntentId !== null,
      connId: full.id,
    }, 'collab.join');
    return full;
  }

  /** Undo a join's registration and its `collab:active` member. The caller settles the room's admission. */
  async function unregisterJoin(room: CollabRoom, socket: CollabSocket): Promise<void> {
    socket.writable = false;
    socket.lineageVerified = false;
    if (room.sockets.get(socket.id) === socket) room.sockets.delete(socket.id);
    if (room.heldActiveSuffixes.delete(socket.id)) await sremSuffixes(room.pageId, [socket.id]);
  }

  /**
   * The final step of a writable join (#2034, #2035), after every awaited
   * preparation and with the socket registered without write authority. One
   * admission-fenced transaction re-asserts that the room's document is the
   * current generation and that the page's own collaborative commit is not
   * unknown and then, still inside it and without awaiting anything else,
   * makes the final checks, marks the socket writable, decides whether it is
   * lineage-verified and writes
   * `writable_admission`. The unknown-outcome marker, every settlement and
   * every invalidation, seed and reset take the same lifecycle lock: either
   * the marker commits first and this join sees it, or the socket is a
   * registered writer before the marker commits and the cue or its next frame
   * demotes it. The positive cue is never written outside this fence.
   *
   * False when the socket left during the join; throws when the fence refuses.
   */
  async function grantWriteAuthority(
    room: CollabRoom,
    socket: CollabSocket,
    declaration: CollabDocEpochDeclaration,
  ): Promise<boolean> {
    const admission = room.admission;
    if (!admission) throw unavailableSnapshot();
    return withCollabCommitKnown(room.pageId, room, (assertCommitKnown) =>
      withPageWriteTransaction([room.pageId], async (client) => {
        await persist.assertCurrentCollabDocEpoch(client, room.pageId, room.docEpoch);
        // The room's document is the current generation. A declared epoch
        // must name exactly that document: a declared join that no longer
        // matches the epoch this room ended up with is refused with
        // `doc_reset`, never admitted unverified. An `empty` declaration
        // names no epoch, so it has nothing to compare; the assertion above
        // and the commit-state check below apply to it as to every join.
        // Step 3 of the precedence, before step 4.
        if (!declarationAdmits(declaration, room.docEpoch)) throw new JoinLineageRefusal('refuse_socket');
        await assertCommitKnown(client);
        if (room.sockets.get(socket.id) !== socket || socket.ws.readyState !== 1) return false;
        if (
          rooms.get(room.pageId) !== room
          || room.admission?.id !== admission.id
          || room.isFrozen
          || room.demotionReason !== null
          || !transportAvailable()
        ) throw unavailableSnapshot();
        socket.writable = true;
        // The only place a socket becomes lineage-verified: writable, in a
        // room that holds its persisted document, declared as that document's
        // epoch or as no document at all (#2034).
        socket.lineageVerified = declarationVerifies(declaration, room.docEpoch);
        sendBin(socket.ws, encodeControlFrame({
          type: 'writable_admission',
          lifecycleRevision: room.lifecycleRevision,
        }));
        return true;
      }, { admission, ownCollabCommit: 'proceed' }), commitLatches);
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
        // A flush that waits for the page's own pending Save keeps the
        // admission without throwing; the heap is going away all the same.
        if (room.admission) {
          logger.warn({ err: room.persistError, pageId: room.pageId }, 'collab: room close retained durable admission');
        }
      }
    } catch (err) {
      // The heap is going away regardless (shutdown, tombstone, or reset).
      // Retain an uncertain durable admission so another writer remains
      // fenced, but do not let one failed flush strand other rooms, timers, or
      // the Redis subscription during teardown.
      logger.warn({ err, pageId: room.pageId }, 'collab: room close retained durable admission');
    }
    cancelDeferredRelease(room);
    await sremSuffixes(room.pageId, room.heldActiveSuffixes);
    room.heldActiveSuffixes.clear();
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
    cancelDeferredRelease(room);
    await sremSuffixes(pageId, room.heldActiveSuffixes);
    room.doc.destroy();
  }

  function dropRoom(pageId: number, room = rooms.get(pageId)): Promise<void> {
    return withRoomOwnership(pageId, () => dropRoomOwned(pageId, room));
  }

  function broadcastControl(pageId: number, control: CollabControl): void {
    const room = rooms.get(pageId);
    if (room) {
      sendControl(room, control);
      if (control.type === 'pages_version') {
        room.pagesVersion = control.version;
        resumeAfterCommit(room);
      }
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

  async function hintDocRetired(pageId: number): Promise<void> {
    // No `collab:active` cleanup here: each room that retires removes its own
    // members, and a room of a newer generation keeps its liveness.
    await publish(pageId, { origin: podId, kind: 'tombstone', code: 1001, reason: 'doc_reset', hint: true });
    const room = rooms.get(pageId);
    if (room) await revalidateRoomLineage(room);
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
      if (candidate.kind === 'commit_unknown') {
        // Outside the room's inbound queue: the cue must not wait behind a
        // peer message that is itself waiting for the page lifecycle lock.
        if (candidate.origin !== podId && typeof candidate.intentId === 'string') {
          void handleCommitUnknownCue(room, candidate.intentId);
        }
        return;
      }
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
      try {
        await refreshReaderRoom(room);
        return room;
      } catch (error) {
        if (!persist.isCollabLineageChanged(error)) throw error;
        // This heap holds a document whose row is gone or replaced.
        await retireRoomOwned(room, room.docEpoch);
        const fresh = await getOrCreateRoom(pageId);
        await refreshReaderRoom(fresh);
        return fresh;
      }
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
    announceCommitUnknown,
    markUploadedImages,
    markWrittenTaskIds,
    prepareCommitSnapshot: (pageId, userId, revision) =>
      withRoomOwnership(pageId, () => prepareCommitSnapshot(pageId, userId, revision)),
    handleLifecycleEvent: (event) =>
      withRoomOwnership(event.pageId, () => handleLifecycleEvent(event)),
    refreshLifecycleRooms,
    dropRoom,
    hintDocRetired,
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

/**
 * After an inbound publication committed, having deleted the page's
 * collaborative row in its own transaction: prompt every room of the page to
 * check its row (#2034). Best effort. A lost hint only delays a superseded
 * room's retirement to its next boundary, where the missing row fences it.
 */
export async function hintCollabDocRetired(pageId: number): Promise<void> {
  try {
    await defaultRuntime?.hintDocRetired(pageId);
  } catch (err) {
    logger.warn({ err, pageId }, 'collab: retire hint failed');
  }
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
