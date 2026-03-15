import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { usePermission } from './use-permission';
import { useAuthStore } from '../../stores/auth-store';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

describe('usePermission', () => {
  beforeEach(() => {
    useAuthStore.getState().setAuth('test-token', {
      id: '1',
      username: 'testuser',
      role: 'user',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    useAuthStore.getState().clearAuth();
  });

  it('should return allowed=true when permission check succeeds', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ allowed: true }), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const { result } = renderHook(
      () => usePermission('edit', 'space', 'DEV'),
      { wrapper: createWrapper() },
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.allowed).toBe(true);
  });

  it('should return allowed=false when permission is denied', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ allowed: false }), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const { result } = renderHook(
      () => usePermission('delete', 'space', 'DEV'),
      { wrapper: createWrapper() },
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.allowed).toBe(false);
  });

  it('should default to allowed=false while loading', () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {})); // never resolves

    const { result } = renderHook(
      () => usePermission('read', 'space', 'DEV'),
      { wrapper: createWrapper() },
    );

    expect(result.current.allowed).toBe(false);
    expect(result.current.loading).toBe(true);
  });
});
