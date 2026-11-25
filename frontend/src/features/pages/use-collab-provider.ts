import { useCallback, useEffect, useRef, useState } from 'react';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import * as decoding from 'lib0/decoding';
import { Awareness } from 'y-protocols/awareness';
import {
  COLLAB_DOC_EMPTY_MARKER,
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

export interface UseCollabProviderResult {
  ydoc: Y.Doc | null;
  provider: WebsocketProvider | null;
  synced: boolean;
  awarenessUsers: CollabAwarenessUser[];
  error: CollabJoinError | null;
  /** Before the first sync only: an attempt closed transiently and y-websocket is reconnecting. */
  reconnecting: boolean;
  /** `retry()` would rejoin now: an interrupted join, or `rate_limited` once the upgrade window passed. */
  canRetry: boolean;
  /** Rejoins after a retryable refusal before the first sync; a no-op otherwise. */
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
   * The Save route answered that the collaborative save of `document` has an
   * unknown result (#2035). Enters the state the `commit_unknown` control
   * does, at once: that control may be late or never arrive. A document that
   * is no longer the mounted one is ignored.
   */
  declareCommitUnknown: (document: Y.Doc) => void;
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

/**
 * Whether `doc` provably holds nothing (#2034): an empty state vector, an
 * empty delete set, and no update parked for a missing dependency (Yjs sends
 * parked updates along with its state).
 */
function holdsNoDocument(doc: Y.Doc): boolean {
  return doc.store.pendingStructs === null
    && doc.store.pendingDs === null
    && Y.equalSnapshots(Y.snapshot(doc), Y.emptySnapshot);
}

/**
 * y-websocket reads `url` once for every connection it opens, so the lineage
 * declaration of a join is decided here, per connect (#2034). A pinned
 * document declares its epoch through `params.expectedDocEpoch` and never the
 * marker. An unpinned document adds `expectedDocEmpty` exactly while it holds
 * nothing. An unpinned document with content (a connection that dropped
 * before its first sync after applying updates, a first sync without the
 * `doc_epoch` control) declares nothing.
 */
class CollabWebsocketProvider extends WebsocketProvider {
  override get url(): string {
    const url = super.url;
    if (this.params.expectedDocEpoch !== undefined || !holdsNoDocument(this.doc)) return url;
    return `${url}${url.includes('?') ? '&' : '?'}expectedDocEmpty=${COLLAB_DOC_EMPTY_MARKER}`;
  }
}

/**
 * y-websocket 3.1 provider for `/api/collab/:pageId`.
 *
 * - `if (!token) return` — never `protocols: [v1, '']`.
 * - 4401 on `closed` (shouldConnect already false) → refresh JWT, set
 *   `protocols`, `connect()` on the same instance.
 * - A document keeps the lifecycle revision it joined with across reconnects.
 * - A document keeps the epoch of the first connection that syncs it (#2034):
 *   that connection's `doc_epoch` control is pinned and sent as
 *   `expectedDocEpoch` on every later join (y-websocket rebuilds its URL on
 *   each connect). Until then a join sends `expectedDocEmpty` while the
 *   document holds nothing, and declares nothing once it holds content of an
 *   unknown lineage. The pin never changes; a first sync without the control
 *   stays unpinned. The pin does not prove the document was empty before that
 *   sync: an earlier connection may have left updates in it.
 * - A writable admission is acknowledged explicitly; page state is not permission.
 * - Lifecycle, permission, and document resets preserve the Y.Doc for recovery,
 *   disconnect it, and never silently replay it into a new lifecycle.
 * - `commit_unknown` (the control, or the `1001 commit_unknown` close for a
 *   client that missed it) keeps the Y.Doc the same way and never reconnects
 *   (#2035): a collaborative save of the page did not finish and its result is
 *   unknown. The `permission_loss` the server sends after it changes nothing.
 *   The Save route's own answer enters the same state through
 *   `declareCommitUnknown`, without waiting for the control.
 * - Before the first sync a 4403 reason is parsed with `CollabRefusalReasonSchema`:
 *   `rate_limited` (Retry once `COLLAB_UPGRADE_WINDOW_SEC` has passed), `flag_off`,
 *   and `readonly` (an interrupted join, Retry at once) preserve no document.
 *   An unknown reason and every 4403 after the first sync stay `forbidden`.
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
  // Refetches must not upgrade the epoch of an already-open document.
  const latestRevision = useRef(expectedLifecycleRevision);
  latestRevision.current = expectedLifecycleRevision;
  // Each join installs its own rejoin; `retry` keeps one identity for callers.
  const retryRef = useRef<() => void>(() => undefined);
  const retry = useCallback(() => retryRef.current(), []);
  const declareCommitUnknownRef = useRef<(document: Y.Doc) => void>(() => undefined);
  const declareCommitUnknown = useCallback((document: Y.Doc) => declareCommitUnknownRef.current(document), []);

  useEffect(() => {
    setConnected(false);
    setWritable(false);
    setReadOnlyReason(null);
    setReconnecting(false);
    setCanRetry(false);
    setDocEpochPinned(false);
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
    // The `doc_epoch` control of the current connection, until the first sync
    // pins it: the pin is the candidate of the first connection that syncs.
    // An earlier connection that dropped before its sync may already have left
    // updates in the document, so the pin is not a proof about those bytes.
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

    const ws = new CollabWebsocketProvider(collabWsUrl(), String(pageId), doc, {
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

    const preserveReadOnly = (reason: CollabReadOnlyReason) => {
      if (cancelled || blocked) return;
      blocked = true;
      setWritable(false);
      setConnected(false);
      setReadOnlyReason(reason);
      // Keep both the document and provider identity mounted in TipTap.
      ws.disconnect();
    };
    declareCommitUnknownRef.current = (document) => {
      if (document === doc) preserveReadOnly('commit_unknown');
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
    retryRef.current = () => {
      const state = useAuthStore.getState();
      if (cancelled || !retryReady || !state.accessToken || state.user?.id !== selfUserId) return;
      retryReady = false;
      blocked = false;
      setCanRetry(false);
      setError(null);
      ws.protocols = [COLLAB_WS_PROTOCOL, state.accessToken];
      ws.connect();
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
          if (!cancelled && !blocked && admission.data.lifecycleRevision === joinedRevision) {
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
      if (!hasSynced && docEpochCandidate !== null) {
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
      if (cancelled || blocked) return;
      setWritable(false);
      if (event.code === 4401) {
        const refreshToken = useAuthStore.getState().accessToken;
        refreshAccessTokenOnce().then(
          (fresh) => {
            if (cancelled || blocked) return;
            if (!fresh) {
              setError('unauthorized');
              preserveReadOnly('unauthorized');
              return;
            }
            ws.protocols = [COLLAB_WS_PROTOCOL, fresh];
            ws.connect();
          },
          (error: unknown) => {
            if (cancelled || blocked) return;
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
              if (cancelled || blocked) return;
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
      retryRef.current = () => undefined;
      declareCommitUnknownRef.current = () => undefined;
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
    };
  }, [enabled, pageId]);

  return {
    ydoc, provider, synced, connected, writable, readOnlyReason, awarenessUsers, error,
    reconnecting, canRetry, retry, docEpochPinned, declareCommitUnknown,
  };
}
