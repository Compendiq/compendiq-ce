import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { COLLAB_WS_PROTOCOL } from '@compendiq/contracts';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import { useAuthStore } from '../../stores/auth-store';
import { useCollabProvider } from './use-collab-provider';

// Only the network boundary is replaced. The provider, protocol decoder,
// awareness and Y.Doc are real, including reconnection and outgoing updates.
class Socket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: Socket[] = [];
  readyState = Socket.CONNECTING;
  binaryType = 'arraybuffer';
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  sent: Uint8Array[] = [];

  constructor(readonly url: string, readonly protocols: string[]) {
    Socket.instances.push(this);
  }

  open() {
    this.readyState = Socket.OPEN;
    this.onopen?.(new Event('open'));
  }

  send(data: Uint8Array) {
    if (this.readyState !== Socket.OPEN) throw new Error('Socket is not open');
    this.sent.push(data.slice());
  }

  receive(data: Uint8Array) {
    if (this.readyState === Socket.OPEN) {
      this.onmessage?.(new MessageEvent('message', { data: data.slice().buffer }));
    }
  }

  close(code = 1000, reason = '') {
    if (this.readyState === Socket.CLOSED) return;
    this.readyState = Socket.CLOSED;
    this.onclose?.(new CloseEvent('close', { code, reason }));
  }
}

function control(socket: Socket, value: unknown) {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, 4);
  encoding.writeVarString(encoder, JSON.stringify(value));
  socket.receive(encoding.toUint8Array(encoder));
}

function hydrate(socket: Socket, text = 'Published text') {
  const server = new Y.Doc();
  server.getText('draft').insert(0, text);
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, 0);
  syncProtocol.writeSyncStep2(encoder, server);
  socket.receive(encoding.toUint8Array(encoder));
  server.destroy();
}

function lifecycle(revision: string, frozen = false) {
  return {
    type: 'page_lifecycle', pageId: 42, lifecycleRevision: revision,
    isFrozen: frozen, baselineId: frozen ? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' : null,
  };
}

const user = { id: 'self', username: 'me', role: 'user' as const };

describe('useCollabProvider — real Yjs and WebSocket protocol', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', Socket);
    Socket.instances = [];
    useAuthStore.getState().setAuth('jwt-old', user);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    useAuthStore.getState().clearAuth();
  });

  it('opens no connection without authentication or when editing is disabled', () => {
    useAuthStore.getState().clearAuth();
    const first = renderHook(() => useCollabProvider({ pageId: '42', enabled: true }));
    expect(Socket.instances).toEqual([]);
    first.unmount();
    useAuthStore.getState().setAuth('jwt-old', user);
    renderHook(() => useCollabProvider({ pageId: '42', enabled: false }));
    expect(Socket.instances).toEqual([]);
  });

  it('synchronizes read-only until a matching positive admission arrives', () => {
    const { result } = renderHook(() => useCollabProvider({
      pageId: '42', enabled: true, expectedLifecycleRevision: '7',
    }));
    const socket = Socket.instances[0]!;
    expect(new URL(socket.url).searchParams.get('expectedLifecycleRevision')).toBe('7');
    expect(socket.protocols).toEqual([COLLAB_WS_PROTOCOL, 'jwt-old']);
    act(() => {
      socket.open();
      control(socket, lifecycle('7'));
      hydrate(socket);
    });
    expect(result.current.connected).toBe(true);
    expect(result.current.synced).toBe(true);
    expect(result.current.ydoc!.getText('draft').toString()).toBe('Published text');
    expect(result.current.writable).toBe(false);
    act(() => { control(socket, { type: 'writable_admission', lifecycleRevision: '6' }); });
    expect(result.current.writable).toBe(false);
    act(() => { control(socket, { type: 'writable_admission', lifecycleRevision: '7' }); });
    expect(result.current.writable).toBe(true);

    act(() => {
      control(socket, lifecycle('6', true));
      control(socket, { ...lifecycle('8', true), pageId: 99 });
      control(socket, lifecycle('7'));
      control(socket, lifecycle('7'));
    });
    expect(result.current.writable).toBe(true);
    expect(socket.readyState).toBe(Socket.OPEN);
  });

  it('retains a dirty document on freeze and requires an explicit fresh join after thaw', async () => {
    const { result, rerender } = renderHook(
      ({ enabled, revision }) => useCollabProvider({
        pageId: '42', enabled, expectedLifecycleRevision: revision,
      }),
      { initialProps: { enabled: true, revision: '1' } },
    );
    const socket = Socket.instances[0]!;
    act(() => {
      socket.open();
      hydrate(socket);
      control(socket, { type: 'writable_admission', lifecycleRevision: '1' });
    });
    const draft = result.current.ydoc!;
    act(() => { draft.getText('draft').insert(14, ' + unsaved changes'); });
    act(() => { control(socket, lifecycle('2', true)); });
    expect(result.current.ydoc).toBe(draft);
    expect(draft.getText('draft').toString()).toBe('Published text + unsaved changes');
    expect(result.current.readOnlyReason).toBe('frozen');
    expect(result.current.writable).toBe(false);
    expect(result.current.synced).toBe(true);
    expect(socket.readyState).toBe(Socket.CLOSED);

    rerender({ enabled: true, revision: '3' });
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(Socket.instances).toHaveLength(1);
    expect(result.current.ydoc).toBe(draft);
    expect(result.current.writable).toBe(false);

    rerender({ enabled: false, revision: '3' });
    rerender({ enabled: true, revision: '3' });
    const fresh = Socket.instances[1]!;
    act(() => {
      fresh.open();
      hydrate(fresh, 'Current published version');
      control(fresh, { type: 'writable_admission', lifecycleRevision: '3' });
    });
    expect(new URL(fresh.url).searchParams.get('expectedLifecycleRevision')).toBe('3');
    expect(result.current.ydoc).not.toBe(draft);
    expect(result.current.ydoc!.getText('draft').toString()).toBe('Current published version');
    expect(result.current.writable).toBe(true);
  });

  it('reconnects an offline draft with its original revision, then preserves it on stale refusal', async () => {
    const { result, rerender } = renderHook(
      ({ revision }) => useCollabProvider({ pageId: '42', enabled: true, expectedLifecycleRevision: revision }),
      { initialProps: { revision: '1' } },
    );
    const socket = Socket.instances[0]!;
    act(() => {
      socket.open();
      hydrate(socket);
      control(socket, { type: 'writable_admission', lifecycleRevision: '1' });
      socket.close(1006, 'offline');
    });
    const draft = result.current.ydoc!;
    act(() => { draft.getText('draft').insert(14, ' + offline work'); });
    rerender({ revision: '3' });
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    const reconnect = Socket.instances[1]!;
    expect(new URL(reconnect.url).searchParams.get('expectedLifecycleRevision')).toBe('1');
    act(() => {
      reconnect.open();
      control(reconnect, {
        type: 'writable_refused', reason: 'lifecycle_revision_stale',
        expectedLifecycleRevision: '1', currentLifecycleRevision: '3',
      });
    });
    expect(result.current.ydoc).toBe(draft);
    expect(draft.getText('draft').toString()).toBe('Published text + offline work');
    expect(result.current.readOnlyReason).toBe('lifecycle_changed');
    expect(result.current.writable).toBe(false);
    expect(reconnect.readyState).toBe(Socket.CLOSED);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(Socket.instances).toHaveLength(2);
  });

  it('preserves the mounted document when permission is revoked', () => {
    const { result } = renderHook(() => useCollabProvider({
      pageId: '42', enabled: true, expectedLifecycleRevision: '1',
    }));
    const socket = Socket.instances[0]!;
    act(() => {
      socket.open();
      hydrate(socket, 'My recoverable draft');
      control(socket, { type: 'writable_admission', lifecycleRevision: '1' });
    });
    const draft = result.current.ydoc;
    act(() => { control(socket, { type: 'permission_loss', reason: 'edit_permission_revoked' }); });
    expect(result.current.ydoc).toBe(draft);
    expect(draft!.getText('draft').toString()).toBe('My recoverable draft');
    expect(result.current.readOnlyReason).toBe('permission_loss');
    expect(result.current.writable).toBe(false);
    expect(socket.readyState).toBe(Socket.CLOSED);
  });

  it('keeps work available after a document reset rather than replacing the Y.Doc automatically', () => {
    const { result } = renderHook(() => useCollabProvider({
      pageId: '42', enabled: true, expectedLifecycleRevision: '1',
    }));
    const socket = Socket.instances[0]!;
    act(() => { socket.open(); hydrate(socket, 'Work before reset'); });
    const draft = result.current.ydoc;
    act(() => { control(socket, { type: 'doc_reset' }); });
    expect(result.current.ydoc).toBe(draft);
    expect(draft!.getText('draft').toString()).toBe('Work before reset');
    expect(result.current.readOnlyReason).toBe('document_changed');
    expect(Socket.instances).toHaveLength(1);
  });

  it('refreshes an expired token over HTTP without replacing the document or its admission revision', async () => {
    const refresh = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      accessToken: 'jwt-fresh', user,
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const { result } = renderHook(() => useCollabProvider({
      pageId: '42', enabled: true, expectedLifecycleRevision: '5',
    }));
    const socket = Socket.instances[0]!;
    act(() => { socket.open(); hydrate(socket, 'Draft during refresh'); });
    const draft = result.current.ydoc;
    await act(async () => { socket.close(4401, 'unauthorized'); });
    const reconnect = Socket.instances[1]!;
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(String(refresh.mock.calls[0]![0])).toContain('/auth/refresh');
    expect(reconnect.protocols).toEqual([COLLAB_WS_PROTOCOL, 'jwt-fresh']);
    expect(new URL(reconnect.url).searchParams.get('expectedLifecycleRevision')).toBe('5');
    expect(result.current.ydoc).toBe(draft);
    expect(draft!.getText('draft').toString()).toBe('Draft during refresh');
    expect(result.current.writable).toBe(false);
  });
});
