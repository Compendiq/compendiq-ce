import { useEffect, useState } from 'react';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import * as decoding from 'lib0/decoding';
import { Awareness } from 'y-protocols/awareness';
import { COLLAB_WS_PROTOCOL } from '@compendiq/contracts';
import { refreshAccessTokenOnce } from '../../shared/lib/api';
import { useAuthStore } from '../../stores/auth-store';
import { caretColorForUserId } from '../../shared/lib/collab-colors';
import type { CollabAwarenessUser } from './merge-presence';

const MESSAGE_CONTROL = 4;

export type CollabJoinError = 'unauthorized' | 'forbidden' | 'not_found';

export interface UseCollabProviderResult {
  ydoc: Y.Doc | null;
  provider: WebsocketProvider | null;
  synced: boolean;
  awarenessUsers: CollabAwarenessUser[];
  error: CollabJoinError | null;
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
 * - 4403 / 4404 → destroy, do not reconnect.
 * - `doc_reset` / close 1001 `doc_reset` → destroy provider **and** Y.Doc,
 *   then a new pair so TipTap remounts. Never reconnect onto the old document.
 * - `disableBc: true` so two tabs go through Redis, not BroadcastChannel.
 */
export function useCollabProvider({
  pageId,
  enabled,
}: {
  pageId: string | undefined;
  enabled: boolean;
}): UseCollabProviderResult {
  const [ydoc, setYdoc] = useState<Y.Doc | null>(null);
  const [provider, setProvider] = useState<WebsocketProvider | null>(null);
  const [synced, setSynced] = useState(false);
  const [awarenessUsers, setAwarenessUsers] = useState<CollabAwarenessUser[]>([]);
  const [error, setError] = useState<CollabJoinError | null>(null);

  useEffect(() => {
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
      // Do not construct WebsocketProvider with an empty protocol token.
      return;
    }

    let cancelled = false;
    let current: WebsocketProvider | null = null;
    let doc = new Y.Doc();
    let awareness = new Awareness(doc);
    setYdoc(doc);
    setError(null);
    setSynced(false);

    const selfUserId = useAuthStore.getState().user?.id;

    const refreshAwareness = () => {
      if (cancelled) return;
      setAwarenessUsers(readAwarenessUsers(awareness, selfUserId));
    };
    awareness.on('update', refreshAwareness);

    const remount = (jwt: string) => {
      if (cancelled || !jwt) return;
      const oldWs = current;
      const oldDoc = doc;
      const oldAwareness = awareness;
      current = null;
      oldWs?.destroy();
      oldAwareness.off('update', refreshAwareness);
      try { oldAwareness.destroy(); } catch { /* */ }
      try { oldDoc.destroy(); } catch { /* */ }
      doc = new Y.Doc();
      awareness = new Awareness(doc);
      awareness.on('update', refreshAwareness);
      setYdoc(doc);
      setSynced(false);
      setError(null);
      connect(jwt);
    };

    const attachControlHandler = (ws: WebsocketProvider) => {
      ws.messageHandlers[MESSAGE_CONTROL] = (_encoder, decoder) => {
        try {
          const raw = decoding.readVarString(decoder);
          const control = JSON.parse(raw) as { type?: string };
          if (control.type === 'doc_reset') {
            const jwt = useAuthStore.getState().accessToken;
            if (jwt) remount(jwt);
            return;
          }
          if (control.type === 'tombstone') {
            ws.destroy();
            if (!cancelled) {
              setProvider(null);
              setSynced(false);
              setError('not_found');
            }
          }
        } catch {
          // Unknown type-4 payload — ignore, same as stock y-websocket.
        }
      };
    };

    const connect = (jwt: string) => {
      if (cancelled || !jwt) return;
      const ws = new WebsocketProvider(collabWsUrl(), String(pageId), doc, {
        protocols: [COLLAB_WS_PROTOCOL, jwt],
        disableBc: true,
        resyncInterval: 30_000,
        awareness,
      });
      current = ws;
      attachControlHandler(ws);
      if (!cancelled) setProvider(ws);

      ws.on('sync', (isSynced: boolean) => {
        if (!cancelled) setSynced(isSynced);
      });
      ws.on('closed', (event: { code: number; reason: string }) => {
        if (cancelled) return;
        if (event.code === 4401) {
          void refreshAccessTokenOnce().then((fresh) => {
            if (cancelled || current !== ws) return;
            if (!fresh) {
              ws.destroy();
              current = null;
              setError('unauthorized');
              setProvider(null);
              setSynced(false);
              return;
            }
            ws.protocols = [COLLAB_WS_PROTOCOL, fresh];
            ws.connect();
          });
          return;
        }
        const joinError = closeCodeError(event.code);
        if (joinError === 'forbidden' || joinError === 'not_found') {
          ws.destroy();
          if (current === ws) current = null;
          setProvider(null);
          setSynced(false);
          setError(joinError);
        }
      });
      ws.on('connection-close', (event: CloseEvent | null) => {
        if (cancelled || !event) return;
        if (event.code === 1001 && event.reason === 'doc_reset') {
          if (current === ws) {
            const jwt = useAuthStore.getState().accessToken;
            if (jwt) {
              remount(jwt);
              return;
            }
            ws.destroy();
            current = null;
            setProvider(null);
            setSynced(false);
          }
        }
      });
    };

    connect(token);

    return () => {
      cancelled = true;
      awareness.off('update', refreshAwareness);
      current?.destroy();
      doc.destroy();
      setYdoc(null);
      setProvider(null);
      setSynced(false);
      setAwarenessUsers([]);
    };
  }, [enabled, pageId]);

  return { ydoc, provider, synced, awarenessUsers, error };
}
