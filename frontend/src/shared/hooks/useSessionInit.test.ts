import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const mockSetAuth = vi.fn();
const mockClearAuth = vi.fn();
let storeState: Record<string, unknown> = {};

vi.mock('../../stores/auth-store', () => ({
  useAuthStore: (selector: (s: Record<string, unknown>) => unknown) => selector(storeState),
}));

const { useSessionInit } = await import('./useSessionInit');

describe('useSessionInit', () => {
  beforeEach(() => {
    mockSetAuth.mockClear();
    mockClearAuth.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('attempts refresh when authenticated but no access token (after reload)', async () => {
    storeState = {
      isAuthenticated: true,
      accessToken: null,
      setAuth: mockSetAuth,
      clearAuth: mockClearAuth,
    };

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ accessToken: 'new-token', user: { id: '1', username: 'test', role: 'user' } }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
    );

    renderHook(() => useSessionInit());

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith('/api/auth/refresh', expect.objectContaining({
        method: 'POST',
        credentials: 'include',
      }));
    });

    await waitFor(() => {
      expect(mockSetAuth).toHaveBeenCalledWith('new-token', { id: '1', username: 'test', role: 'user' });
    });
  });

  it('clears auth when refresh fails (expired session)', async () => {
    storeState = {
      isAuthenticated: true,
      accessToken: null,
      setAuth: mockSetAuth,
      clearAuth: mockClearAuth,
    };

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Unauthorized', { status: 401 }),
    );

    renderHook(() => useSessionInit());

    await waitFor(() => {
      expect(mockClearAuth).toHaveBeenCalled();
    });
  });

  it('clears auth on network error during refresh', async () => {
    storeState = {
      isAuthenticated: true,
      accessToken: null,
      setAuth: mockSetAuth,
      clearAuth: mockClearAuth,
    };

    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network error'));

    renderHook(() => useSessionInit());

    await waitFor(() => {
      expect(mockClearAuth).toHaveBeenCalled();
    });
  });

  it('does not attempt refresh when already has access token', () => {
    storeState = {
      isAuthenticated: true,
      accessToken: 'existing-token',
      setAuth: mockSetAuth,
      clearAuth: mockClearAuth,
    };

    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    renderHook(() => useSessionInit());

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not attempt refresh when not authenticated', () => {
    storeState = {
      isAuthenticated: false,
      accessToken: null,
      setAuth: mockSetAuth,
      clearAuth: mockClearAuth,
    };

    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    renderHook(() => useSessionInit());

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
