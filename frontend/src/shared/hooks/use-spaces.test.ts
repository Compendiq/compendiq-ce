import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { useSync, useSyncStatus } from './use-spaces';

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
