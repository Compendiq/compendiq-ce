import { useCallback, useEffect, useRef, useState } from 'react';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import { Awareness } from 'y-protocols/awareness';
import {
  COLLAB_DOC_EMPTY_MARKER,
  COLLAB_DOC_REPLAY_SAFE,
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
import { createRejoinController } from './collab-rejoin-attempt';

const MESSAGE_CONTROL = 4;
// Retry-safe busy refresh failures rejoin with backoff, as in use-presence.
const REJOIN_BACKOFF_START_MS = 1_000;
const REJOIN_BACKOFF_CAP_MS = 30_000;
// A manual Rejoin attempt waits this long for its one token refresh, apart
// from the proof limit: the refresh is the shared cookie rotation and may
// stall on the cross-tab lock or the network.
export const REJOIN_REFRESH_WAIT_MS = 30_000;
const MESSAGE_SYNC = 0;
// y-websocket's own periodic resync interval. The hook keeps that timer so it
// can stand still while a Rejoin attempt runs (collab-rejoin-attempt.ts).
const RESYNC_INTERVAL_MS = 30_000;

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
 * nothing. An unpinned document with content declares nothing; the hook
 * leaves only one such document connecting, one whose first sync came without
 * the `doc_epoch` control. A document that holds bytes before its first sync
 * never reaches a connect: the hook replaces it with a clean one (#1928).
 */
class CollabWebsocketProvider extends WebsocketProvider {
  override get url(): string {
    const url = super.url;
    if (this.params.expectedDocEpoch !== undefined || !holdsNoDocument(this.doc)) return url;
    return `${url}${url.includes('?') ? '&' : '?'}expectedDocEmpty=${COLLAB_DOC_EMPTY_MARKER}`;
  }
}

/** What a clean session continues from the session it replaces (#1928). */
interface CleanRestart {
  pageId: string;
  /** The lifecycle revision the replaced session joined with. */
  joinedRevision: string | undefined;
  /** The token of an explicit connect; null reads the auth store. */
  token: string | null;
  /** Wait before connecting: y-websocket's backoff for a retry, 0 for an explicit connect. */
  delayMs: number;
  /** y-websocket's count of unsuccessful connections, so the backoff keeps growing. */
  unsuccessful: number;
  reconnecting: boolean;
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
 *   each connect). Until then a join sends `expectedDocEmpty`. The pin never
 *   changes; a first sync without the control stays unpinned and declares
 *   nothing afterwards.
 * - Only a clean document is pinned (#1928). A connection can leave bytes in
 *   the document before its first sync (an Update fanned out before the
 *   SyncStep2, a sync cut short) and then close. Their lineage is unknown, so
 *   they are never pinned and never replayed by the server's SyncStep1: the
 *   next connect, whether y-websocket's own retry or an explicit one (token
 *   refresh, Retry), starts a clean session through this hook's session
 *   reset (new Y.Doc, awareness and provider; the editor rebinds to them).
 *   It keeps the backoff and `reconnecting`, and declares the marker. Before
 *   the first sync the editor holds no user content, so nothing is lost.
 * - Every connect sends `docReplaySafe=1` (#1928), Retry and token refresh
 *   included: the clean-document rule above makes this bundle safe to ask for
 *   what the room lacks, and the server sends its SyncStep1 only to a
 *   verified writer that says so. It grants nothing.
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
 *   An unknown reason stays `forbidden`.
 * - After the first sync every 4403 keeps the draft read-only. A `rate_limited`
 *   one of a document with a pinned epoch also offers a manual Rejoin (#2036,
 *   A4) once `COLLAB_UPGRADE_WINDOW_SEC` has passed. `retry()` then reconnects
 *   the same provider and Y.Doc; the attempt owns every close (a terminal close
 *   ends it in the read-only draft, and no y-websocket timer starts a second
 *   one). A 4401 refreshes the token once, through the same
 *   `refreshAccessTokenOnce` as outside an attempt, and continues the same
 *   attempt on a new connection with a fresh proof limit, only while the
 *   current account is still the document's (checked before the request and
 *   again before its result is used, with that session's token); a second 4401
 *   of the attempt, a refresh that leaves no session or another account ends it
 *   in the read-only `unauthorized` draft, and a refresh that cannot tell, or
 *   that does not settle within `REJOIN_REFRESH_WAIT_MS`, ends it unconfirmed
 *   (a late result is ignored; the shared rotation is neither cancelled nor replayed).
 *   It succeeds only with all of: a
 *   `writable_admission` for the joined revision, a `sync` of this connection,
 *   the server's own SyncStep1 (#1928) and a proof that the server's full
 *   state, asked for with an empty state vector after the replay and decoded
 *   into a separate document, includes this draft. Any other close or no proof
 *   within `REJOIN_COVERAGE_TIMEOUT_MS` keeps `rate_limited` with Rejoin
 *   available at once.
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
  const declareCommitUnknownRef = useRef<(document: Y.Doc) => void>(() => undefined);
  const declareCommitUnknown = useCallback((document: Y.Doc) => declareCommitUnknownRef.current(document), []);
  // A session that ended before its first sync with bytes in its document asks
  // for a clean one (#1928): bumping `session` runs the effect's teardown and
  // setup, and `cleanRestart` carries what the next connect continues with.
  const [session, setSession] = useState(0);
  const cleanRestart = useRef<CleanRestart | null>(null);

  useEffect(() => {
    // Only a restart of this very page continues; anything else starts fresh.
    const restart = cleanRestart.current?.pageId === pageId ? cleanRestart.current : null;
    cleanRestart.current = null;
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

    const token = restart?.token ?? useAuthStore.getState().accessToken;
    if (!token) {
      setError('unauthorized');
      return;
    }

    let cancelled = false;
    let blocked = false;
    let rejoinBackoffMs = REJOIN_BACKOFF_START_MS;
    // Same timer-handle type use-presence uses for its reconnect timer.
    let rejoinTimer: ReturnType<typeof setTimeout> | undefined;
    let restartTimer: ReturnType<typeof setTimeout> | undefined;
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
    // One token refresh per Rejoin attempt; the second 4401 ends it.
    let attemptRefreshed = false;
    let refreshWaitTimer: ReturnType<typeof setTimeout> | undefined;
    // The `doc_epoch` control of the current connection, until the first sync
    // pins it: the pin is the candidate of the first connection that syncs.
    // Every byte the document holds then came from that connection: an earlier
    // one either left nothing or ended this session (`restartClean`).
    let docEpochCandidate: string | null = null;
    // A clean restart is still the same join: it keeps the revision it joined with.
    const joinedRevision = restart ? restart.joinedRevision : latestRevision.current;
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

    // The periodic resync is the hook's own (below), not the provider's.
    const ws = new CollabWebsocketProvider(collabWsUrl(), String(pageId), doc, {
      protocols: [COLLAB_WS_PROTOCOL, token],
      // Every connect says this bundle is replay-safe (#1928): it never pins
      // or replays bytes received before a first sync (`restartClean`). Only
      // then does the server ask it for what the room lacks. Later `params`
      // updates keep it.
      params: {
        ...(joinedRevision === undefined ? {} : { expectedLifecycleRevision: joinedRevision }),
        docReplaySafe: COLLAB_DOC_REPLAY_SAFE,
      },
      disableBc: true,
      awareness,
      // A clean restart connects at the end of setup, after its backoff.
      connect: restart === null,
    });
    setProvider(ws);
    // The manual Rejoin (#2036): one attempt on this provider, owning every
    // close until it succeeds or ends. The callbacks are defined below.
    const rejoin = createRejoinController(ws, {
      onSucceeded: () => onRejoinSucceeded(),
      onUnconfirmed: () => onRejoinUnconfirmed(),
    });
    // What y-websocket's `resyncInterval` does, except that it stands still
    // while an attempt runs: a differential SyncStep2 to that request would be
    // indistinguishable from the answer to the attempt's coverage probe.
    const resyncTimer = setInterval(() => {
      if (rejoin.running || ws.ws === null || ws.ws.readyState !== WebSocket.OPEN) return;
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeSyncStep1(encoder, doc);
      ws.ws.send(encoding.toUint8Array(encoder));
    }, RESYNC_INTERVAL_MS);

    /**
     * Ends this session before its first sync because its document holds
     * bytes no first sync accounted for, and asks for a clean one that
     * continues the join (#1928). Never called after the first sync: from
     * then on the document may hold the user's edits.
     */
    const restartClean = (next: Omit<CleanRestart, 'pageId' | 'joinedRevision'>) => {
      if (cancelled) return;
      ws.shouldConnect = false;
      cleanRestart.current = { ...next, pageId: String(pageId), joinedRevision };
      setSession((current) => current + 1);
    };
    /** Every explicit connect: this session, or a clean one when its document holds bytes before its first sync. */
    const connectSession = (connectToken: string | null) => {
      if (!hasSynced && !holdsNoDocument(doc)) {
        restartClean({ token: connectToken, delayMs: 0, unsuccessful: ws.wsUnsuccessfulReconnects, reconnecting: false });
        return;
      }
      if (connectToken) ws.protocols = [COLLAB_WS_PROTOCOL, connectToken];
      ws.connect();
    };

    const resumeWithNewToken = () => {
      const state = useAuthStore.getState();
      if (cancelled || blocked || pausedToken === undefined || !state.accessToken ||
          state.accessToken === pausedToken || state.user?.id !== selfUserId) return;
      pausedToken = undefined;
      connectSession(state.accessToken);
    };
    const unsubscribeAuth = useAuthStore.subscribe(resumeWithNewToken);

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
    // The reason of the read-only state this session is in, if any.
    let readOnlyNow: CollabReadOnlyReason | null = null;
    const preserveReadOnly = (reason: CollabReadOnlyReason) => {
      // An unknown collaborative save (#2035) is authoritative about this
      // draft: it replaces the retryable post-sync `rate_limited` state (its
      // cooldown, Rejoin and unconfirmed notice go), but never a terminal
      // refusal or any other read-only reason.
      const replacesRateLimit = reason === 'commit_unknown' && readOnlyNow === 'rate_limited';
      if (cancelled || (blocked && !rejoin.running && !replacesRateLimit)) return;
      rejoin.cancel();
      clearTimeout(refreshWaitTimer);
      blocked = true;
      setWritable(false);
      setConnected(false);
      readOnlyNow = reason;
      setReadOnlyReason(reason);
      // Keep both the document and provider identity mounted in TipTap.
      ws.disconnect();
      settleRejoinOffer(reason);
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
    // The attempt ended without the server being confirmed to hold the draft:
    // no reconnecting, `rate_limited` kept, and Rejoin available at once.
    const onRejoinUnconfirmed = () => {
      if (cancelled) return;
      ws.disconnect();
      setConnected(false);
      setWritable(false);
      rejoinReady = true;
      setCanRetry(true);
      setRejoinAttempt('unconfirmed');
    };
    // All four conditions of D-2036 held (the controller checks them); nothing
    // else, and never the sticky `hasSynced`, restores editing.
    const onRejoinSucceeded = () => {
      if (cancelled) return;
      blocked = false;
      readOnlyNow = null;
      setError(null);
      setReadOnlyReason(null);
      setRejoinOffered(false);
      setRejoinAttempt('idle');
      setConnected(true);
      setWritable(true);
    };
    // A terminal close of the attempt's connection: it ends in the read-only
    // draft with its own reason. A 4401 is refreshed once per attempt, and only
    // for the account that owns this document.
    const endAttemptUnauthorized = () => {
      setError('unauthorized');
      preserveReadOnly('unauthorized');
    };
    const settleAttemptClose = (event: { code: number; reason: string }) => {
      if (event.code === 4401) {
        if (attemptRefreshed || useAuthStore.getState().user?.id !== selfUserId) {
          endAttemptUnauthorized();
          return;
        }
        attemptRefreshed = true;
        rejoin.pause();
        const queued = generation;
        const continueAttempt = () => queued === generation && !cancelled && rejoin.running;
        // The refresh is the shared cookie rotation: it is never cancelled or
        // replayed here. If it does not settle in time the attempt ends
        // unconfirmed and a late result is ignored (the generation moves on).
        clearTimeout(refreshWaitTimer);
        refreshWaitTimer = setTimeout(() => {
          if (continueAttempt()) rejoin.fail();
        }, REJOIN_REFRESH_WAIT_MS);
        refreshAccessTokenOnce().then(
          (fresh) => {
            if (!continueAttempt()) return;
            clearTimeout(refreshWaitTimer);
            // Only the verified session of this document's account may reopen
            // the old provider, with its own token.
            const state = useAuthStore.getState();
            if (!fresh || !state.accessToken || state.user?.id !== selfUserId) {
              endAttemptUnauthorized();
              return;
            }
            ws.protocols = [COLLAB_WS_PROTOCOL, state.accessToken];
            rejoin.resume();
          },
          () => {
            // Whether the rotation happened is unknown: no session is proven
            // lost, and no reconnect is made with the stale token.
            if (!continueAttempt()) return;
            clearTimeout(refreshWaitTimer);
            rejoin.fail();
          },
        );
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
        rejoin.fail();
      }
    };
    const startRejoin = (accessToken: string) => {
      rejoinReady = false;
      // Whatever a refresh or backoff queued before this attempt must not act on it.
      generation += 1;
      attemptRefreshed = false;
      clearTimeout(refreshWaitTimer);
      clearTimeout(rejoinTimer);
      pausedToken = undefined;
      setCanRetry(false);
      setRejoinAttempt('attempting');
      ws.protocols = [COLLAB_WS_PROTOCOL, accessToken];
      rejoin.start(doc);
    };
    retryRef.current = () => {
      const state = useAuthStore.getState();
      if (cancelled || !state.accessToken || state.user?.id !== selfUserId) return;
      if (hasSynced) {
        if (rejoinReady && !rejoin.running) startRejoin(state.accessToken);
        return;
      }
      if (!retryReady) return;
      retryReady = false;
      blocked = false;
      setCanRetry(false);
      setError(null);
      connectSession(state.accessToken);
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
          if (rejoin.running) rejoin.admit();
          else if (!blocked) setWritable(true);
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
      // The attempt's own listener takes the sync of its connection.
      if (rejoin.running) return;
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
      if (rejoin.running) {
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
            connectSession(fresh);
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
              connectSession(useAuthStore.getState().accessToken);
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
      // A connection that closed before its first sync cannot supply the pin:
      // its candidate is discarded.
      if (!hasSynced) docEpochCandidate = null;
      if (cancelled) return;
      setConnected(false);
      setWritable(false);
      if (rejoin.running) {
        // No y-websocket timer may start a second attempt after this close.
        ws.shouldConnect = false;
        if (event?.code === 1001 && event.reason === 'doc_reset') preserveReadOnly('document_changed');
        else if (event?.code === 1001 && event.reason === 'commit_unknown') preserveReadOnly('commit_unknown');
        // A terminal close follows as `closed` and is settled once, there.
        else if (event === null || event.code < 4400 || event.code >= 4500) rejoin.fail();
        return;
      }
      if (event?.code === 1001 && event.reason === 'doc_reset') preserveReadOnly('document_changed');
      if (event?.code === 1001 && event.reason === 'commit_unknown') preserveReadOnly('commit_unknown');
      // y-websocket retries every close outside 4400–4499; those arrive as `closed`.
      const terminal = event !== null && event.code >= 4400 && event.code < 4500;
      if (!hasSynced && !blocked && !terminal) {
        setReconnecting(true);
        // Its retry would carry the bytes this connection left behind: a clean
        // session retries instead, after the same backoff. y-websocket counts
        // this close right after this event and waits 2^count × 100 ms.
        if (!holdsNoDocument(doc)) {
          const unsuccessful = ws.wsUnsuccessfulReconnects + 1;
          restartClean({
            token: null,
            delayMs: Math.min(2 ** unsuccessful * 100, ws.maxBackoffTime),
            unsuccessful,
            reconnecting: true,
          });
        }
      }
    });

    if (restart) {
      ws.wsUnsuccessfulReconnects = restart.unsuccessful;
      if (restart.reconnecting) setReconnecting(true);
      if (restart.delayMs === 0) ws.connect();
      else restartTimer = setTimeout(() => { if (!cancelled) ws.connect(); }, restart.delayMs);
    }

    return () => {
      cancelled = true;
      unsubscribeAuth();
      clearTimeout(rejoinTimer);
      clearTimeout(refreshWaitTimer);
      clearTimeout(restartTimer);
      clearTimeout(retryTimer);
      rejoin.cancel();
      clearInterval(resyncTimer);
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
      setRejoinOffered(false);
      setRejoinAttempt('idle');
    };
  }, [enabled, pageId, session]);

  return {
    ydoc, provider, synced, connected, writable, readOnlyReason, awarenessUsers, error,
    reconnecting, canRetry, retry, docEpochPinned, rejoinOffered, rejoinAttempt,
    declareCommitUnknown,
  };
}
