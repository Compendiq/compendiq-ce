import { useCallback, useEffect, useRef, useState } from 'react';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import { Awareness } from 'y-protocols/awareness';
import {
  COLLAB_UPGRADE_WINDOW_SEC,
  COLLAB_WS_PROTOCOL,
  CollabCommitUnknownControlSchema,
  CollabDocEpochControlSchema,
  CollabRefusalReasonSchema,
  CollabWritableAdmissionControlSchema,
  PageLifecycleEventSchema,
  type CollabRefusalReason,
} from '@compendiq/contracts';
import { refreshAccessTokenOnce, RefreshUnavailableError } from '../../shared/lib/api';
import { useAuthStore } from '../../stores/auth-store';
import { caretColorForUserId } from '../../shared/lib/collab-colors';
import type { CollabAwarenessUser } from './merge-presence';

const MESSAGE_CONTROL = 4;
// Retry-safe busy refresh failures rejoin with backoff, as in use-presence.
const REJOIN_BACKOFF_START_MS = 1_000;
const REJOIN_BACKOFF_CAP_MS = 30_000;
const MESSAGE_SYNC = 0;
// A Rejoin that has not proven the server holds the draft within this long
// ends unsuccessfully (#2036, D-2036).
export const REJOIN_COVERAGE_TIMEOUT_MS = 10_000;
// An answer that did not cover the draft is asked for again after this long.
const REJOIN_REPROBE_MS = 1_000;
// A state vector that names no client: the server answers with its whole state.
const EMPTY_STATE_VECTOR = (() => {
  const empty = new Y.Doc();
  const vector = Y.encodeStateVector(empty);
  empty.destroy();
  return vector;
})();

export type CollabJoinError =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'flag_off'
  | 'join_interrupted';
export type CollabReadOnlyReason =
  | 'frozen'
  | 'lifecycle_changed'
  | 'permission_loss'
  | 'document_changed'
  | 'unauthorized'
  | 'not_found'
  | 'flag_off'
  | 'rate_limited'
  | 'readonly'
  | 'commit_unknown';
/** The manual rejoin of a draft after a post-sync `rate_limited` (#2036). */
export type CollabRejoinAttempt = 'idle' | 'attempting' | 'unconfirmed';

export interface UseCollabProviderResult {
  ydoc: Y.Doc | null;
  provider: WebsocketProvider | null;
  synced: boolean;
  awarenessUsers: CollabAwarenessUser[];
  error: CollabJoinError | null;
  /** Before the first sync only: an attempt closed transiently and y-websocket is reconnecting. */
  reconnecting: boolean;
  /**
   * `retry()` would start now: an interrupted join, or `rate_limited` once the
   * upgrade window passed; after the first sync, a Rejoin of a pinned document
   * once that window passed or after an attempt the server did not confirm.
   */
  canRetry: boolean;
  /**
   * Rejoins after a retryable refusal before the first sync. After it, starts
   * the Rejoin attempt (#2036) when `canRetry`; a no-op otherwise.
   */
  retry: () => void;
  connected: boolean;
  writable: boolean;
  readOnlyReason: CollabReadOnlyReason | null;
  /**
   * The document has a pinned epoch (#2034): its first sync came with the
   * server's `doc_epoch` control, and every later join declares that epoch.
   * False for a document that synced from a server or a room that named none.
   */
  docEpochPinned: boolean;
  /**
   * Post-sync `rate_limited` of a document with a pinned epoch (#2036, A4): the
   * Rejoin control is offered, available when `canRetry`. Never for another
   * reason and never for a document without a pin.
   */
  rejoinOffered: boolean;
  /**
   * `attempting` while a Rejoin owns the connection; `unconfirmed` after one
   * ended without the server being confirmed to hold the draft.
   */
  rejoinAttempt: CollabRejoinAttempt;
}

function collabWsUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/api/collab`;
}

function readAwarenessUsers(awareness: Awareness, selfUserId: string | undefined): CollabAwarenessUser[] {
  const users: CollabAwarenessUser[] = [];
  awareness.getStates().forEach((state) => {
    const raw = (state as { user?: { id?: unknown; name?: unknown } }).user;
    if (!raw || typeof raw.id !== 'string' || raw.id.length === 0) return;
    if (selfUserId && raw.id === selfUserId) return;
    users.push({
      id: raw.id,
      name: typeof raw.name === 'string' && raw.name.length > 0 ? raw.name : raw.id,
      color: caretColorForUserId(raw.id),
    });
  });
  return users;
}

/** Join error before the first sync for each 4403 reason the gateway names. */
const PRE_SYNC_REFUSALS: Record<CollabRefusalReason, Exclude<CollabJoinError, 'unauthorized' | 'not_found'>> = {
  forbidden: 'forbidden',
  readonly: 'join_interrupted',
  rate_limited: 'rate_limited',
  flag_off: 'flag_off',
};

/**
 * Join error for a terminal close other than 4401. A 4403 reason only changes
 * the outcome before the first sync; after it, and for any reason the client
 * does not know, 4403 stays `forbidden` (fail closed).
 */
function terminalJoinError(
  code: number,
  reason: string,
  hasSynced: boolean,
): Exclude<CollabJoinError, 'unauthorized'> | null {
  if (code === 4404) return 'not_found';
  if (code !== 4403) return null;
  const refusal = CollabRefusalReasonSchema.safeParse(reason);
  if (hasSynced || !refusal.success) return 'forbidden';
  return PRE_SYNC_REFUSALS[refusal.data];
}

/**
 * Read-only reason for a 4403 after the first sync (#1927): the three reasons
 * the gateway names are carried to the banner; `forbidden`, an unknown and an
 * empty reason stay `permission_loss` (fail closed).
 */
function postSyncReadOnlyReason(code: number, reason: string, hasSynced: boolean): CollabReadOnlyReason {
  if (code !== 4403 || !hasSynced) return 'permission_loss';
  const refusal = CollabRefusalReasonSchema.safeParse(reason);
  if (!refusal.success || refusal.data === 'forbidden') return 'permission_loss';
  return refusal.data;
}

/** Inclusion as the Save route checks it: every clock and every deletion of `requested`. */
function snapshotIncludes(actual: Y.Snapshot, requested: Y.Snapshot): boolean {
  for (const [client, clock] of requested.sv) {
    if ((actual.sv.get(client) ?? 0) < clock) return false;
  }
  return Y.equalDeleteSets(actual.ds, Y.mergeDeleteSets([actual.ds, requested.ds]));
}

/** One Rejoin: it owns the connection from `retry()` until success or its first close. */
interface RejoinAttemptState {
  /** Clocks and deletions of the local document when the attempt connected. */
  target: Y.Snapshot;
  admission: boolean;
  synced: boolean;
  serverStep1: boolean;
  proof: 'idle' | 'in_flight' | 'covered';
  reprobeTimer?: ReturnType<typeof setTimeout>;
  deadlineTimer?: ReturnType<typeof setTimeout>;
}

/**
 * y-websocket 3.1 provider for `/api/collab/:pageId`.
 *
 * - `if (!token) return` — never `protocols: [v1, '']`.
 * - 4401 on `closed` (shouldConnect already false) → refresh JWT, set
 *   `protocols`, `connect()` on the same instance.
 * - A document keeps the lifecycle revision it joined with across reconnects.
 * - A document keeps the epoch it first synced with (#2034): the `doc_epoch`
 *   control of the connection that delivers the first sync is pinned and sent
 *   as `expectedDocEpoch` on every later join (y-websocket rebuilds its URL
 *   from `params` on each connect). Nothing is declared on the first join. The
 *   pin never changes; a first sync without the control stays unpinned.
 * - A writable admission is acknowledged explicitly; page state is not permission.
 * - Lifecycle, permission, and document resets preserve the Y.Doc for recovery,
 *   disconnect it, and never silently replay it into a new lifecycle.
 * - `commit_unknown` (the control, or the `1001 commit_unknown` close for a
 *   client that missed it) keeps the Y.Doc the same way and never reconnects
 *   (#2035): a collaborative save of the page did not finish and its result is
 *   unknown. The `permission_loss` the server sends after it changes nothing.
 * - Before the first sync a 4403 reason is parsed with `CollabRefusalReasonSchema`:
 *   `rate_limited` (Retry once `COLLAB_UPGRADE_WINDOW_SEC` has passed), `flag_off`,
 *   and `readonly` (an interrupted join, Retry at once) preserve no document.
 *   An unknown reason stays `forbidden`.
 * - After the first sync every 4403 keeps the draft read-only. A `rate_limited`
 *   one of a document with a pinned epoch also offers a manual Rejoin (#2036,
 *   A4) once `COLLAB_UPGRADE_WINDOW_SEC` has passed. `retry()` then reconnects
 *   the same provider and Y.Doc; the attempt owns every close (a terminal close
 *   ends it in the read-only draft, 4401 does not refresh, and no y-websocket
 *   timer starts a second one). It succeeds only with all of: a
 *   `writable_admission` for the joined revision, a `sync` of this connection,
 *   the server's own SyncStep1 (#1928) and a proof that the server's full
 *   state, asked for with an empty state vector after the replay and decoded
 *   into a separate document, includes this draft. Any close or no proof within
 *   `REJOIN_COVERAGE_TIMEOUT_MS` keeps `rate_limited` with Rejoin available at once.
 * - A transient close before the first sync sets `reconnecting`; y-websocket retries.
 * - `disableBc: true` so two tabs go through Redis, not BroadcastChannel.
 */
export function useCollabProvider({
  pageId,
  enabled,
  expectedLifecycleRevision,
}: {
  pageId: string | undefined;
  enabled: boolean;
  expectedLifecycleRevision?: string;
}): UseCollabProviderResult {
  const [ydoc, setYdoc] = useState<Y.Doc | null>(null);
  const [provider, setProvider] = useState<WebsocketProvider | null>(null);
  const [synced, setSynced] = useState(false);
  const [connected, setConnected] = useState(false);
  const [writable, setWritable] = useState(false);
  const [readOnlyReason, setReadOnlyReason] = useState<CollabReadOnlyReason | null>(null);
  const [awarenessUsers, setAwarenessUsers] = useState<CollabAwarenessUser[]>([]);
  const [error, setError] = useState<CollabJoinError | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [canRetry, setCanRetry] = useState(false);
  const [docEpochPinned, setDocEpochPinned] = useState(false);
  const [rejoinOffered, setRejoinOffered] = useState(false);
  const [rejoinAttempt, setRejoinAttempt] = useState<CollabRejoinAttempt>('idle');
  // Refetches must not upgrade the epoch of an already-open document.
  const latestRevision = useRef(expectedLifecycleRevision);
  latestRevision.current = expectedLifecycleRevision;
  // Each join installs its own rejoin; `retry` keeps one identity for callers.
  const retryRef = useRef<() => void>(() => undefined);
  const retry = useCallback(() => retryRef.current(), []);

  useEffect(() => {
    setConnected(false);
    setWritable(false);
    setReadOnlyReason(null);
    setReconnecting(false);
    setCanRetry(false);
    setDocEpochPinned(false);
    setRejoinOffered(false);
    setRejoinAttempt('idle');
    if (!enabled || !pageId) {
      setYdoc(null);
      setProvider(null);
      setSynced(false);
      setAwarenessUsers([]);
      setError(null);
      return;
    }

    const token = useAuthStore.getState().accessToken;
    if (!token) {
      setError('unauthorized');
      return;
    }

    let cancelled = false;
    let blocked = false;
    let rejoinBackoffMs = REJOIN_BACKOFF_START_MS;
    // Same timer-handle type use-presence uses for its reconnect timer.
    let rejoinTimer: ReturnType<typeof setTimeout> | undefined;
    let pausedToken: string | null | undefined;
    let hasSynced = false;
    let retryReady = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    // The pinned epoch, once the first sync has set it (#2034), and the Rejoin
    // state of a post-sync `rate_limited` (#2036). Each window and each attempt
    // has its own generation, so a timer or refresh queued before cannot act.
    let docEpochPin: string | null = null;
    let rejoinReady = false;
    let windowGeneration = 0;
    let generation = 0;
    let attempt: RejoinAttemptState | null = null;
    // The `doc_epoch` control of the current connection, until the first sync
    // pins it. The document is empty before that sync, so the epoch named by
    // the connection that fills it is the lineage the document belongs to.
    let docEpochCandidate: string | null = null;
    const joinedRevision = latestRevision.current;
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    setYdoc(doc);
    setError(null);
    setSynced(false);
    const selfUserId = useAuthStore.getState().user?.id;
    const refreshAwareness = () => {
      if (!cancelled) setAwarenessUsers(readAwarenessUsers(awareness, selfUserId));
    };
    awareness.on('update', refreshAwareness);

    const ws = new WebsocketProvider(collabWsUrl(), String(pageId), doc, {
      protocols: [COLLAB_WS_PROTOCOL, token],
      params: joinedRevision === undefined ? {} : { expectedLifecycleRevision: joinedRevision },
      disableBc: true,
      resyncInterval: 30_000,
      awareness,
    });
    setProvider(ws);

    const resumeWithNewToken = () => {
      const state = useAuthStore.getState();
      if (cancelled || blocked || pausedToken === undefined || !state.accessToken ||
          state.accessToken === pausedToken || state.user?.id !== selfUserId) return;
      pausedToken = undefined;
      ws.protocols = [COLLAB_WS_PROTOCOL, state.accessToken];
      ws.connect();
    };
    const unsubscribeAuth = useAuthStore.subscribe(resumeWithNewToken);

    const clearAttempt = () => {
      if (!attempt) return;
      clearTimeout(attempt.reprobeTimer);
      clearTimeout(attempt.deadlineTimer);
      attempt = null;
    };
    // Only a post-sync `rate_limited` of a document with a pinned epoch is
    // offered a manual Rejoin; it opens one window after the refusal (the
    // server's fixed window started at or before it). Every other reason, and
    // a second `rate_limited`, resets the offer and its window.
    const settleRejoinOffer = (reason: CollabReadOnlyReason) => {
      if (!hasSynced) return;
      windowGeneration += 1;
      clearTimeout(retryTimer);
      rejoinReady = false;
      setCanRetry(false);
      setRejoinAttempt('idle');
      const offered = reason === 'rate_limited' && docEpochPin !== null;
      setRejoinOffered(offered);
      if (!offered) return;
      const armed = windowGeneration;
      retryTimer = setTimeout(() => {
        if (cancelled || armed !== windowGeneration) return;
        rejoinReady = true;
        setCanRetry(true);
      }, COLLAB_UPGRADE_WINDOW_SEC * 1000);
    };
    const preserveReadOnly = (reason: CollabReadOnlyReason) => {
      if (cancelled || (blocked && !attempt)) return;
      clearAttempt();
      blocked = true;
      setWritable(false);
      setConnected(false);
      setReadOnlyReason(reason);
      // Keep both the document and provider identity mounted in TipTap.
      ws.disconnect();
      settleRejoinOffer(reason);
    };
    // A refused first join has no document to preserve; a retry is explicit.
    const refuseBeforeSync = (joinError: Exclude<CollabJoinError, 'unauthorized' | 'forbidden' | 'not_found'>) => {
      if (cancelled || blocked) return;
      blocked = true;
      setWritable(false);
      setConnected(false);
      setReconnecting(false);
      setError(joinError);
      if (joinError === 'join_interrupted') {
        retryReady = true;
        setCanRetry(true);
      } else if (joinError === 'rate_limited') {
        // The server's fixed window started at or before this refusal.
        retryTimer = setTimeout(() => {
          if (cancelled) return;
          retryReady = true;
          setCanRetry(true);
        }, COLLAB_UPGRADE_WINDOW_SEC * 1000);
      }
    };
    // The attempt ended without the server being confirmed to hold the draft:
    // no reconnecting, `rate_limited` kept, and Rejoin available at once.
    const endAttemptUnconfirmed = () => {
      if (cancelled || !attempt) return;
      clearAttempt();
      ws.disconnect();
      setConnected(false);
      setWritable(false);
      rejoinReady = true;
      setCanRetry(true);
      setRejoinAttempt('unconfirmed');
    };
    // All four conditions of D-2036; nothing else, and never the sticky
    // `hasSynced`, restores editing.
    const maybeSucceed = () => {
      const current = attempt;
      if (cancelled || !current || !current.admission || !current.synced ||
          !current.serverStep1 || current.proof !== 'covered') return;
      clearAttempt();
      blocked = false;
      setError(null);
      setReadOnlyReason(null);
      setRejoinOffered(false);
      setRejoinAttempt('idle');
      setConnected(true);
      setWritable(true);
    };
    const sendProbe = (current: RejoinAttemptState) => {
      if (attempt !== current || current.proof !== 'idle' || !ws.wsconnected || ws.ws === null) return;
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      encoding.writeVarUint(encoder, syncProtocol.messageYjsSyncStep1);
      encoding.writeVarUint8Array(encoder, EMPTY_STATE_VECTOR);
      current.proof = 'in_flight';
      try {
        ws.ws.send(encoding.toUint8Array(encoder));
      } catch {
        endAttemptUnconfirmed();
      }
    };
    // The server answered the probe with its whole state. Decode it into a
    // document of its own: the local one may change while the attempt runs.
    const evaluateProbe = (current: RejoinAttemptState, answer: Uint8Array) => {
      let covered = false;
      const probeDoc = new Y.Doc();
      try {
        Y.applyUpdate(probeDoc, answer);
        covered = snapshotIncludes(Y.snapshot(probeDoc), current.target);
      } catch {
        covered = false;
      } finally {
        probeDoc.destroy();
      }
      if (covered) {
        current.proof = 'covered';
        maybeSucceed();
        return;
      }
      current.proof = 'idle';
      current.reprobeTimer = setTimeout(() => sendProbe(current), REJOIN_REPROBE_MS);
    };
    // A terminal close of the attempt's connection: it ends in the read-only
    // draft with its own reason; 4401 does not refresh a token here.
    const settleAttemptClose = (event: { code: number; reason: string }) => {
      if (event.code === 4401) {
        setError('unauthorized');
        preserveReadOnly('unauthorized');
        return;
      }
      const joinError = terminalJoinError(event.code, event.reason, true);
      if (joinError === 'forbidden') {
        setError('forbidden');
        preserveReadOnly(postSyncReadOnlyReason(event.code, event.reason, true));
      } else if (joinError === 'not_found') {
        setError('not_found');
        preserveReadOnly('not_found');
      } else {
        endAttemptUnconfirmed();
      }
    };
    const startRejoin = (accessToken: string) => {
      rejoinReady = false;
      // Whatever a refresh or backoff queued before this attempt must not act on it.
      generation += 1;
      clearTimeout(rejoinTimer);
      pausedToken = undefined;
      setCanRetry(false);
      const current: RejoinAttemptState = {
        target: Y.snapshot(doc), admission: false, synced: false, serverStep1: false, proof: 'idle',
      };
      attempt = current;
      current.deadlineTimer = setTimeout(() => {
        if (attempt === current) endAttemptUnconfirmed();
      }, REJOIN_COVERAGE_TIMEOUT_MS);
      setRejoinAttempt('attempting');
      ws.protocols = [COLLAB_WS_PROTOCOL, accessToken];
      ws.connect();
    };
    retryRef.current = () => {
      const state = useAuthStore.getState();
      if (cancelled || !state.accessToken || state.user?.id !== selfUserId) return;
      if (hasSynced) {
        if (rejoinReady && !attempt) startRejoin(state.accessToken);
        return;
      }
      if (!retryReady) return;
      retryReady = false;
      blocked = false;
      setCanRetry(false);
      setError(null);
      ws.protocols = [COLLAB_WS_PROTOCOL, state.accessToken];
      ws.connect();
    };
    // The stock handler answers the server's SyncStep1 with this document's
    // SyncStep2 once it returns. During an attempt, note that SyncStep1, ask for
    // the server's whole state after that reply, and read the answer to it.
    const stockSyncHandler = ws.messageHandlers[MESSAGE_SYNC];
    ws.messageHandlers[MESSAGE_SYNC] = (encoder, decoder, wsProvider, emitSynced, messageType) => {
      const current = attempt;
      if (!current || !stockSyncHandler) {
        stockSyncHandler?.(encoder, decoder, wsProvider, emitSynced, messageType);
        return;
      }
      const syncType = decoding.peekVarUint(decoder);
      // The first SyncStep2 answers the provider's own SyncStep1 and makes it
      // `synced`; only one received after that, while a probe is out, answers the probe.
      let answer: Uint8Array | null = null;
      if (syncType === syncProtocol.messageYjsSyncStep2 && current.proof === 'in_flight' && wsProvider.synced) {
        const ahead = decoding.clone(decoder);
        decoding.readVarUint(ahead);
        answer = decoding.readVarUint8Array(ahead);
      }
      stockSyncHandler(encoder, decoder, wsProvider, emitSynced, messageType);
      if (attempt !== current) return;
      if (syncType === syncProtocol.messageYjsSyncStep1 && !current.serverStep1) {
        current.serverStep1 = true;
        // After this handler returned, the reply to that SyncStep1 has been sent.
        void Promise.resolve().then(() => sendProbe(current));
      }
      if (answer) evaluateProbe(current, answer);
      else maybeSucceed();
    };
    ws.messageHandlers[MESSAGE_CONTROL] = (_encoder, decoder) => {
      try {
        const control: unknown = JSON.parse(decoding.readVarString(decoder));
        const lifecycle = PageLifecycleEventSchema.safeParse(control);
        if (lifecycle.success) {
          if (lifecycle.data.pageId !== Number(pageId)) return;
          if (joinedRevision !== undefined &&
              BigInt(lifecycle.data.lifecycleRevision) < BigInt(joinedRevision)) return;
          if (lifecycle.data.isFrozen) preserveReadOnly('frozen');
          else if (lifecycle.data.lifecycleRevision !== joinedRevision) preserveReadOnly('lifecycle_changed');
          return;
        }
        const docEpoch = CollabDocEpochControlSchema.safeParse(control);
        if (docEpoch.success) {
          // After the first sync the pin stands; a later control changes nothing.
          if (!hasSynced) docEpochCandidate = docEpoch.data.epoch;
          return;
        }
        const admission = CollabWritableAdmissionControlSchema.safeParse(control);
        if (admission.success) {
          if (cancelled || admission.data.lifecycleRevision !== joinedRevision) return;
          if (attempt) {
            attempt.admission = true;
            maybeSucceed();
          } else if (!blocked) {
            setWritable(true);
          }
          return;
        }
        if (CollabCommitUnknownControlSchema.safeParse(control).success) {
          preserveReadOnly('commit_unknown');
          return;
        }
        if (typeof control !== 'object' || control === null || !('type' in control)) return;
        if (control.type === 'writable_refused') preserveReadOnly('lifecycle_changed');
        else if (control.type === 'permission_loss') preserveReadOnly('permission_loss');
        else if (control.type === 'doc_reset') preserveReadOnly('document_changed');
        else if (control.type === 'tombstone') preserveReadOnly('not_found');
      } catch {
        // Unknown control frames never grant edit authority.
      }
    };
    ws.on('sync', (isSynced: boolean) => {
      if (cancelled || !isSynced) return;
      if (attempt) {
        // The sync of this attempt's connection, not the sticky first one.
        attempt.synced = true;
        maybeSucceed();
        return;
      }
      if (!hasSynced && docEpochCandidate !== null) {
        docEpochPin = docEpochCandidate;
        ws.params = { ...ws.params, expectedDocEpoch: docEpochCandidate };
        setDocEpochPinned(true);
      }
      hasSynced = true;
      setSynced(true);
      setReconnecting(false);
    });
    ws.on('status', ({ status }: { status: string }) => {
      // A connected socket ends any refresh outage, as in use-presence.
      if (status === 'connected') rejoinBackoffMs = REJOIN_BACKOFF_START_MS;
      if (!cancelled && !blocked) setConnected(status === 'connected');
    });
    ws.on('closed', (event: { code: number; reason: string }) => {
      if (cancelled) return;
      if (attempt) {
        settleAttemptClose(event);
        return;
      }
      if (blocked) return;
      setWritable(false);
      if (event.code === 4401) {
        const refreshToken = useAuthStore.getState().accessToken;
        const queued = generation;
        refreshAccessTokenOnce().then(
          (fresh) => {
            if (cancelled || blocked || queued !== generation) return;
            if (!fresh) {
              setError('unauthorized');
              preserveReadOnly('unauthorized');
              return;
            }
            ws.protocols = [COLLAB_WS_PROTOCOL, fresh];
            ws.connect();
          },
          (error: unknown) => {
            if (cancelled || blocked || queued !== generation) return;
            if (error instanceof RefreshUnavailableError && !error.retrySafe) {
              // Keep this draft/provider, but never reconnect with the stale
              // token to repeat a rotation whose outcome is unknown.
              pausedToken = refreshToken;
              resumeWithNewToken();
              return;
            }
            // Marked busy responses prove rollback, so rejoining is safe.
            const delay = rejoinBackoffMs;
            rejoinBackoffMs = Math.min(rejoinBackoffMs * 2, REJOIN_BACKOFF_CAP_MS);
            rejoinTimer = setTimeout(() => {
              if (cancelled || blocked || queued !== generation) return;
              const current = useAuthStore.getState().accessToken;
              if (current) ws.protocols = [COLLAB_WS_PROTOCOL, current];
              ws.connect();
            }, delay);
          },
        );
        return;
      }
      const joinError = terminalJoinError(event.code, event.reason, hasSynced);
      if (joinError === 'forbidden' || joinError === 'not_found') {
        setError(joinError);
        preserveReadOnly(joinError === 'forbidden' ? postSyncReadOnlyReason(event.code, event.reason, hasSynced) : 'not_found');
      } else if (joinError) {
        refuseBeforeSync(joinError);
      }
    });
    ws.on('connection-close', (event: CloseEvent | null) => {
      // A connection that closed before the first sync filled nothing: its
      // epoch is not this document's.
      if (!hasSynced) docEpochCandidate = null;
      if (cancelled) return;
      setConnected(false);
      setWritable(false);
      if (attempt) {
        // No y-websocket timer may start a second attempt after this close.
        ws.shouldConnect = false;
        if (event?.code === 1001 && event.reason === 'doc_reset') preserveReadOnly('document_changed');
        else if (event?.code === 1001 && event.reason === 'commit_unknown') preserveReadOnly('commit_unknown');
        // A terminal close follows as `closed` and is settled once, there.
        else if (event === null || event.code < 4400 || event.code >= 4500) endAttemptUnconfirmed();
        return;
      }
      if (event?.code === 1001 && event.reason === 'doc_reset') preserveReadOnly('document_changed');
      if (event?.code === 1001 && event.reason === 'commit_unknown') preserveReadOnly('commit_unknown');
      // y-websocket retries every close outside 4400–4499; those arrive as `closed`.
      const terminal = event !== null && event.code >= 4400 && event.code < 4500;
      if (!hasSynced && !blocked && !terminal) setReconnecting(true);
    });

    return () => {
      cancelled = true;
      unsubscribeAuth();
      clearTimeout(rejoinTimer);
      clearTimeout(retryTimer);
      clearAttempt();
      retryRef.current = () => undefined;
      awareness.off('update', refreshAwareness);
      ws.destroy();
      awareness.destroy();
      doc.destroy();
      setYdoc(null);
      setProvider(null);
      setSynced(false);
      setAwarenessUsers([]);
      setReconnecting(false);
      setCanRetry(false);
      setDocEpochPinned(false);
      setRejoinOffered(false);
      setRejoinAttempt('idle');
    };
  }, [enabled, pageId]);

  return {
    ydoc, provider, synced, connected, writable, readOnlyReason, awarenessUsers, error,
    reconnecting, canRetry, retry, docEpochPinned, rejoinOffered, rejoinAttempt,
  };
}
