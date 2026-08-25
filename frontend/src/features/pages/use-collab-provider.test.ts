import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor, cleanup } from '@testing-library/react';
import { COLLAB_WS_PROTOCOL } from '@compendiq/contracts';
import { useAuthStore } from '../../stores/auth-store';

const { refreshAccessTokenOnce, MockWebsocketProvider } = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => void;

  class MockWebsocketProvider {
    static instances: MockWebsocketProvider[] = [];
    handlers = new Map<string, Handler[]>();
    destroyed = false;
    messageHandlers: Array<unknown> = [];
    awareness: {
      on: ReturnType<typeof vi.fn>;
      off: ReturnType<typeof vi.fn>;
      getStates: () => Map<number, unknown>;
    };

    protocols: string[] = [];
    connect = vi.fn();

    constructor(
      public serverUrl: string,
      public roomname: string,
      public doc: unknown,
      public opts: {
        protocols?: string[];
        disableBc?: boolean;
        resyncInterval?: number;
        awareness?: unknown;
      },
    ) {
      this.protocols = opts.protocols ?? [];
      this.awareness = {
        on: vi.fn(),
        off: vi.fn(),
        getStates: () => new Map(),
      };
      MockWebsocketProvider.instances.push(this);
    }

    on(event: string, fn: Handler) {
      const list = this.handlers.get(event) ?? [];
      list.push(fn);
      this.handlers.set(event, list);
      return this;
    }

    emit(event: string, ...args: unknown[]) {
      for (const fn of this.handlers.get(event) ?? []) fn(...args);
    }

    destroy() {
      this.destroyed = true;
    }
  }

  return {
    refreshAccessTokenOnce: vi.fn(),
    MockWebsocketProvider,
  };
});

vi.mock('../../shared/lib/api', () => ({
  refreshAccessTokenOnce: (...args: unknown[]) => refreshAccessTokenOnce(...args),
}));

vi.mock('y-websocket', () => ({
  WebsocketProvider: MockWebsocketProvider,
}));

import { useCollabProvider } from './use-collab-provider';

describe('useCollabProvider', () => {
  beforeEach(() => {
    MockWebsocketProvider.instances = [];
    refreshAccessTokenOnce.mockReset();
    useAuthStore.getState().setAuth('jwt-old', {
      id: 'self',
      username: 'me',
      role: 'user',
    });
  });

  afterEach(() => {
    cleanup();
    useAuthStore.getState().clearAuth();
  });

  it('does not construct a provider without a token (never an empty protocol)', () => {
    useAuthStore.getState().clearAuth();
    renderHook(() => useCollabProvider({ pageId: '12', enabled: true }));
    expect(MockWebsocketProvider.instances).toHaveLength(0);
  });

  it('does not construct a provider when disabled (flag off / read mode)', () => {
    renderHook(() => useCollabProvider({ pageId: '12', enabled: false }));
    expect(MockWebsocketProvider.instances).toHaveLength(0);
  });

  it('connects with [compendiq.collab.v1, jwt], disableBc, and the page room', () => {
    renderHook(() => useCollabProvider({ pageId: '42', enabled: true }));
    expect(MockWebsocketProvider.instances).toHaveLength(1);
    const inst = MockWebsocketProvider.instances[0]!;
    expect(inst.serverUrl).toMatch(/\/api\/collab$/);
    expect(inst.roomname).toBe('42');
    expect(inst.opts.protocols).toEqual([COLLAB_WS_PROTOCOL, 'jwt-old']);
    expect(inst.opts.protocols).not.toContain('');
    expect(inst.opts.disableBc).toBe(true);
    expect(inst.opts.resyncInterval).toBe(30_000);
  });

  it('on 4401 closed refreshes the JWT, updates protocols, and connect()s the same instance', async () => {
    refreshAccessTokenOnce.mockResolvedValue('jwt-fresh');
    renderHook(() => useCollabProvider({ pageId: '42', enabled: true }));
    const first = MockWebsocketProvider.instances[0]!;
    expect(first.opts.protocols).toEqual([COLLAB_WS_PROTOCOL, 'jwt-old']);

    await act(async () => {
      first.emit('closed', { code: 4401, reason: 'unauthorized' });
    });

    await waitFor(() => {
      expect(refreshAccessTokenOnce).toHaveBeenCalledTimes(1);
      expect(first.connect).toHaveBeenCalledTimes(1);
    });
    expect(first.destroyed).toBe(false);
    expect(MockWebsocketProvider.instances).toHaveLength(1);
    expect(first.protocols).toEqual([COLLAB_WS_PROTOCOL, 'jwt-fresh']);
  });

  it('on 4403 closed destroys the provider and does not reconnect', async () => {
    const { result } = renderHook(() => useCollabProvider({ pageId: '42', enabled: true }));
    const first = MockWebsocketProvider.instances[0]!;

    await act(async () => {
      first.emit('closed', { code: 4403, reason: 'forbidden' });
    });

    expect(first.destroyed).toBe(true);
    expect(first.connect).not.toHaveBeenCalled();
    expect(MockWebsocketProvider.instances).toHaveLength(1);
    expect(result.current.error).toBe('forbidden');
    expect(refreshAccessTokenOnce).not.toHaveBeenCalled();
  });

  it('on 4404 closed destroys the provider and does not reconnect', async () => {
    const { result } = renderHook(() => useCollabProvider({ pageId: '42', enabled: true }));
    const first = MockWebsocketProvider.instances[0]!;

    await act(async () => {
      first.emit('closed', { code: 4404, reason: 'not_found' });
    });

    expect(first.destroyed).toBe(true);
    expect(MockWebsocketProvider.instances).toHaveLength(1);
    expect(result.current.error).toBe('not_found');
  });

  it('on 1001 doc_reset remounts a new Y.Doc and provider (never reconnects onto the old document)', async () => {
    const { result } = renderHook(() => useCollabProvider({ pageId: '42', enabled: true }));
    const first = MockWebsocketProvider.instances[0]!;
    const oldDoc = first.doc;
    expect(result.current.ydoc).toBe(oldDoc);

    await act(async () => {
      first.emit('connection-close', { code: 1001, reason: 'doc_reset' } as CloseEvent);
    });

    expect(first.destroyed).toBe(true);
    await waitFor(() => {
      expect(MockWebsocketProvider.instances).toHaveLength(2);
    });
    const second = MockWebsocketProvider.instances[1]!;
    expect(second.doc).not.toBe(oldDoc);
    expect(result.current.ydoc).not.toBe(oldDoc);
    expect(result.current.ydoc).toBe(second.doc);
    expect(result.current.error).toBeNull();
  });

  it('on type-4 doc_reset remounts a new Y.Doc even if the socket has not closed yet', async () => {
    const { result } = renderHook(() => useCollabProvider({ pageId: '42', enabled: true }));
    const first = MockWebsocketProvider.instances[0]!;
    const oldDoc = first.doc;
    const handler = first.messageHandlers[4] as
      | ((_encoder: unknown, decoder: unknown) => void)
      | undefined;
    expect(handler).toEqual(expect.any(Function));

    const encoding = await import('lib0/encoding');
    const decoding = await import('lib0/decoding');
    const encoder = encoding.createEncoder();
    encoding.writeVarString(encoder, JSON.stringify({ type: 'doc_reset' }));
    const decoder = decoding.createDecoder(encoding.toUint8Array(encoder));

    await act(async () => {
      handler!(null, decoder);
    });

    expect(first.destroyed).toBe(true);
    await waitFor(() => {
      expect(MockWebsocketProvider.instances).toHaveLength(2);
    });
    expect(MockWebsocketProvider.instances[1]!.doc).not.toBe(oldDoc);
    expect(result.current.ydoc).not.toBe(oldDoc);

    await act(async () => {
      first.emit('connection-close', { code: 1001, reason: 'doc_reset' } as CloseEvent);
    });
    expect(MockWebsocketProvider.instances).toHaveLength(2);
  });

  it('on 1001 without doc_reset does not remount (token-refresh 4401 still shares the Y.Doc)', async () => {
    renderHook(() => useCollabProvider({ pageId: '42', enabled: true }));
    const first = MockWebsocketProvider.instances[0]!;
    await act(async () => {
      first.emit('connection-close', { code: 1001, reason: 'shutdown' } as CloseEvent);
    });
    expect(MockWebsocketProvider.instances).toHaveLength(1);
    expect(first.destroyed).toBe(false);
  });
});
