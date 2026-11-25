import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { COLLAB_UPGRADE_WINDOW_SEC, COLLAB_WS_PROTOCOL } from '@compendiq/contracts';
import * as Y from 'yjs';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import { useAuthStore } from '../../stores/auth-store';
import { REJOIN_COVERAGE_TIMEOUT_MS } from './collab-rejoin-attempt';
import { REJOIN_REFRESH_WAIT_MS, useCollabProvider } from './use-collab-provider';

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
const OTHER_USER = { ...user, id: '00000000-0000-4000-8000-000000000002' };

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

  describe('unknown collaborative save (#2035)', () => {
    const mount = () => renderHook(() => useCollabProvider({
      pageId: '42', enabled: true, expectedLifecycleRevision: '1',
    }));
    const joinWritable = (socket: Socket) => {
      act(() => {
        socket.open();
        hydrate(socket, 'Draft typed before the save failed');
        control(socket, { type: 'writable_admission', lifecycleRevision: '1' });
      });
    };

    it.each<[string, (socket: Socket, draft: Y.Doc, declare: (document: Y.Doc) => void) => void]>([
      ['the commit_unknown control', (socket) => control(socket, { type: 'commit_unknown' })],
      ['the 1001 commit_unknown close of a client that missed the control', (socket) => socket.close(1001, 'commit_unknown')],
      ['the Save route\'s own answer, with no control and no close from the room', (_socket, draft, declare) => declare(draft)],
    ])('keeps the document as a commit_unknown read-only draft on %s and never reconnects', async (_name, arrive) => {
      const { result } = mount();
      const socket = Socket.instances[0]!;
      joinWritable(socket);
      expect(result.current.writable).toBe(true);
      const draft = result.current.ydoc!;
      act(() => { draft.getText('draft').insert(0, 'Unsaved: '); });

      act(() => { arrive(socket, draft, result.current.declareCommitUnknown); });

      expect(result.current.readOnlyReason).toBe('commit_unknown');
      expect(result.current.writable).toBe(false);
      expect(result.current.connected).toBe(false);
      expect(result.current.ydoc).toBe(draft);
      expect(draft.getText('draft').toString()).toBe('Unsaved: Draft typed before the save failed');
      // A synced document keeps its draft state; this is not a join error.
      expect(result.current.synced).toBe(true);
      expect(result.current.error).toBeNull();
      expect(socket.readyState).toBe(Socket.CLOSED);
      await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
      expect(Socket.instances).toHaveLength(1);
    });

    it('ignores a Save answer for a document that is no longer the mounted one', () => {
      const { result } = mount();
      const socket = Socket.instances[0]!;
      joinWritable(socket);
      const earlier = new Y.Doc();

      act(() => { result.current.declareCommitUnknown(earlier); });

      expect(result.current.readOnlyReason).toBeNull();
      expect(result.current.writable).toBe(true);
      expect(socket.readyState).toBe(Socket.OPEN);
      earlier.destroy();
    });

    it('ignores the permission_loss and the close that follow the control', async () => {
      const { result } = mount();
      const socket = Socket.instances[0]!;
      joinWritable(socket);
      const receive = socket.onmessage!;
      const close = socket.onclose!;

      // The server sends all three in a row; the provider has already disconnected after the first.
      act(() => {
        control(socket, { type: 'commit_unknown' });
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, 4);
        encoding.writeVarString(encoder, JSON.stringify({ type: 'permission_loss', reason: 'edit_permission_revoked' }));
        receive(new MessageEvent('message', { data: encoding.toUint8Array(encoder).slice().buffer }));
        close(new CloseEvent('close', { code: 1001, reason: 'commit_unknown' }));
      });

      expect(result.current.readOnlyReason).toBe('commit_unknown');
      await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
      expect(result.current.readOnlyReason).toBe('commit_unknown');
      expect(Socket.instances).toHaveLength(1);
    });

    it('reports a join gated before the first sync without a document', () => {
      const { result } = mount();
      const socket = Socket.instances[0]!;
      act(() => {
        socket.open();
        control(socket, lifecycle('1'));
        control(socket, { type: 'commit_unknown' });
        control(socket, { type: 'permission_loss', reason: 'edit_permission_revoked' });
      });

      expect(result.current.readOnlyReason).toBe('commit_unknown');
      expect(result.current.synced).toBe(false);
      expect(result.current.writable).toBe(false);
      expect(result.current.error).toBeNull();
      expect(Socket.instances).toHaveLength(1);
    });

    it('grants no edit authority for an unknown control or a commit_unknown that carries a payload', () => {
      const { result } = mount();
      const socket = Socket.instances[0]!;
      act(() => {
        socket.open();
        control(socket, lifecycle('1'));
        hydrate(socket);
        control(socket, { type: 'commit_resolved', lifecycleRevision: '1' });
        control(socket, { type: 'commit_unknown', writable: true, lifecycleRevision: '1' });
      });

      expect(result.current.writable).toBe(false);
      // Neither frame is the strict control: the session keeps waiting for a real admission.
      expect(result.current.readOnlyReason).toBeNull();
      expect(socket.readyState).toBe(Socket.OPEN);
      act(() => { control(socket, { type: 'writable_admission', lifecycleRevision: '1' }); });
      expect(result.current.writable).toBe(true);
    });
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
  });

  describe('rejoin after a post-sync rate_limited (#2036)', () => {
    const EPOCH = '7b0f4c1e-52a8-4d3f-9c6b-1a2b3c4d5e6f';
    const WINDOW_MS = COLLAB_UPGRADE_WINDOW_SEC * 1000;
    // messageSync, SyncStep1, a state vector of one byte: no client at all.
    const PROBE = [0, 0, 1, 0];

    /** A gateway that holds the document and answers sync frames in arrival order, as the room does. */
    class Gateway {
      readonly doc = new Y.Doc();
      private readonly handled = new WeakMap<Socket, number>();
      /** The replay is received but not applied (a room that lost it). */
      dropUpdates = false;
      /** Nothing is answered (a gateway whose SyncStep2 never arrives). */
      silent = false;

      constructor(text: string) {
        this.doc.getText('draft').insert(0, text);
      }

      text() {
        return this.doc.getText('draft').toString();
      }

      /** The join's first state, as `hydrate` does for a server that holds this document. */
      hydrate(socket: Socket) {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, 0);
        syncProtocol.writeSyncStep2(encoder, this.doc);
        socket.receive(encoding.toUint8Array(encoder));
      }

      /** The server's own SyncStep1, written right after `writable_admission` (#1928). */
      requestReplay(socket: Socket) {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, 0);
        syncProtocol.writeSyncStep1(encoder, this.doc);
        socket.receive(encoding.toUint8Array(encoder));
      }

      /** Handles each sync frame the client sent since the last call and answers it. */
      pump(socket: Socket) {
        let index = this.handled.get(socket) ?? 0;
        for (; index < socket.sent.length; index++) {
          const decoder = decoding.createDecoder(socket.sent[index]!);
          if (decoding.readVarUint(decoder) !== 0) continue;
          const reply = encoding.createEncoder();
          encoding.writeVarUint(reply, 0);
          if (decoding.peekVarUint(decoder) !== syncProtocol.messageYjsSyncStep1 && this.dropUpdates) continue;
          syncProtocol.readSyncMessage(decoder, reply, this.doc, 'client');
          if (encoding.length(reply) > 1 && !this.silent) socket.receive(encoding.toUint8Array(reply));
        }
        this.handled.set(socket, index);
      }
    }

    const probes = (socket: Socket) => socket.sent.filter(
      (frame) => frame.length === PROBE.length && PROBE.every((byte, i) => frame[i] === byte),
    ).length;
    const admission = (socket: Socket) => control(socket, { type: 'writable_admission', lifecycleRevision: '1' });
    const flush = () => act(async () => { await Promise.resolve(); });

    /** One provider and one document throughout: a pinned, writable session whose 4403 closes it. */
    function limited({ pin = true, reason = 'rate_limited', offline = true, lead = 0 }: {
      pin?: boolean; reason?: string; offline?: boolean; lead?: number;
    } = {}) {
      const gateway = new Gateway('Published text');
      const writables: boolean[] = [];
      const view = renderHook(({ pageId }) => {
        const state = useCollabProvider({ pageId, enabled: true, expectedLifecycleRevision: '1' });
        writables.push(state.writable);
        return state;
      }, { initialProps: { pageId: '42' } });
      const first = Socket.instances[0]!;
      act(() => {
        first.open();
        if (pin) control(first, { type: 'doc_epoch', epoch: EPOCH });
        gateway.hydrate(first);
        admission(first);
      });
      const draft = view.result.current.ydoc!;
      const provider = view.result.current.provider!;
      expect(view.result.current.writable).toBe(true);
      if (lead > 0) act(() => { vi.advanceTimersByTime(lead); });
      act(() => { first.close(4403, reason); });
      // Typed after the close: the editor stays editable while disconnected.
      if (offline) act(() => { draft.getText('draft').insert(14, ' + offline'); });
      writables.length = 0;
      return { ...view, gateway, draft, provider, writables };
    }
    type Limited = ReturnType<typeof limited>;

    /** Waits out the window and presses Rejoin; returns the attempt's socket. */
    async function rejoin(session: Limited, waitWindow = true): Promise<Socket> {
      if (waitWindow) await act(async () => { await vi.advanceTimersByTimeAsync(WINDOW_MS); });
      expect(session.result.current.canRetry).toBe(true);
      const opened = Socket.instances.length;
      act(() => { session.result.current.retry(); });
      expect(Socket.instances).toHaveLength(opened + 1);
      return Socket.instances[opened]!;
    }

    /** The server's side of the healthy join up to and including the probe answer. */
    async function join(socket: Socket, gateway: Gateway) {
      act(() => { socket.open(); gateway.pump(socket); admission(socket); gateway.requestReplay(socket); });
      await flush();
      act(() => { gateway.pump(socket); });
    }

    const expectSameDraft = (session: Limited, text = 'Published text + offline') => {
      expect(session.result.current.ydoc).toBe(session.draft);
      expect(session.result.current.provider).toBe(session.provider);
      expect(session.draft.getText('draft').toString()).toBe(text);
    };

    it('keeps the draft read-only, stops reconnecting and offers Rejoin only after one full upgrade window', async () => {
      const session = limited();
      const { result } = session;
      expect(result.current).toMatchObject({
        error: 'forbidden', readOnlyReason: 'rate_limited', writable: false, rejoinOffered: true,
        rejoinAttempt: 'idle', canRetry: false, docEpochPinned: true,
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(WINDOW_MS - 1); });
      expect(result.current.canRetry).toBe(false);
      act(() => { result.current.retry(); });
      expect(Socket.instances).toHaveLength(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(result.current.canRetry).toBe(true);
      // Never by itself.
      await act(async () => { await vi.advanceTimersByTimeAsync(10 * WINDOW_MS); });
      expect(Socket.instances).toHaveLength(1);
      expectSameDraft(session);
    });

    it('offers no Rejoin for a document without a pinned epoch', async () => {
      const session = limited({ pin: false });
      expect(session.result.current).toMatchObject({
        readOnlyReason: 'rate_limited', rejoinOffered: false, canRetry: false, docEpochPinned: false,
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(2 * WINDOW_MS); });
      expect(session.result.current.canRetry).toBe(false);
      act(() => { session.result.current.retry(); });
      expect(Socket.instances).toHaveLength(1);
    });

    it.each([
      ['forbidden', 'forbidden', 'permission_loss'],
      ['flag_off', 'flag_off', 'flag_off'],
      ['readonly', 'readonly', 'readonly'],
      ['an unknown reason', 'something_new', 'permission_loss'],
      ['an empty reason', '', 'permission_loss'],
    ])('offers no Rejoin after a 4403 %s', async (_name, reason, expected) => {
      const session = limited({ reason });
      expect(session.result.current.readOnlyReason).toBe(expected);
      expect(session.result.current.rejoinOffered).toBe(false);
      await act(async () => { await vi.advanceTimersByTimeAsync(2 * WINDOW_MS); });
      expect(session.result.current.canRetry).toBe(false);
      act(() => { session.result.current.retry(); });
      expect(Socket.instances).toHaveLength(1);
      expectSameDraft(session);
    });

    it('restarts the window on a second rate_limited and never retries by itself', async () => {
      const session = limited();
      const attempt = await rejoin(session);
      act(() => { attempt.open(); attempt.close(4403, 'rate_limited'); });
      expect(session.result.current).toMatchObject({
        readOnlyReason: 'rate_limited', rejoinOffered: true, rejoinAttempt: 'idle', canRetry: false, writable: false,
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(WINDOW_MS - 1); });
      expect(session.result.current.canRetry).toBe(false);
      act(() => { session.result.current.retry(); });
      expect(Socket.instances).toHaveLength(2);
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(session.result.current.canRetry).toBe(true);
      await act(async () => { await vi.advanceTimersByTimeAsync(5 * WINDOW_MS); });
      expect(Socket.instances).toHaveLength(2);
      expect(session.writables).not.toContain(true);
      expectSameDraft(session);
    });

    it('restores editing only when all four conditions hold, and sends the offline edits first', async () => {
      const session = limited();
      const { result, gateway } = session;
      const attempt = await rejoin(session);
      expect(new URL(attempt.url).searchParams.get('expectedDocEpoch')).toBe(EPOCH);
      expect(new URL(attempt.url).searchParams.get('expectedLifecycleRevision')).toBe('1');
      expect(attempt.protocols).toEqual([COLLAB_WS_PROTOCOL, 'jwt-old']);
      expect(result.current).toMatchObject({ rejoinAttempt: 'attempting', canRetry: false, writable: false });

      // The sync of this connection alone changes nothing; neither does the admission.
      act(() => { attempt.open(); gateway.pump(attempt); });
      expect(result.current.writable).toBe(false);
      act(() => { admission(attempt); });
      expect(result.current.writable).toBe(false);
      // The server's SyncStep1 asks for the replay; the probe follows the reply, never precedes it.
      act(() => { gateway.requestReplay(attempt); });
      expect(probes(attempt)).toBe(0);
      await flush();
      expect(probes(attempt)).toBe(1);
      expect(result.current.writable).toBe(false);
      expect(gateway.text()).toBe('Published text');
      const rendersBefore = session.writables.length;
      act(() => { gateway.pump(attempt); });

      expect(gateway.text()).toBe('Published text + offline');
      expect(result.current).toMatchObject({
        writable: true, connected: true, readOnlyReason: null, error: null,
        rejoinOffered: false, rejoinAttempt: 'idle', canRetry: false,
      });
      expect(session.writables.slice(0, rendersBefore)).not.toContain(true);
      expectSameDraft(session);

      // Normal reconnect behaviour resumes.
      act(() => { attempt.close(1006, 'offline'); });
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
      expect(Socket.instances).toHaveLength(3);
      expect(result.current.rejoinOffered).toBe(false);
    });

    it.each([
      ['the writable admission', async (s: Socket, g: Gateway) => {
        act(() => { s.open(); g.pump(s); g.requestReplay(s); });
        await flush();
        act(() => { g.pump(s); });
      }],
      ['a sync event of this connection', async (s: Socket, g: Gateway) => {
        g.silent = true;
        act(() => { s.open(); g.pump(s); admission(s); g.requestReplay(s); });
        await flush();
        act(() => { g.pump(s); });
      }],
      ['the server SyncStep1, with the first-sync flag and the sync of this connection', async (s: Socket, g: Gateway) => {
        act(() => { s.open(); g.pump(s); admission(s); });
        await flush();
      }],
      ['coverage of the draft', async (s: Socket, g: Gateway) => {
        g.dropUpdates = true;
        await join(s, g);
      }],
    ])('stays read-only without %s and ends unconfirmed after the timeout', async (_name, drive) => {
      const session = limited();
      const { result, gateway } = session;
      const attempt = await rejoin(session);
      await drive(attempt, gateway);
      expect(result.current).toMatchObject({ writable: false, readOnlyReason: 'rate_limited', rejoinAttempt: 'attempting' });
      await act(async () => { await vi.advanceTimersByTimeAsync(REJOIN_COVERAGE_TIMEOUT_MS - 1); });
      expect(result.current.rejoinAttempt).toBe('attempting');
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(result.current).toMatchObject({
        writable: false, connected: false, readOnlyReason: 'rate_limited', rejoinOffered: true,
        rejoinAttempt: 'unconfirmed', canRetry: true,
      });
      expect(attempt.readyState).toBe(Socket.CLOSED);
      expect(session.writables).not.toContain(true);
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      expect(Socket.instances).toHaveLength(2);
      expectSameDraft(session);
    });

    it('asks again one second after an answer that did not cover the draft, with one probe in flight', async () => {
      const session = limited();
      const { result, gateway, draft } = session;
      const attempt = await rejoin(session);
      gateway.dropUpdates = true;
      await join(attempt, gateway);
      expect(probes(attempt)).toBe(1);
      expect(result.current.writable).toBe(false);
      await act(async () => { await vi.advanceTimersByTimeAsync(999); });
      expect(probes(attempt)).toBe(1);

      // The room catches up with the draft by other means; the next answer covers it.
      gateway.dropUpdates = false;
      Y.applyUpdate(gateway.doc, Y.encodeStateAsUpdate(draft));
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(probes(attempt)).toBe(2);
      expect(result.current.writable).toBe(false);
      act(() => { gateway.pump(attempt); });
      expect(result.current).toMatchObject({ writable: true, readOnlyReason: null });
      expectSameDraft(session);
    });

    it.each([
      ['a gateway that applies the replay', false, true],
      ['a gateway that lost the replay', true, false],
    ])('covers a deletion-only offline change through the deletions: %s', async (_name, dropUpdates, succeeds) => {
      const session = limited({ offline: false });
      const { result, gateway, draft } = session;
      act(() => { draft.getText('draft').delete(0, 10); });
      const attempt = await rejoin(session);
      gateway.dropUpdates = dropUpdates;
      await join(attempt, gateway);
      // Deleting advances no clock: the state vectors alone already match.
      expect(result.current.writable).toBe(succeeds);
      if (!succeeds) {
        await act(async () => { await vi.advanceTimersByTimeAsync(REJOIN_COVERAGE_TIMEOUT_MS); });
        expect(result.current).toMatchObject({ writable: false, rejoinAttempt: 'unconfirmed' });
      }
      expectSameDraft(session, 'text');
    });

    it.each([
      ['writable_refused', (s: Socket) => control(s, {
        type: 'writable_refused', reason: 'lifecycle_revision_stale',
        expectedLifecycleRevision: '1', currentLifecycleRevision: '3',
      }), 'lifecycle_changed'],
      ['permission_loss', (s: Socket) => control(s, { type: 'permission_loss', reason: 'edit_permission_revoked' }), 'permission_loss'],
      ['doc_reset', (s: Socket) => { control(s, { type: 'doc_reset' }); s.close(1001, 'doc_reset'); }, 'document_changed'],
      ['the doc_reset close', (s: Socket) => s.close(1001, 'doc_reset'), 'document_changed'],
      ['tombstone', (s: Socket) => control(s, { type: 'tombstone' }), 'not_found'],
      ['commit_unknown', (s: Socket) => control(s, { type: 'commit_unknown' }), 'commit_unknown'],
      ['the commit_unknown close', (s: Socket) => s.close(1001, 'commit_unknown'), 'commit_unknown'],
      ['4403 forbidden', (s: Socket) => s.close(4403, 'forbidden'), 'permission_loss'],
      ['4403 flag_off', (s: Socket) => s.close(4403, 'flag_off'), 'flag_off'],
      ['4403 readonly', (s: Socket) => s.close(4403, 'readonly'), 'readonly'],
      ['4404', (s: Socket) => s.close(4404, 'not_found'), 'not_found'],
    ])('ends a Rejoin refused by %s in the read-only draft with its own reason', async (_name, arrive, reason) => {
      const refresh = vi.spyOn(globalThis, 'fetch');
      const session = limited();
      const { result, provider } = session;
      const attempt = await rejoin(session);
      const disconnect = vi.spyOn(provider, 'disconnect');
      act(() => { attempt.open(); admission(attempt); });
      expect(result.current.writable).toBe(false);
      act(() => { arrive(attempt); });

      expect(result.current).toMatchObject({
        readOnlyReason: reason, writable: false, connected: false, rejoinOffered: false,
        rejoinAttempt: 'idle', canRetry: false,
      });
      expect(session.writables).not.toContain(true);
      expect(attempt.readyState).toBe(Socket.CLOSED);
      // The terminal close that follows `connection-close` is settled once.
      expect(disconnect).toHaveBeenCalledTimes(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(10 * WINDOW_MS); });
      expect(Socket.instances).toHaveLength(2);
      expect(refresh).not.toHaveBeenCalled();
      act(() => { result.current.retry(); });
      expect(Socket.instances).toHaveLength(2);
      expectSameDraft(session);
    });

    it.each([
      [1006, 'offline'],
      [1013, 'join_backlog'],
      [1009, 'message_too_big'],
      [1001, 'collab_frame_refused'],
    ])('keeps rate_limited with Rejoin available at once after a transient close %i during the replay', async (code, reason) => {
      const session = limited();
      const { result, gateway } = session;
      const attempt = await rejoin(session);
      act(() => { attempt.open(); gateway.pump(attempt); admission(attempt); gateway.requestReplay(attempt); });
      await flush();
      act(() => { attempt.close(code, reason); });

      expect(result.current).toMatchObject({
        readOnlyReason: 'rate_limited', writable: false, connected: false, rejoinOffered: true,
        rejoinAttempt: 'unconfirmed', canRetry: true,
      });
      // y-websocket's own reconnect timer must not start a second attempt.
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      expect(Socket.instances).toHaveLength(2);

      // A fresh press is available at once and works again.
      const again = await rejoin(session, false);
      await join(again, gateway);
      expect(result.current).toMatchObject({ writable: true, readOnlyReason: null });
      expect(gateway.text()).toBe('Published text + offline');
      expectSameDraft(session);
    });

    it('lets no stale y-websocket timer of an ended attempt open a second connection', async () => {
      const session = limited();
      const first = await rejoin(session);
      act(() => { first.open(); first.close(1006, 'offline'); });
      // Pressed again before the library's own reconnect delay has elapsed.
      const second = await rejoin(session, false);
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
      expect(Socket.instances).toHaveLength(3);
      expect(session.result.current.rejoinAttempt).toBe('attempting');
      act(() => { second.open(); second.close(1006, 'offline'); });
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      expect(Socket.instances).toHaveLength(3);
      expect(session.result.current).toMatchObject({ rejoinAttempt: 'unconfirmed', canRetry: true, writable: false });
    });

    it('lets no token change act on a running attempt', async () => {
      const session = limited();
      const attempt = await rejoin(session);
      act(() => { attempt.open(); });
      act(() => { useAuthStore.getState().setAuth('jwt-newer', user); });
      await act(async () => { await vi.advanceTimersByTimeAsync(REJOIN_COVERAGE_TIMEOUT_MS - 1); });
      expect(Socket.instances).toHaveLength(2);
      expect(attempt.protocols).toEqual([COLLAB_WS_PROTOCOL, 'jwt-old']);
      expect(session.result.current.rejoinAttempt).toBe('attempting');
    });

    describe('a 4401 during the attempt', () => {
      const freshResponse = () => new Response(JSON.stringify({ accessToken: 'jwt-fresh', user }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
      const refreshWith = (answer: () => Promise<Response>) => vi.spyOn(globalThis, 'fetch').mockImplementation(answer);
      /** The upgrade of the attempt's connection is refused with 4401. */
      const refuse = (socket: Socket) => act(async () => { socket.close(4401, 'unauthorized'); });

      it('refreshes the token once and continues the same attempt, which then succeeds with its proof', async () => {
        const refresh = refreshWith(async () => freshResponse());
        const session = limited();
        const { result, gateway } = session;
        const first = await rejoin(session);
        await refuse(first);

        expect(refresh).toHaveBeenCalledTimes(1);
        expect(String(refresh.mock.calls[0]![0])).toContain('/auth/refresh');
        expect(Socket.instances).toHaveLength(3);
        const second = Socket.instances[2]!;
        expect(second.protocols).toEqual([COLLAB_WS_PROTOCOL, 'jwt-fresh']);
        expect(new URL(second.url).searchParams.get('expectedDocEpoch')).toBe(EPOCH);
        expect(new URL(second.url).searchParams.get('expectedLifecycleRevision')).toBe('1');
        expect(result.current).toMatchObject({ rejoinAttempt: 'attempting', canRetry: false, writable: false });

        await join(second, gateway);
        expect(result.current).toMatchObject({
          writable: true, readOnlyReason: null, error: null, rejoinOffered: false, rejoinAttempt: 'idle',
        });
        expect(gateway.text()).toBe('Published text + offline');
        expect(session.writables.slice(0, -1)).not.toContain(true);
        expect(refresh).toHaveBeenCalledTimes(1);
        expectSameDraft(session);
      });

      it('counts the proof limit from the connection that follows the refresh, not from the press', async () => {
        refreshWith(async () => freshResponse());
        const session = limited();
        const { result, gateway } = session;
        const first = await rejoin(session);
        await act(async () => { await vi.advanceTimersByTimeAsync(REJOIN_COVERAGE_TIMEOUT_MS - 1_000); });
        await refuse(first);
        const second = Socket.instances[2]!;
        act(() => { second.open(); gateway.pump(second); admission(second); });
        await act(async () => { await vi.advanceTimersByTimeAsync(REJOIN_COVERAGE_TIMEOUT_MS - 1); });
        expect(result.current.rejoinAttempt).toBe('attempting');
        await act(async () => { await vi.advanceTimersByTimeAsync(1); });
        expect(result.current).toMatchObject({ rejoinAttempt: 'unconfirmed', canRetry: true, writable: false });
      });

      it('does not let a slow refresh use up the proof limit', async () => {
        const held = Promise.withResolvers<Response>();
        refreshWith(() => held.promise);
        const session = limited();
        const { result, gateway } = session;
        const first = await rejoin(session);
        await refuse(first);
        // Longer than the proof limit, shorter than the refresh's own bound.
        await act(async () => { await vi.advanceTimersByTimeAsync(2 * REJOIN_COVERAGE_TIMEOUT_MS); });
        expect(result.current).toMatchObject({ rejoinAttempt: 'attempting', canRetry: false, writable: false });
        expect(Socket.instances).toHaveLength(2);
        await act(async () => { held.resolve(freshResponse()); await Promise.resolve(); });
        expect(Socket.instances).toHaveLength(3);
        await join(Socket.instances[2]!, gateway);
        expect(result.current).toMatchObject({ writable: true, readOnlyReason: null });
      });

      it('ends in the read-only draft with the session-expired reason on a second 4401 of the same attempt, with one refresh', async () => {
        const refresh = refreshWith(async () => freshResponse());
        const session = limited();
        const { result } = session;
        const first = await rejoin(session);
        await refuse(first);
        const second = Socket.instances[2]!;
        await refuse(second);

        expect(result.current).toMatchObject({
          error: 'unauthorized', readOnlyReason: 'unauthorized', writable: false, connected: false,
          rejoinOffered: false, rejoinAttempt: 'idle', canRetry: false,
        });
        expect(refresh).toHaveBeenCalledTimes(1);
        // No reconnect loop: nothing opens another connection, by timer or by press.
        await act(async () => { await vi.advanceTimersByTimeAsync(10 * WINDOW_MS); });
        act(() => { result.current.retry(); });
        expect(Socket.instances).toHaveLength(3);
        expect(refresh).toHaveBeenCalledTimes(1);
        expect(session.writables).not.toContain(true);
        expectSameDraft(session);
      });

      it('ends in the read-only draft with the session-expired reason when no session is left to refresh', async () => {
        const refresh = refreshWith(async () => new Response(null, { status: 401 }));
        const session = limited();
        const { result } = session;
        const first = await rejoin(session);
        await refuse(first);

        expect(result.current).toMatchObject({
          error: 'unauthorized', readOnlyReason: 'unauthorized', writable: false, connected: false,
          rejoinOffered: false, rejoinAttempt: 'idle', canRetry: false,
        });
        expect(refresh).toHaveBeenCalledTimes(1);
        await act(async () => { await vi.advanceTimersByTimeAsync(10 * WINDOW_MS); });
        expect(Socket.instances).toHaveLength(2);
        expectSameDraft(session);
      });

      it('ends unconfirmed, without a reconnect, when the refresh cannot tell whether the session is gone', async () => {
        const refresh = refreshWith(async () => new Response('{', { status: 200 }));
        const session = limited();
        const { result } = session;
        const first = await rejoin(session);
        await refuse(first);

        expect(result.current).toMatchObject({
          readOnlyReason: 'rate_limited', writable: false, rejoinOffered: true, rejoinAttempt: 'unconfirmed', canRetry: true,
        });
        await act(async () => { await vi.advanceTimersByTimeAsync(10 * WINDOW_MS); });
        expect(Socket.instances).toHaveLength(2);
        expect(refresh).toHaveBeenCalledTimes(1);
        expectSameDraft(session);
      });

      it('adds no other automatic reconnect: a transient close after the refresh ends the attempt unconfirmed', async () => {
        const refresh = refreshWith(async () => freshResponse());
        const session = limited();
        const { result, gateway } = session;
        const first = await rejoin(session);
        await refuse(first);
        const second = Socket.instances[2]!;
        act(() => { second.open(); gateway.pump(second); second.close(1006, 'offline'); });

        expect(result.current).toMatchObject({ rejoinAttempt: 'unconfirmed', canRetry: true, writable: false });
        await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
        expect(Socket.instances).toHaveLength(3);
        expect(refresh).toHaveBeenCalledTimes(1);
      });

      it('lets a refresh that settles after the attempt ended in another refusal open nothing', async () => {
        const held = Promise.withResolvers<Response>();
        const refresh = refreshWith(() => held.promise);
        const session = limited();
        const { result } = session;
        const first = await rejoin(session);
        await refuse(first);
        // The attempt's connection is gone, so the Save route's answer ends the session.
        act(() => { result.current.declareCommitUnknown(session.draft); });
        expect(result.current.readOnlyReason).toBe('commit_unknown');
        await act(async () => { held.resolve(freshResponse()); await vi.advanceTimersByTimeAsync(60_000); });
        expect(Socket.instances).toHaveLength(2);
        expect(refresh).toHaveBeenCalledTimes(1);
        expect(result.current).toMatchObject({ readOnlyReason: 'commit_unknown', writable: false, rejoinAttempt: 'idle' });
      });

      it('refuses to refresh when the account changed before the 4401, and opens nothing', async () => {
        const refresh = refreshWith(async () => freshResponse());
        const session = limited();
        const { result } = session;
        const first = await rejoin(session);
        act(() => { useAuthStore.getState().setAuth('jwt-other', OTHER_USER); });
        await refuse(first);

        expect(refresh).not.toHaveBeenCalled();
        expect(result.current).toMatchObject({
          error: 'unauthorized', readOnlyReason: 'unauthorized', writable: false, rejoinOffered: false, rejoinAttempt: 'idle',
        });
        await act(async () => { await vi.advanceTimersByTimeAsync(10 * WINDOW_MS); });
        expect(Socket.instances).toHaveLength(2);
        expectSameDraft(session);
      });

      it('does not reopen the old provider with a refresh result of another account', async () => {
        // The refresh is browser-cookie scoped: it can hand back another account's session.
        const refresh = refreshWith(async () => new Response(
          JSON.stringify({ accessToken: 'jwt-other', user: OTHER_USER }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ));
        const session = limited();
        const { result } = session;
        const first = await rejoin(session);
        await refuse(first);

        expect(refresh).toHaveBeenCalledTimes(1);
        expect(Socket.instances).toHaveLength(2);
        expect(Socket.instances.some((s) => s.protocols.includes('jwt-other'))).toBe(false);
        expect(result.current).toMatchObject({
          error: 'unauthorized', readOnlyReason: 'unauthorized', writable: false, rejoinOffered: false, rejoinAttempt: 'idle',
        });
        await act(async () => { await vi.advanceTimersByTimeAsync(10 * WINDOW_MS); });
        expect(Socket.instances).toHaveLength(2);
        expectSameDraft(session);
      });

      it('ends unconfirmed when the refresh never settles, ignores its late result and keeps Rejoin usable', async () => {
        const held = Promise.withResolvers<Response>();
        const refresh = refreshWith(() => held.promise);
        const session = limited();
        const { result } = session;
        const first = await rejoin(session);
        await refuse(first);
        await act(async () => { await vi.advanceTimersByTimeAsync(REJOIN_REFRESH_WAIT_MS - 1); });
        expect(result.current).toMatchObject({ rejoinAttempt: 'attempting', canRetry: false });
        await act(async () => { await vi.advanceTimersByTimeAsync(1); });
        expect(result.current).toMatchObject({
          readOnlyReason: 'rate_limited', writable: false, rejoinOffered: true, rejoinAttempt: 'unconfirmed', canRetry: true,
        });
        expect(Socket.instances).toHaveLength(2);

        // A new press is a new attempt; the old refresh settling now must not touch it.
        const again = await rejoin(session, false);
        expect(Socket.instances).toHaveLength(3);
        await act(async () => { held.resolve(freshResponse()); await vi.advanceTimersByTimeAsync(1); });
        expect(Socket.instances).toHaveLength(3);
        expect(again.protocols).toEqual([COLLAB_WS_PROTOCOL, 'jwt-old']);
        expect(result.current).toMatchObject({ rejoinAttempt: 'attempting', writable: false });
        // The shared rotation was neither cancelled nor replayed.
        expect(refresh).toHaveBeenCalledTimes(1);
      });

      it('opens nothing when the editor is unmounted while the refresh is held', async () => {
        const held = Promise.withResolvers<Response>();
        const refresh = refreshWith(() => held.promise);
        const session = limited();
        const first = await rejoin(session);
        await refuse(first);
        session.unmount();
        await act(async () => { held.resolve(freshResponse()); await vi.advanceTimersByTimeAsync(2 * REJOIN_REFRESH_WAIT_MS); });
        expect(Socket.instances).toHaveLength(2);
        expect(refresh).toHaveBeenCalledTimes(1);
      });

      it('opens nothing for the old page when the page changes while the refresh is held', async () => {
        const held = Promise.withResolvers<Response>();
        refreshWith(() => held.promise);
        const session = limited();
        const first = await rejoin(session);
        await refuse(first);
        session.rerender({ pageId: '43' });
        const opened = Socket.instances.length;
        expect(session.result.current.ydoc).not.toBe(session.draft);
        await act(async () => { held.resolve(freshResponse()); await vi.advanceTimersByTimeAsync(2 * REJOIN_REFRESH_WAIT_MS); });
        // Only the new page's own first connection exists; nothing carries the refreshed token.
        expect(Socket.instances).toHaveLength(opened);
        expect(Socket.instances.some((s) => s.protocols.includes('jwt-fresh'))).toBe(false);
        expect(session.result.current.rejoinAttempt).toBe('idle');
      });

      it('ends in the read-only draft when the refreshed join receives doc_reset', async () => {
        refreshWith(async () => freshResponse());
        const session = limited();
        const { result } = session;
        const first = await rejoin(session);
        await refuse(first);
        const second = Socket.instances[2]!;
        act(() => {
          second.open();
          admission(second);
          control(second, { type: 'doc_reset' });
          second.close(1001, 'doc_reset');
        });

        expect(result.current).toMatchObject({
          readOnlyReason: 'document_changed', writable: false, rejoinOffered: false, rejoinAttempt: 'idle', canRetry: false,
        });
        await act(async () => { await vi.advanceTimersByTimeAsync(10 * WINDOW_MS); });
        act(() => { result.current.retry(); });
        expect(Socket.instances).toHaveLength(3);
        expect(session.writables).not.toContain(true);
        expectSameDraft(session);
      });
    });

    it('refuses to rejoin for another account', async () => {
      const session = limited();
      await act(async () => { await vi.advanceTimersByTimeAsync(WINDOW_MS); });
      act(() => { useAuthStore.getState().setAuth('jwt-other', { ...user, id: '00000000-0000-4000-8000-000000000002' }); });
      act(() => { session.result.current.retry(); });
      expect(Socket.instances).toHaveLength(1);
    });

    /** Every SyncStep1 the client sent: its own opening one, resyncs and the probe. */
    const step1Frames = (socket: Socket) => socket.sent.filter((frame) => frame[0] === 0 && frame[1] === 0).length;

    it('holds the periodic resync back while an attempt runs, so its answer cannot pass for the probe\'s', async () => {
      // The provider's 30 s interval is anchored to its creation: closed at 25 s,
      // the window ends at 85 s and the next tick (90 s) falls inside the attempt.
      const session = limited({ lead: 25_000 });
      const { result, gateway } = session;
      const attempt = await rejoin(session);
      act(() => { attempt.open(); gateway.pump(attempt); admission(attempt); gateway.requestReplay(attempt); });
      await flush();
      expect(probes(attempt)).toBe(1);
      expect(step1Frames(attempt)).toBe(2);

      // The tick passes while the probe's answer is still on its way.
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
      expect(step1Frames(attempt)).toBe(2);
      expect(result.current.writable).toBe(false);
      act(() => { gateway.pump(attempt); });
      expect(result.current).toMatchObject({ writable: true, readOnlyReason: null });
      expect(probes(attempt)).toBe(1);

      // Afterwards the resync behaves as it always did.
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      expect(step1Frames(attempt)).toBe(3);
    });

    it('sends no probe when no server SyncStep1 arrived, however long the room has already held the draft', async () => {
      const session = limited({ offline: false });
      const { result, gateway } = session;
      const attempt = await rejoin(session);
      // A gateway without #1928: synced and admitted, but it never asks for the replay.
      act(() => { attempt.open(); gateway.pump(attempt); admission(attempt); });
      await act(async () => { await vi.advanceTimersByTimeAsync(REJOIN_COVERAGE_TIMEOUT_MS - 1); });
      expect(probes(attempt)).toBe(0);
      expect(result.current).toMatchObject({ writable: false, rejoinAttempt: 'attempting' });
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(result.current).toMatchObject({ writable: false, rejoinAttempt: 'unconfirmed', canRetry: true });
      expect(probes(attempt)).toBe(0);
    });

    describe('an unknown collaborative save (#2035) while the draft is rate_limited', () => {
      const expectNoRejoin = async (session: Limited) => {
        expect(session.result.current).toMatchObject({
          readOnlyReason: 'commit_unknown', writable: false, connected: false,
          rejoinOffered: false, rejoinAttempt: 'idle', canRetry: false,
        });
        const sockets = Socket.instances.length;
        await act(async () => { await vi.advanceTimersByTimeAsync(3 * WINDOW_MS); });
        expect(session.result.current).toMatchObject({ rejoinOffered: false, canRetry: false });
        act(() => { session.result.current.retry(); });
        expect(Socket.instances).toHaveLength(sockets);
        expectSameDraft(session);
      };

      it('replaces the state during the cooldown: commit_unknown, no timer, no Rejoin', async () => {
        const session = limited();
        expect(session.result.current).toMatchObject({ readOnlyReason: 'rate_limited', rejoinOffered: true });

        act(() => { session.result.current.declareCommitUnknown(session.draft); });

        await expectNoRejoin(session);
      });

      it('replaces the state after the cooldown too, before Rejoin is pressed', async () => {
        const session = limited();
        await act(async () => { await vi.advanceTimersByTimeAsync(WINDOW_MS); });
        expect(session.result.current.canRetry).toBe(true);

        act(() => { session.result.current.declareCommitUnknown(session.draft); });

        await expectNoRejoin(session);
      });

      it('replaces the state after an unconfirmed attempt, clearing its notice and eligibility', async () => {
        const session = limited();
        const attempt = await rejoin(session);
        act(() => { attempt.open(); });
        await act(async () => { await vi.advanceTimersByTimeAsync(REJOIN_COVERAGE_TIMEOUT_MS); });
        expect(session.result.current).toMatchObject({ rejoinAttempt: 'unconfirmed', canRetry: true });

        act(() => { session.result.current.declareCommitUnknown(session.draft); });

        await expectNoRejoin(session);
      });

      it('ends a running attempt the same way', async () => {
        const session = limited();
        const attempt = await rejoin(session);
        act(() => { attempt.open(); });

        act(() => { session.result.current.declareCommitUnknown(session.draft); });

        expect(attempt.readyState).toBe(Socket.CLOSED);
        await expectNoRejoin(session);
      });

      it.each([
        ['forbidden', 'permission_loss'],
        ['flag_off', 'flag_off'],
        ['readonly', 'readonly'],
      ])('does not overwrite a terminal 4403 %s refusal', async (reason, expected) => {
        const session = limited({ reason });
        expect(session.result.current.readOnlyReason).toBe(expected);

        act(() => { session.result.current.declareCommitUnknown(session.draft); });

        expect(session.result.current).toMatchObject({ readOnlyReason: expected, rejoinOffered: false });
      });

      it('does not overwrite a refusal an attempt ended in', async () => {
        const session = limited();
        const attempt = await rejoin(session);
        act(() => { attempt.open(); control(attempt, { type: 'doc_reset' }); });
        expect(session.result.current.readOnlyReason).toBe('document_changed');

        act(() => { session.result.current.declareCommitUnknown(session.draft); });

        expect(session.result.current.readOnlyReason).toBe('document_changed');
      });

      it('ignores an answer for a document that is not the mounted one', async () => {
        const session = limited();
        const earlier = new Y.Doc();

        act(() => { session.result.current.declareCommitUnknown(earlier); });

        expect(session.result.current).toMatchObject({
          readOnlyReason: 'rate_limited', rejoinOffered: true, canRetry: false,
        });
        await act(async () => { await vi.advanceTimersByTimeAsync(WINDOW_MS); });
        expect(session.result.current.canRetry).toBe(true);
        earlier.destroy();
      });
    });
  });
});
