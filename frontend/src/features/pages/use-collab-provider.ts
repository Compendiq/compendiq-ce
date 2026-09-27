import { useEffect, useRef, useState } from 'react';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import * as decoding from 'lib0/decoding';
import { Awareness } from 'y-protocols/awareness';
import { COLLAB_WS_PROTOCOL, CollabWritableAdmissionControlSchema, PageLifecycleEventSchema } from '@compendiq/contracts';
import { refreshAccessTokenOnce } from '../../shared/lib/api';
import { useAuthStore } from '../../stores/auth-store';
import { caretColorForUserId } from '../../shared/lib/collab-colors';
import type { CollabAwarenessUser } from './merge-presence';

const MESSAGE_CONTROL = 4;

export type CollabJoinError = 'unauthorized' | 'forbidden' | 'not_found';
export type CollabReadOnlyReason =
  | 'frozen'
  | 'lifecycle_changed'
  | 'permission_loss'
  | 'document_changed'
  | 'unauthorized'
  | 'not_found';

export interface UseCollabProviderResult {
  ydoc: Y.Doc | null;
  provider: WebsocketProvider | null;
  synced: boolean;
  awarenessUsers: CollabAwarenessUser[];
  error: CollabJoinError | null;
  connected: boolean;
  writable: boolean;
  readOnlyReason: CollabReadOnlyReason | null;
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

function closeCodeError(code: number): CollabJoinError | null {
  if (code === 4401) return 'unauthorized';
  if (code === 4403) return 'forbidden';
  if (code === 4404) return 'not_found';
  return null;
}

/**
 * y-websocket 3.1 provider for `/api/collab/:pageId`.
 *
 * - `if (!token) return` — never `protocols: [v1, '']`.
 * - 4401 on `closed` (shouldConnect already false) → refresh JWT, set
 *   `protocols`, `connect()` on the same instance.
 * - A document keeps the lifecycle revision it joined with across reconnects.
 * - A writable admission is acknowledged explicitly; page state is not permission.
 * - Lifecycle, permission, and document resets preserve the Y.Doc for recovery,
 *   disconnect it, and never silently replay it into a new lifecycle.
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
  // Refetches must not upgrade the epoch of an already-open document.
  const latestRevision = useRef(expectedLifecycleRevision);
  latestRevision.current = expectedLifecycleRevision;

  useEffect(() => {
    setConnected(false);
    setWritable(false);
    setReadOnlyReason(null);
    if (!enabled || !pageId) {
      setYdoc(null);
      setProvider(null);
      setSynced(false);
      setAwarenessUsers([]);
      setError(null);
      return;
    }

    const token = useAuthStore.getState().accessToken;
    if (!token) return;

    let cancelled = false;
    let blocked = false;
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

    const preserveReadOnly = (reason: CollabReadOnlyReason) => {
      if (cancelled || blocked) return;
      blocked = true;
      setWritable(false);
      setConnected(false);
      setReadOnlyReason(reason);
      // Keep both the document and provider identity mounted in TipTap.
      ws.disconnect();
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
        const admission = CollabWritableAdmissionControlSchema.safeParse(control);
        if (admission.success) {
          if (!cancelled && !blocked && admission.data.lifecycleRevision === joinedRevision) {
            setWritable(true);
          }
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
      if (!cancelled && isSynced) setSynced(true);
    });
    ws.on('status', ({ status }: { status: string }) => {
      if (!cancelled && !blocked) setConnected(status === 'connected');
    });
    ws.on('closed', (event: { code: number; reason: string }) => {
      if (cancelled || blocked) return;
      setWritable(false);
      if (event.code === 4401) {
        void refreshAccessTokenOnce().then((fresh) => {
          if (cancelled || blocked) return;
          if (!fresh) {
            setError('unauthorized');
            preserveReadOnly('unauthorized');
            return;
          }
          ws.protocols = [COLLAB_WS_PROTOCOL, fresh];
          ws.connect();
        });
        return;
      }
      const joinError = closeCodeError(event.code);
      if (joinError === 'forbidden' || joinError === 'not_found') {
        setError(joinError);
        preserveReadOnly(joinError === 'forbidden' ? 'permission_loss' : 'not_found');
      }
    });
    ws.on('connection-close', (event: CloseEvent | null) => {
      if (cancelled) return;
      setConnected(false);
      setWritable(false);
      if (event?.code === 1001 && event.reason === 'doc_reset') preserveReadOnly('document_changed');
    });

    return () => {
      cancelled = true;
      awareness.off('update', refreshAwareness);
      ws.destroy();
      awareness.destroy();
      doc.destroy();
      setYdoc(null);
      setProvider(null);
      setSynced(false);
      setAwarenessUsers([]);
    };
  }, [enabled, pageId]);

  return { ydoc, provider, synced, connected, writable, readOnlyReason, awarenessUsers, error };
}
