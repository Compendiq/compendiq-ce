/**
 * The manual Rejoin of a read-only collaborative draft (#2036, D-2036), apart
 * from React so the hook and the live-gateway tests run the same code.
 *
 * One attempt owns one connection of an existing provider and `Y.Doc`, or two
 * when the first is refused with 4401: the hook then `pause()`s the attempt for
 * one token refresh and `resume()`s it on a new connection (the same attempt and
 * recorded target, a fresh deadline). It succeeds only when all four hold: a
 * `writable_admission` for the joined revision (`admit()`), a `sync` event of
 * this connection, the server's own
 * SyncStep1 (#1928), and a coverage proof. The proof asks the server for its
 * whole state with an empty state vector once the provider has sent its
 * SyncStep2 reply to that SyncStep1, decodes the answer into a document of its
 * own and requires it to include the state recorded when the attempt started,
 * with the relation the Save route uses (every clock and every deletion).
 *
 * The provider's periodic resync must stay off while an attempt runs
 * (`useCollabProvider` owns that timer): its differential SyncStep2 would be
 * indistinguishable from the answer to the probe.
 */
import * as Y from 'yjs';
import type { WebsocketProvider } from 'y-websocket';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';

const MESSAGE_SYNC = 0;
/** No proof within this long after the attempt started ends it unsuccessfully. */
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

/** Inclusion as the Save route checks it: every clock and every deletion of `requested`. */
function snapshotIncludes(actual: Y.Snapshot, requested: Y.Snapshot): boolean {
  for (const [client, clock] of requested.sv) {
    if ((actual.sv.get(client) ?? 0) < clock) return false;
  }
  return Y.equalDeleteSets(actual.ds, Y.mergeDeleteSets([actual.ds, requested.ds]));
}

export interface RejoinCallbacks {
  /** All four conditions hold; the caller restores editing. */
  onSucceeded: () => void;
  /** The deadline passed, the probe could not be sent, or `fail()` was called. */
  onUnconfirmed: () => void;
}

export interface RejoinController {
  /** An attempt is in progress: started, and neither succeeded, failed nor cancelled. */
  readonly running: boolean;
  /** Record the target from `doc`, arm the deadline and connect the provider. */
  start: (doc: Y.Doc) => void;
  /** A `writable_admission` for the joined revision arrived on this connection. */
  admit: () => void;
  /** The attempt ended without proof (a close, say): reports `onUnconfirmed`. */
  fail: () => void;
  /** The attempt ended in a refusal or teardown: stops its timers, reports nothing. */
  cancel: () => void;
  /**
   * The connection ended with 4401 and the attempt waits for a token: stops the
   * deadline and forgets what the connection proved. Still `running`.
   */
  pause: () => void;
  /** Continue a paused attempt on a new connection with a fresh deadline. */
  resume: () => void;
}

interface Attempt {
  /** Clocks and deletions of the local document when the attempt started. */
  target: Y.Snapshot;
  /** Waiting for a refreshed token; nothing of a connection counts meanwhile. */
  paused: boolean;
  admitted: boolean;
  synced: boolean;
  serverStep1: boolean;
  proof: 'idle' | 'in_flight' | 'covered';
  reprobeTimer?: ReturnType<typeof setTimeout>;
  deadlineTimer?: ReturnType<typeof setTimeout>;
}

/**
 * Wire an attempt controller to `ws`. Installs the sync-message wrapper and a
 * `sync` listener once; they act only while an attempt runs.
 */
export function createRejoinController(ws: WebsocketProvider, callbacks: RejoinCallbacks): RejoinController {
  let attempt: Attempt | null = null;

  const stop = () => {
    if (!attempt) return;
    clearTimeout(attempt.reprobeTimer);
    clearTimeout(attempt.deadlineTimer);
    attempt = null;
  };
  const armDeadline = (current: Attempt) => {
    current.deadlineTimer = setTimeout(() => {
      if (attempt === current) fail();
    }, REJOIN_COVERAGE_TIMEOUT_MS);
  };
  const fail = () => {
    if (!attempt) return;
    stop();
    callbacks.onUnconfirmed();
  };
  const maybeSucceed = () => {
    const current = attempt;
    if (!current || !current.admitted || !current.synced || !current.serverStep1 || current.proof !== 'covered') return;
    stop();
    callbacks.onSucceeded();
  };
  const sendProbe = (current: Attempt) => {
    if (attempt !== current || current.paused || current.proof !== 'idle' || !ws.wsconnected || ws.ws === null) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    encoding.writeVarUint(encoder, syncProtocol.messageYjsSyncStep1);
    encoding.writeVarUint8Array(encoder, EMPTY_STATE_VECTOR);
    current.proof = 'in_flight';
    try {
      ws.ws.send(encoding.toUint8Array(encoder));
    } catch {
      fail();
    }
  };
  // The server answered the probe with its whole state. Decode it into a
  // document of its own: the local one may change while the attempt runs.
  const evaluateProbe = (current: Attempt, answer: Uint8Array) => {
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

  ws.on('sync', (isSynced: boolean) => {
    if (!isSynced || !attempt || attempt.paused) return;
    // The sync of this attempt's connection, not the sticky first one.
    attempt.synced = true;
    maybeSucceed();
  });

  // The stock handler answers the server's SyncStep1 with this document's
  // SyncStep2 once it returns. During an attempt, note that SyncStep1, ask for
  // the server's whole state after that reply, and read the answer to it.
  const stockSyncHandler = ws.messageHandlers[MESSAGE_SYNC];
  ws.messageHandlers[MESSAGE_SYNC] = (encoder, decoder, wsProvider, emitSynced, messageType) => {
    const current = attempt;
    if (!current || current.paused || !stockSyncHandler) {
      stockSyncHandler?.(encoder, decoder, wsProvider, emitSynced, messageType);
      return;
    }
    const syncType = decoding.peekVarUint(decoder);
    // The first SyncStep2 answers the provider's own SyncStep1 and makes it
    // `synced`. With the periodic resync off, the only SyncStep2 received after
    // that while a probe is out is the probe's answer.
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

  return {
    get running() {
      return attempt !== null;
    },
    start(doc) {
      stop();
      const current: Attempt = {
        target: Y.snapshot(doc), paused: false, admitted: false, synced: false, serverStep1: false, proof: 'idle',
      };
      attempt = current;
      armDeadline(current);
      ws.connect();
    },
    admit() {
      if (!attempt || attempt.paused) return;
      attempt.admitted = true;
      maybeSucceed();
    },
    fail,
    cancel: stop,
    pause() {
      const current = attempt;
      if (!current) return;
      clearTimeout(current.reprobeTimer);
      clearTimeout(current.deadlineTimer);
      current.paused = true;
      current.admitted = false;
      current.synced = false;
      current.serverStep1 = false;
      current.proof = 'idle';
    },
    resume() {
      const current = attempt;
      if (!current || !current.paused) return;
      current.paused = false;
      armDeadline(current);
      ws.connect();
    },
  };
}
