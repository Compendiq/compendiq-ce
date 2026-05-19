import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { useSync, useSyncStatus, useForceResyncAll } from './use-spaces';

// Mock auth store
vi.mock('../../stores/auth-store', () => ({
  useAuthStore: Object.assign(
    () => ({ accessToken: 'test-token' }),
    {
      getState: () => ({ accessToken: 'test-token', setAuth: vi.fn(), clearAuth: vi.fn() }),
    },
  ),
}));

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

describe('useSync', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ message: 'Sync started', status: { userId: 'u1', status: 'syncing' } }), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should call POST /api/sync on mutate', async () => {
    const { result } = renderHook(() => useSync(), { wrapper: createWrapper() });

    await act(async () => {
      result.current.mutate();
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/sync',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('should invalidate sync status query on success', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });

    // Pre-populate sync status cache with 'idle'
    queryClient.setQueryData(['sync', 'status'], { userId: 'u1', status: 'idle' });

    const wrapper = ({ children }: { children: React.ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);

    const { result } = renderHook(() => useSync(), { wrapper });

    await act(async () => {
      result.current.mutate();
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // After mutation success, the sync status query should be invalidated
    const syncStatusState = queryClient.getQueryState(['sync', 'status']);
    expect(syncStatusState?.isInvalidated).toBe(true);
  });
});

describe('useSyncStatus', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should poll every 2s when status is syncing', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ userId: 'u1', status: 'syncing', progress: { current: 1, total: 5, space: 'DEV' } }), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const { result } = renderHook(() => useSyncStatus(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.data?.status).toBe('syncing'));
    expect(result.current.data?.progress?.space).toBe('DEV');
  });

  it('should not poll when status is idle', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ userId: 'u1', status: 'idle' }), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const { result } = renderHook(() => useSyncStatus(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.data?.status).toBe('idle'));
  });
});

describe('useForceResyncAll', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ succeeded: 42, failed: 0, errors: [] }), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('posts /pages/bulk/sync with confluence filter and the caller-supplied expectedCount', async () => {
    const { result } = renderHook(() => useForceResyncAll(), { wrapper: createWrapper() });

    await act(async () => {
      result.current.mutate(123);
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/pages/bulk/sync',
      expect.objectContaining({
        method: 'POST',
        body: expect.any(String),
      }),
    );

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const body = JSON.parse((call[1] as RequestInit).body as string);
    // Filter mode must declare itself with both `filter` and `expectedCount`;
    // the server's BulkIdsOrFilterSchema refuses requests that mix or omit
    // either, so this is the wire contract this hook commits to.
    expect(body).toEqual({
      filter: { source: 'confluence' },
      expectedCount: 123,
      driftToleranceFraction: 1,
    });
  });

  it('invalidates sync, embeddings, and pages caches on success', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    queryClient.setQueryData(['settings', 'sync-overview'], { sync: { status: 'idle' } });
    queryClient.setQueryData(['embeddings'], { count: 0 });
    queryClient.setQueryData(['pages'], []);

    const wrapper = ({ children }: { children: React.ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);

    const { result } = renderHook(() => useForceResyncAll(), { wrapper });

    await act(async () => {
      result.current.mutate(5);
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(queryClient.getQueryState(['settings', 'sync-overview'])?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(['embeddings'])?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(['pages'])?.isInvalidated).toBe(true);
  });

  it('surfaces the server result for the caller', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ succeeded: 10, failed: 2, errors: ['Page 7 not found'] }), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const { result } = renderHook(() => useForceResyncAll(), { wrapper: createWrapper() });

    await act(async () => {
      result.current.mutate(12);
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual({
      succeeded: 10,
      failed: 2,
      errors: ['Page 7 not found'],
    });
  });
});
