import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuthStore } from '../../stores/auth-store';

export interface PresenceViewer {
  userId: string;
  name: string;
  role: string;
  isEditing: boolean;
  avatarUrl?: string;
}

interface PresenceEvent {
  viewers: PresenceViewer[];
  pageId: string;
  ts: number;
}

const HEARTBEAT_MS = 10_000;
const BACKOFF_CAP_MS = 30_000;

function sortViewers(viewers: PresenceViewer[]): PresenceViewer[] {
  return [...viewers].sort((a, b) => {
    if (a.isEditing !== b.isEditing) return a.isEditing ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export function usePresence(pageId: string | null | undefined): {
  viewers: PresenceViewer[];
  selfIsEditing: boolean;
  setEditing: (v: boolean) => void;
} {
  const [viewers, setViewers] = useState<PresenceViewer[]>([]);
  const [selfIsEditing, setSelfIsEditingState] = useState(false);
  const selfIsEditingRef = useRef(false);
  const selfUserId = useAuthStore((s) => s.user?.id);

  const sendHeartbeat = useCallback(async (isEditing: boolean) => {
    if (!pageId) return;
    const { accessToken } = useAuthStore.getState();
    try {
      await fetch(`/api/pages/${encodeURIComponent(pageId)}/presence/heartbeat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
        body: JSON.stringify({ isEditing }),
      });
    } catch {
      // Heartbeat is best-effort; the server will evict us via ZRANGEBYSCORE.
    }
  }, [pageId]);

  const setEditing = useCallback((v: boolean) => {
    selfIsEditingRef.current = v;
    setSelfIsEditingState(v);
    void sendHeartbeat(v);
  }, [sendHeartbeat]);

  useEffect(() => {
    if (!pageId) return;

    const abort = new AbortController();
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let backoffMs = 1000;
    let cancelled = false;

    const applyEvent = (ev: PresenceEvent) => {
      const withoutSelf = selfUserId
        ? ev.viewers.filter((v) => v.userId !== selfUserId)
        : ev.viewers;
      setViewers(sortViewers(withoutSelf));
    };

    const connect = async () => {
      if (cancelled) return;
      try {
        const { accessToken } = useAuthStore.getState();
        const res = await fetch(`/api/pages/${encodeURIComponent(pageId)}/presence`, {
          method: 'GET',
          headers: {
            Accept: 'text/event-stream',
            ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
          },
          signal: abort.signal,
        });
        if (res.status === 401 || res.status === 403) {
          // Session is broken — retrying won't help. Park until unmount.
          cancelled = true;
          if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = null;
          }
          return;
        }
        if (!res.ok || !res.body) {
          throw new Error(`Presence stream failed: ${res.status}`);
        }

        // Connected — reset backoff and fire an immediate heartbeat.
        backoffMs = 1000;
        void sendHeartbeat(selfIsEditingRef.current);
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        heartbeatTimer = setInterval(() => {
          void sendHeartbeat(selfIsEditingRef.current);
        }, HEARTBEAT_MS);

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split('\n\n');
          buffer = frames.pop() ?? '';
          for (const frame of frames) {
            const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
            if (!dataLine) continue;
            try {
              applyEvent(JSON.parse(dataLine.slice(6)) as PresenceEvent);
            } catch {
              // Skip malformed frames.
            }
          }
        }
        throw new Error('stream closed');
      } catch (err) {
        if (cancelled || (err instanceof DOMException && err.name === 'AbortError')) return;
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
        const delay = backoffMs;
        backoffMs = Math.min(backoffMs * 2, BACKOFF_CAP_MS);
        reconnectTimer = setTimeout(() => { void connect(); }, delay);
      }
    };

    void connect();

    const handleBeforeUnload = () => {
      const { accessToken } = useAuthStore.getState();
      try {
        void fetch(`/api/pages/${encodeURIComponent(pageId)}/presence`, {
          method: 'DELETE',
          headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined,
          keepalive: true,
        });
      } catch {
        // Best-effort; the server's 20s ZRANGEBYSCORE filter will evict us anyway.
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      cancelled = true;
      abort.abort();
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      window.removeEventListener('beforeunload', handleBeforeUnload);
      handleBeforeUnload();
    };
  }, [pageId, selfUserId, sendHeartbeat]);

  return useMemo(
    () => ({ viewers, selfIsEditing, setEditing }),
    [viewers, selfIsEditing, setEditing],
  );
}
