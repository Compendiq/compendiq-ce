import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor, cleanup } from '@testing-library/react';
import { usePresence, type PresenceViewer } from './use-presence';
import { useAuthStore } from '../../stores/auth-store';

/**
 * Helpers — each test builds a fresh fetch mock so we can thread a controlled
 * ReadableStream into the hook's SSE reader loop.
 */

interface StreamHandle {
  push: (s: string) => void;
  close: () => void;
  error: (err: unknown) => void;
}

function makeSseResponse(): { response: Response; handle: StreamHandle } {
  const encoder = new TextEncoder();
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) { ctrl = c; },
  });
  return {
    response: new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }),
    handle: {
      push: (s) => ctrl.enqueue(encoder.encode(s)),
      close: () => ctrl.close(),
      error: (err) => ctrl.error(err),
    },
  };
}

function frame(viewers: PresenceViewer[], pageId = 'page-1'): string {
  const payload = JSON.stringify({ viewers, pageId, ts: Date.now() });
  return `event: presence\ndata: ${payload}\n\n`;
}

describe('usePresence', () => {
  beforeEach(() => {
    useAuthStore.getState().setAuth('token-abc', { id: 'self', username: 'me', role: 'user' });
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    // Unmount any still-mounted hooks BEFORE we restore the fetch mock, so the
    // cleanup-path DELETE hits the spy rather than the real undici fetch (which
    // rejects relative URLs in Node).
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    useAuthStore.getState().clearAuth();
  });

  it('opens the SSE stream, filters self out, and sorts editors first', async () => {
    let handle: StreamHandle | null = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : (url as URL).toString();
      if (init?.method === 'POST' && urlStr.includes('/heartbeat')) return new Response(null, { status: 204 });
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      const { response, handle: h } = makeSseResponse();
      handle = h;
      return response;
    });

    const { result } = renderHook(() => usePresence('page-1'));

    await waitFor(() => expect(handle).not.toBeNull());

    await act(async () => {
      handle!.push(frame([
        { userId: 'self', name: 'Me', role: 'user', isEditing: false },
        { userId: 'u-zed', name: 'Zed', role: 'viewer', isEditing: false },
        { userId: 'u-alice', name: 'Alice', role: 'editor', isEditing: true },
        { userId: 'u-bob', name: 'Bob', role: 'viewer', isEditing: false },
      ]));
    });

    await waitFor(() => expect(result.current.viewers).toHaveLength(3));
    // Self filtered out.
    expect(result.current.viewers.find((v) => v.userId === 'self')).toBeUndefined();
    // Editor first, then alphabetical.
    expect(result.current.viewers.map((v) => v.name)).toEqual(['Alice', 'Bob', 'Zed']);
  });

  it('fires a heartbeat every 10 seconds carrying the current editing flag', async () => {
    const heartbeats: Array<{ body: unknown }> = [];
    let handle: StreamHandle | null = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : (url as URL).toString();
      if (init?.method === 'POST' && urlStr.includes('/heartbeat')) {
        heartbeats.push({ body: init.body ? JSON.parse(init.body as string) : null });
        return new Response(null, { status: 204 });
      }
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      const { response, handle: h } = makeSseResponse();
      handle = h;
      return response;
    });

    const { result, unmount } = renderHook(() => usePresence('page-1'));

    // Immediate heartbeat on connect.
    await waitFor(() => expect(handle).not.toBeNull());
    await waitFor(() => expect(heartbeats.length).toBeGreaterThanOrEqual(1));
    expect(heartbeats[0]?.body).toEqual({ isEditing: false });

    // Flipping editing state fires an immediate heartbeat.
    act(() => { result.current.setEditing(true); });
    await waitFor(() => expect(heartbeats.at(-1)?.body).toEqual({ isEditing: true }));

    // The 10s interval fires again with the current flag.
    const before = heartbeats.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(heartbeats.length).toBeGreaterThan(before);
    expect(heartbeats.at(-1)?.body).toEqual({ isEditing: true });

    unmount();
  });

  it('sends DELETE on unmount and stops the heartbeat interval', async () => {
    let deletes = 0;
    let heartbeats = 0;
    let handle: StreamHandle | null = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : (url as URL).toString();
      if (init?.method === 'POST' && urlStr.includes('/heartbeat')) {
        heartbeats += 1;
        return new Response(null, { status: 204 });
      }
      if (init?.method === 'DELETE') {
        deletes += 1;
        return new Response(null, { status: 204 });
      }
      const { response, handle: h } = makeSseResponse();
      handle = h;
      return response;
    });

    const { unmount } = renderHook(() => usePresence('page-1'));
    await waitFor(() => expect(handle).not.toBeNull());
    await waitFor(() => expect(heartbeats).toBeGreaterThanOrEqual(1));

    const beforeUnmount = heartbeats;
    unmount();
    expect(deletes).toBeGreaterThanOrEqual(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(heartbeats).toBe(beforeUnmount);
  });

  it('reconnects with backoff after a stream error', async () => {
    let sseOpens = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : (url as URL).toString();
      if (init?.method === 'POST' && urlStr.includes('/heartbeat')) return new Response(null, { status: 204 });
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      sseOpens += 1;
      if (sseOpens === 1) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(c) { queueMicrotask(() => c.error(new Error('boom'))); },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        );
      }
      const { response } = makeSseResponse();
      return response;
    });

    const { unmount } = renderHook(() => usePresence('page-1'));
    await waitFor(() => expect(sseOpens).toBe(1));

    // Backoff is 1s for the first retry — advance past it.
    await act(async () => { await vi.advanceTimersByTimeAsync(1_100); });
    await waitFor(() => expect(sseOpens).toBeGreaterThanOrEqual(2));

    unmount();
  });

  it('does not reconnect after a 401 from the SSE endpoint', async () => {
    let sseOpens = 0;
    let heartbeats = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : (url as URL).toString();
      if (init?.method === 'POST' && urlStr.includes('/heartbeat')) {
        heartbeats += 1;
        return new Response(null, { status: 204 });
      }
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      sseOpens += 1;
      return new Response(null, { status: 401 });
    });

    const { unmount } = renderHook(() => usePresence('page-1'));
    await waitFor(() => expect(sseOpens).toBe(1));

    // Advance past the full 30s backoff cap — no reconnect should be scheduled.
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(sseOpens).toBe(1);
    // Heartbeat interval should not fire either (auth is busted, no point spamming).
    expect(heartbeats).toBe(0);

    unmount();
  });

  it('does not reconnect after a 403 from the SSE endpoint', async () => {
    let sseOpens = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : (url as URL).toString();
      if (init?.method === 'POST' && urlStr.includes('/heartbeat')) return new Response(null, { status: 204 });
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      sseOpens += 1;
      return new Response(null, { status: 403 });
    });

    const { unmount } = renderHook(() => usePresence('page-1'));
    await waitFor(() => expect(sseOpens).toBe(1));

    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(sseOpens).toBe(1);

    unmount();
  });

  it('does not open a stream when pageId is null', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    const { result } = renderHook(() => usePresence(null));
    await act(async () => { await Promise.resolve(); });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.current.viewers).toEqual([]);
  });
});
