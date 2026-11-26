import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { COLLAB_UPGRADE_WINDOW_SEC, COLLAB_WS_PROTOCOL } from '@compendiq/contracts';
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

const user = { id: '00000000-0000-4000-8000-000000000001', username: 'me', role: 'user' as const };

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

  it('parks an indeterminate refresh without losing the draft and resumes with a replacement token', async () => {
    const held = Promise.withResolvers<Response>();
    const refresh = vi.spyOn(globalThis, 'fetch')
      .mockReturnValueOnce(held.promise)
      .mockResolvedValue(new Response(null, { status: 401 }));
    const { result } = renderHook(() => useCollabProvider({
      pageId: '42', enabled: true, expectedLifecycleRevision: '5',
    }));
    const socket = Socket.instances[0]!;
    act(() => { socket.open(); hydrate(socket, 'Unsaved draft'); });
    const draft = result.current.ydoc;
    const before = useAuthStore.getState();
    await act(async () => {
      socket.close(4401, 'unauthorized');
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(Socket.instances).toHaveLength(1);
    await act(async () => {
      held.resolve(new Response('{', { status: 200 }));
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(Socket.instances).toHaveLength(1);
    expect(useAuthStore.getState()).toBe(before);
    expect(result.current.ydoc).toBe(draft);
    expect(draft!.getText('draft').toString()).toBe('Unsaved draft');
    expect(result.current.error).toBeNull();
    expect(result.current.writable).toBe(false);

    act(() => { useAuthStore.getState().setAuth('jwt-recovered', user); });
    expect(Socket.instances).toHaveLength(2);
    const recovered = Socket.instances[1]!;
    expect(recovered.protocols).toEqual([COLLAB_WS_PROTOCOL, 'jwt-recovered']);
    expect(new URL(recovered.url).searchParams.get('expectedLifecycleRevision')).toBe('5');
    expect(result.current.ydoc).toBe(draft);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('keeps the session and rejoins with growing pauses while the token refresh stays busy', async () => {
    const busy = () => new Response(JSON.stringify({ statusCode: 503, message: 'busy', code: 'refresh_busy' }), {
      status: 503, headers: { 'content-type': 'application/json' },
    });
    let refreshes = 0;
    const refresh = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      refreshes += 1;
      // Three full refresh rounds (3 attempts each) stay busy, then it succeeds.
      if (refreshes <= 9) return busy();
      return new Response(JSON.stringify({ accessToken: 'jwt-fresh', user }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    });
    const { result } = renderHook(() => useCollabProvider({
      pageId: '42', enabled: true, expectedLifecycleRevision: '5',
    }));
    const socket = Socket.instances[0]!;
    act(() => { socket.open(); hydrate(socket, 'Draft during outage'); });
    const draft = result.current.ydoc;

    // Round 1: attempts at 0s, 1s, 4s give up; the rejoin waits 1s more.
    await act(async () => { socket.close(4401, 'unauthorized'); });
    await act(async () => { await vi.advanceTimersByTimeAsync(4_999); });
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(Socket.instances).toHaveLength(1);
    expect(result.current.error).toBeNull();
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    const rejoin = Socket.instances[1]!;
    // The rejoin still carries the stale token; its 4401 retries the refresh.
    expect(rejoin.protocols).toEqual([COLLAB_WS_PROTOCOL, 'jwt-old']);

    // Round 2 gives up after 4s again; this time the rejoin waits 2s.
    await act(async () => { rejoin.close(4401, 'unauthorized'); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5_999); });
    expect(refresh).toHaveBeenCalledTimes(6);
    expect(Socket.instances).toHaveLength(2);
    // Meanwhile another tab refreshed and its token reached this tab.
    act(() => { useAuthStore.getState().setAuth('jwt-other-tab', user); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    const secondRejoin = Socket.instances[2]!;
    expect(secondRejoin.protocols).toEqual([COLLAB_WS_PROTOCOL, 'jwt-other-tab']);

    // That rejoin connects, which ends the outage: a later busy round starts
    // the backoff over at 1s instead of the escalated 4s.
    act(() => { secondRejoin.open(); });
    expect(result.current.connected).toBe(true);
    await act(async () => { secondRejoin.close(4401, 'unauthorized'); });
    await act(async () => { await vi.advanceTimersByTimeAsync(4_999); });
    expect(refresh).toHaveBeenCalledTimes(9);
    expect(Socket.instances).toHaveLength(3);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(Socket.instances).toHaveLength(4);
    const thirdRejoin = Socket.instances[3]!;

    await act(async () => { thirdRejoin.close(4401, 'unauthorized'); });
    const reconnect = Socket.instances[4]!;
    expect(refresh).toHaveBeenCalledTimes(10);
    expect(reconnect.protocols).toEqual([COLLAB_WS_PROTOCOL, 'jwt-fresh']);
    expect(result.current.ydoc).toBe(draft);
    expect(result.current.error).toBeNull();
  });

  it.each([
    { code: 4403, reason: 'rate_limited', error: 'rate_limited', readOnlyReason: null },
    { code: 4403, reason: 'flag_off', error: 'flag_off', readOnlyReason: null },
    { code: 4403, reason: 'readonly', error: 'join_interrupted', readOnlyReason: null },
    { code: 4403, reason: 'forbidden', error: 'forbidden', readOnlyReason: 'permission_loss' },
    { code: 4403, reason: '', error: 'forbidden', readOnlyReason: 'permission_loss' },
    { code: 4403, reason: 'denied', error: 'forbidden', readOnlyReason: 'permission_loss' },
    { code: 4404, reason: 'not_found', error: 'not_found', readOnlyReason: 'not_found' },
  ])('maps close $code "$reason" before the first sync to $error (#1895)', async ({ code, reason, error, readOnlyReason }) => {
    const { result } = renderHook(() => useCollabProvider({
      pageId: '42', enabled: true, expectedLifecycleRevision: '1',
    }));
    const socket = Socket.instances[0]!;
    act(() => { socket.open(); socket.close(code, reason); });
    expect(result.current.error).toBe(error);
    expect(result.current.readOnlyReason).toBe(readOnlyReason);
    expect(result.current.writable).toBe(false);
    expect(result.current.connected).toBe(false);
    // A terminal refusal never reconnects on its own, not even after the window.
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(Socket.instances).toHaveLength(1);
  });

  it('lets a rate-limited join retry only after the server upgrade window (#1895)', async () => {
    const { result } = renderHook(() => useCollabProvider({
      pageId: '42', enabled: true, expectedLifecycleRevision: '5',
    }));
    const socket = Socket.instances[0]!;
    act(() => { socket.open(); socket.close(4403, 'rate_limited'); });
    expect(result.current.error).toBe('rate_limited');
    expect(result.current.canRetry).toBe(false);
    act(() => { result.current.retry(); });
    expect(Socket.instances).toHaveLength(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(COLLAB_UPGRADE_WINDOW_SEC * 1000 - 1); });
    expect(result.current.canRetry).toBe(false);
    act(() => { result.current.retry(); });
    expect(Socket.instances).toHaveLength(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(result.current.canRetry).toBe(true);
    act(() => { useAuthStore.getState().setAuth('jwt-new', user); });
    expect(Socket.instances).toHaveLength(1);
    act(() => { result.current.retry(); });
    expect(Socket.instances).toHaveLength(2);
    const rejoin = Socket.instances[1]!;
    expect(rejoin.protocols).toEqual([COLLAB_WS_PROTOCOL, 'jwt-new']);
    expect(new URL(rejoin.url).searchParams.get('expectedLifecycleRevision')).toBe('5');
    expect(result.current.error).toBeNull();
    expect(result.current.canRetry).toBe(false);
  });

  it('retries an interrupted join at once, and never for another account (#1895)', () => {
    const { result } = renderHook(() => useCollabProvider({
      pageId: '42', enabled: true, expectedLifecycleRevision: '1',
    }));
    const socket = Socket.instances[0]!;
    act(() => { socket.open(); socket.close(4403, 'readonly'); });
    expect(result.current.error).toBe('join_interrupted');
    expect(result.current.canRetry).toBe(true);

    const other = { ...user, id: '00000000-0000-4000-8000-000000000002', username: 'other' };
    act(() => { useAuthStore.getState().setAuth('jwt-other', other); });
    act(() => { result.current.retry(); });
    expect(Socket.instances).toHaveLength(1);

    act(() => { useAuthStore.getState().setAuth('jwt-old', user); });
    act(() => { result.current.retry(); });
    expect(Socket.instances).toHaveLength(2);
    const rejoin = Socket.instances[1]!;
    act(() => { rejoin.open(); hydrate(rejoin, 'Joined after retry'); });
    expect(result.current.synced).toBe(true);
    expect(result.current.error).toBeNull();
    expect(result.current.ydoc!.getText('draft').toString()).toBe('Joined after retry');
  });

  it.each([
    ['readonly', 'readonly'],
    ['rate_limited', 'rate_limited'],
    ['flag_off', 'flag_off'],
    ['forbidden', 'permission_loss'],
    ['an unknown reason', 'permission_loss'],
    ['an empty reason', 'permission_loss'],
  ])(
    'keeps a 4403 "%s" after the first sync on the read-only draft path (#1895)',
    (name, expected) => {
      const reason = name === 'an unknown reason' ? 'something_new' : name === 'an empty reason' ? '' : name;
      const { result } = renderHook(() => useCollabProvider({
        pageId: '42', enabled: true, expectedLifecycleRevision: '1',
      }));
      const socket = Socket.instances[0]!;
      act(() => {
        socket.open();
        hydrate(socket, 'Synced draft');
        control(socket, { type: 'writable_admission', lifecycleRevision: '1' });
      });
      const draft = result.current.ydoc!;
      act(() => { draft.getText('draft').insert(12, ' with edits'); });
      act(() => { socket.close(4403, reason); });
      expect(result.current.error).toBe('forbidden');
      expect(result.current.readOnlyReason).toBe(expected);
      expect(result.current.ydoc).toBe(draft);
      expect(draft.getText('draft').toString()).toBe('Synced draft with edits');
      expect(result.current.canRetry).not.toBe(true);
    },
  );

  it.each([
    [1006, 'offline'],
    [1013, 'join_backlog'],
    [1001, 'internal'],
  ])('reports a transient close %i before the first sync as reconnecting until it syncs (#1895)', async (code, reason) => {
    const { result } = renderHook(() => useCollabProvider({
      pageId: '42', enabled: true, expectedLifecycleRevision: '1',
    }));
    const socket = Socket.instances[0]!;
    act(() => { socket.open(); socket.close(code, reason); });
    expect(result.current.reconnecting).toBe(true);
    expect(result.current.error).toBeNull();
    expect(result.current.readOnlyReason).toBeNull();

    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    const reconnect = Socket.instances[1]!;
    act(() => { reconnect.open(); hydrate(reconnect); });
    expect(result.current.synced).toBe(true);
    expect(result.current.reconnecting).toBe(false);

    // After the first sync a transient close is the offline path, not a join problem.
    act(() => { reconnect.close(1006, 'offline'); });
    expect(result.current.reconnecting).toBe(false);
  });

  it('reports unauthorized instead of hanging when enabled without an access token', () => {
    useAuthStore.setState({ accessToken: null, isAuthenticated: false, user: null });

    const { result } = renderHook(() => useCollabProvider({
      pageId: '42',
      enabled: true,
      expectedLifecycleRevision: 'rev-1',
    }));

    expect(result.current.error).toBe('unauthorized');
    expect(result.current.provider).toBeNull();
    expect(Socket.instances).toHaveLength(0);
  });

  describe('document epoch (#2034)', () => {
    const EPOCH = '7b0f4c1e-52a8-4d3f-9c6b-1a2b3c4d5e6f';
    const OTHER_EPOCH = '0d9c1b2a-3e4f-4a5b-8c6d-7e8f9a0b1c2d';

    const declared = (socket: Socket) => new URL(socket.url).searchParams.get('expectedDocEpoch');
    const mount = () => renderHook(() => useCollabProvider({
      pageId: '42', enabled: true, expectedLifecycleRevision: '1',
    }));
    /** Drop the connection and let y-websocket open the next one. */
    const reconnect = async (socket: Socket): Promise<Socket> => {
      const opened = Socket.instances.length;
      act(() => { socket.close(1006, 'offline'); });
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
      expect(Socket.instances).toHaveLength(opened + 1);
      return Socket.instances[opened]!;
    };

    it('pins the control\'s epoch at the first sync and declares it on every later join, never on the first', async () => {
      const { result } = mount();
      const first = Socket.instances[0]!;
      expect(declared(first)).toBeNull();
      expect(result.current.docEpochPinned).toBe(false);
      act(() => {
        first.open();
        control(first, { type: 'doc_epoch', epoch: EPOCH });
        control(first, lifecycle('1'));
      });
      // Remembered, not pinned: the document has not synced yet.
      expect(result.current.docEpochPinned).toBe(false);
      act(() => {
        hydrate(first);
        control(first, { type: 'writable_admission', lifecycleRevision: '1' });
      });
      expect(result.current.docEpochPinned).toBe(true);
      expect(result.current.writable).toBe(true);

      const second = await reconnect(first);
      expect(declared(second)).toBe(EPOCH);
      expect(new URL(second.url).searchParams.get('expectedLifecycleRevision')).toBe('1');
      act(() => { second.open(); hydrate(second); });
      const third = await reconnect(second);
      expect(declared(third)).toBe(EPOCH);
      expect(result.current.docEpochPinned).toBe(true);
    });

    it('never changes the pin: a later doc_epoch control is ignored', async () => {
      const { result } = mount();
      const first = Socket.instances[0]!;
      act(() => {
        first.open();
        control(first, { type: 'doc_epoch', epoch: EPOCH });
        hydrate(first);
        // Also on the connection that pinned it.
        control(first, { type: 'doc_epoch', epoch: OTHER_EPOCH });
      });
      const second = await reconnect(first);
      expect(declared(second)).toBe(EPOCH);
      act(() => {
        second.open();
        control(second, { type: 'doc_epoch', epoch: OTHER_EPOCH });
        hydrate(second);
      });
      const third = await reconnect(second);
      expect(declared(third)).toBe(EPOCH);
      expect(result.current.docEpochPinned).toBe(true);
    });

    it('stays unpinned for its lifetime when the first sync came without the control', async () => {
      const { result } = mount();
      const first = Socket.instances[0]!;
      act(() => { first.open(); control(first, lifecycle('1')); hydrate(first); });
      expect(result.current.synced).toBe(true);
      expect(result.current.docEpochPinned).toBe(false);

      const second = await reconnect(first);
      expect(declared(second)).toBeNull();
      // A later connection names an epoch: the document already holds content of an unknown lineage.
      act(() => {
        second.open();
        control(second, { type: 'doc_epoch', epoch: EPOCH });
        hydrate(second);
      });
      const third = await reconnect(second);
      expect(declared(third)).toBeNull();
      expect(result.current.docEpochPinned).toBe(false);
    });

    it('forgets a remembered epoch when its connection closes before the first sync', async () => {
      const { result } = mount();
      const first = Socket.instances[0]!;
      act(() => { first.open(); control(first, { type: 'doc_epoch', epoch: OTHER_EPOCH }); });
      const second = await reconnect(first);
      // Nothing was synced, so nothing is declared and nothing of that connection is kept.
      expect(declared(second)).toBeNull();
      act(() => { second.open(); hydrate(second); });
      expect(result.current.docEpochPinned).toBe(false);
      const third = await reconnect(second);
      expect(declared(third)).toBeNull();
    });

    it('pins the epoch of the connection that delivers the first sync, not an earlier connection\'s', async () => {
      const { result } = mount();
      const first = Socket.instances[0]!;
      act(() => { first.open(); control(first, { type: 'doc_epoch', epoch: OTHER_EPOCH }); });
      const second = await reconnect(first);
      act(() => {
        second.open();
        control(second, { type: 'doc_epoch', epoch: EPOCH });
        hydrate(second);
      });
      expect(result.current.docEpochPinned).toBe(true);
      expect(declared(await reconnect(second))).toBe(EPOCH);
    });

    it('works as before against a server that never sends the control', async () => {
      const { result } = mount();
      const first = Socket.instances[0]!;
      act(() => {
        first.open();
        control(first, lifecycle('1'));
        hydrate(first, 'Old server text');
        control(first, { type: 'writable_admission', lifecycleRevision: '1' });
      });
      expect(result.current).toMatchObject({
        synced: true, connected: true, writable: true, error: null, readOnlyReason: null, docEpochPinned: false,
      });
      const second = await reconnect(first);
      expect(declared(second)).toBeNull();
      act(() => {
        second.open();
        hydrate(second, 'Old server text');
        control(second, { type: 'writable_admission', lifecycleRevision: '1' });
      });
      expect(result.current).toMatchObject({ writable: true, readOnlyReason: null, docEpochPinned: false });
      expect(result.current.ydoc!.getText('draft').toString()).toContain('Old server text');
    });

    it.each([
      ['not a UUID', { type: 'doc_epoch', epoch: 'not-a-uuid' }],
      ['no epoch', { type: 'doc_epoch' }],
      ['an extra field', { type: 'doc_epoch', epoch: EPOCH, writable: true }],
    ])('does not pin a doc_epoch control with %s', async (_name, frame) => {
      const { result } = mount();
      const first = Socket.instances[0]!;
      act(() => { first.open(); control(first, frame); hydrate(first); });
      expect(result.current.docEpochPinned).toBe(false);
      expect(result.current.writable).toBe(false);
      expect(declared(await reconnect(first))).toBeNull();
    });

    it.each([
      ['the control and the close', true],
      ['the close alone', false],
    ])('keeps the draft as document_changed and never reconnects when a declared rejoin gets doc_reset (%s)', async (_name, withControl) => {
      const { result } = mount();
      const first = Socket.instances[0]!;
      act(() => {
        first.open();
        control(first, { type: 'doc_epoch', epoch: EPOCH });
        hydrate(first, 'Draft the tab still holds');
        control(first, { type: 'writable_admission', lifecycleRevision: '1' });
      });
      const draft = result.current.ydoc!;
      const second = await reconnect(first);
      expect(declared(second)).toBe(EPOCH);
      act(() => {
        second.open();
        if (withControl) control(second, { type: 'doc_reset' });
        second.close(1001, 'doc_reset');
      });
      expect(result.current.readOnlyReason).toBe('document_changed');
      expect(result.current.writable).toBe(false);
      expect(result.current.connected).toBe(false);
      expect(result.current.ydoc).toBe(draft);
      expect(draft.getText('draft').toString()).toBe('Draft the tab still holds');
      // The synced document keeps its draft state; this is not a pre-sync join error.
      expect(result.current.synced).toBe(true);
      expect(result.current.error).toBeNull();
      await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
      expect(Socket.instances).toHaveLength(2);
    });

    describe('empty-document marker', () => {
      const marker = (socket: Socket) => new URL(socket.url).searchParams.get('expectedDocEmpty');
      /** A Yjs update frame, as a peer's edit reaches a socket outside the sync handshake. */
      const update = (socket: Socket, bytes: Uint8Array) => {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, 0);
        syncProtocol.writeUpdate(encoder, bytes);
        socket.receive(encoding.toUint8Array(encoder));
      };
      /** The updates of two successive edits; the second cannot be integrated without the first. */
      const twoEdits = (): [Uint8Array, Uint8Array] => {
        const server = new Y.Doc();
        const updates: Uint8Array[] = [];
        server.on('update', (bytes: Uint8Array) => updates.push(bytes));
        server.getText('draft').insert(0, 'first');
        server.getText('draft').insert(5, ' second');
        server.destroy();
        return [updates[0]!, updates[1]!];
      };
      /** The server's SyncStep2 for a document that holds nothing. */
      const hydrateEmpty = (socket: Socket) => {
        const server = new Y.Doc();
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, 0);
        syncProtocol.writeSyncStep2(encoder, server);
        socket.receive(encoding.toUint8Array(encoder));
        server.destroy();
      };

      it('is decided for each connect: sent while the unpinned document is empty, dropped once it holds content, replaced by the epoch once pinned', async () => {
        const { result } = mount();
        const first = Socket.instances[0]!;
        expect(marker(first)).toBe('1');
        expect(declared(first)).toBeNull();
        expect(new URL(first.url).searchParams.get('expectedLifecycleRevision')).toBe('1');

        // The connection drops before it delivered anything: still empty.
        act(() => { first.open(); control(first, { type: 'doc_epoch', epoch: OTHER_EPOCH }); });
        const second = await reconnect(first);
        expect(marker(second)).toBe('1');
        expect(declared(second)).toBeNull();

        // A peer's edit arrives before the first sync, then the connection drops.
        act(() => { second.open(); update(second, twoEdits()[0]); });
        expect(result.current.synced).toBe(false);
        expect(result.current.ydoc!.getText('draft').toString()).toBe('first');
        const third = await reconnect(second);
        expect(marker(third)).toBeNull();
        expect(declared(third)).toBeNull();

        // The first sync pins: from here the epoch is declared and never the marker.
        act(() => {
          third.open();
          control(third, { type: 'doc_epoch', epoch: EPOCH });
          hydrate(third);
        });
        expect(result.current.docEpochPinned).toBe(true);
        const fourth = await reconnect(third);
        expect(declared(fourth)).toBe(EPOCH);
        expect(marker(fourth)).toBeNull();
      });

      it('is never sent for a pinned document, even one that is still empty', async () => {
        const { result } = mount();
        const first = Socket.instances[0]!;
        expect(marker(first)).toBe('1');
        act(() => {
          first.open();
          control(first, { type: 'doc_epoch', epoch: EPOCH });
          hydrateEmpty(first);
        });
        expect(result.current.synced).toBe(true);
        expect(result.current.docEpochPinned).toBe(true);
        expect(Y.encodeStateAsUpdate(result.current.ydoc!)).toEqual(Y.encodeStateAsUpdate(new Y.Doc()));

        const second = await reconnect(first);
        expect(declared(second)).toBe(EPOCH);
        expect(marker(second)).toBeNull();
      });

      it('is sent again by an unpinned document that synced and still holds nothing', async () => {
        const { result } = mount();
        const first = Socket.instances[0]!;
        act(() => { first.open(); hydrateEmpty(first); });
        expect(result.current.synced).toBe(true);
        expect(result.current.docEpochPinned).toBe(false);

        const second = await reconnect(first);
        expect(marker(second)).toBe('1');
        expect(declared(second)).toBeNull();
      });

      it('is not sent for an unpinned document that holds content: such a join declares nothing', async () => {
        const { result } = mount();
        const first = Socket.instances[0]!;
        expect(marker(first)).toBe('1');
        // A first sync without the control (an older pod, a provisional room) never pins.
        act(() => { first.open(); control(first, lifecycle('1')); hydrate(first); });
        expect(result.current.docEpochPinned).toBe(false);

        const second = await reconnect(first);
        expect(marker(second)).toBeNull();
        expect(declared(second)).toBeNull();
        expect(new URL(second.url).searchParams.get('expectedLifecycleRevision')).toBe('1');
      });

      it('is not sent while the document holds an update parked for a missing dependency', async () => {
        const { result } = mount();
        const first = Socket.instances[0]!;
        expect(marker(first)).toBe('1');
        // Only the second edit arrives: nothing is integrated, but Yjs keeps
        // the update and would send it along with the document's state.
        act(() => { first.open(); update(first, twoEdits()[1]); });
        const doc = result.current.ydoc!;
        expect(doc.getText('draft').toString()).toBe('');
        expect(Y.decodeStateVector(Y.encodeStateVector(doc)).size).toBe(0);

        const second = await reconnect(first);
        expect(marker(second)).toBeNull();
        expect(declared(second)).toBeNull();
      });

      it('is not sent while the document holds only a parked deletion it cannot apply yet', async () => {
        // An edit and its deletion: the second update is a delete set without a struct.
        const server = new Y.Doc();
        const updates: Uint8Array[] = [];
        server.on('update', (bytes: Uint8Array) => updates.push(bytes));
        server.getText('draft').insert(0, 'first');
        server.getText('draft').delete(0, 5);
        server.destroy();
        const deletion = updates[1]!;
        expect(Y.decodeUpdate(deletion).structs).toEqual([]);
        expect(Y.decodeUpdate(deletion).ds.clients.size).toBe(1);

        const { result } = mount();
        const first = Socket.instances[0]!;
        expect(marker(first)).toBe('1');
        // A retry that still holds nothing sends the marker again.
        act(() => { first.open(); });
        const second = await reconnect(first);
        expect(marker(second)).toBe('1');

        // The deletion arrives without the edit it deletes. No clock and no
        // deletion is integrated and no struct is parked, but Yjs keeps the
        // delete set and sends it along with the document's state.
        act(() => { second.open(); update(second, deletion); });
        const doc = result.current.ydoc!;
        expect(Y.equalSnapshots(Y.snapshot(doc), Y.emptySnapshot)).toBe(true);
        expect(doc.store.pendingStructs).toBeNull();
        expect(Y.decodeUpdate(Y.encodeStateAsUpdate(doc)).ds.clients.size).toBe(1);

        const third = await reconnect(second);
        expect(marker(third)).toBeNull();
        expect(declared(third)).toBeNull();
      });

      it('is the only parameter of a join without a lifecycle revision', () => {
        renderHook(() => useCollabProvider({ pageId: '42', enabled: true }));
        expect(new URL(Socket.instances[0]!.url).search).toBe('?expectedDocEmpty=1');
      });
    });
  });
});
