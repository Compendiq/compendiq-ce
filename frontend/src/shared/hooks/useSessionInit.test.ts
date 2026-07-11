import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const mockSetAuth = vi.fn();
const mockClearAuth = vi.fn();
let storeState: Record<string, unknown> = {};

vi.mock('../../stores/auth-store', () => ({
  useAuthStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) => selector(storeState),
    {
      // refreshAccessTokenOnce (via useSessionInit) reads the store imperatively.
      getState: () => storeState,
    },
  ),
}));

const { useSessionInit } = await import('./useSessionInit');
const { refreshAccessTokenOnce } = await import('../lib/api');

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

  // Regression for #884: the hook must route its refresh through the shared
  // refreshAccessTokenOnce() single-flight helper, so that a refresh already
  // in flight (e.g. apiFetch's reactive 401 refresh for a mounted query) is
  // reused rather than duplicated. A duplicate /auth/refresh presents an
  // already-rotated (revoked) JTI, tripping the backend's token-family reuse
  // detection and forcibly logging the user out.
  it('joins the in-flight refresh instead of firing a duplicate /auth/refresh', async () => {
    storeState = {
      isAuthenticated: true,
      accessToken: null,
      setAuth: mockSetAuth,
      clearAuth: mockClearAuth,
    };

    let refreshCallCount = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (input: string | URL | Request) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url === '/api/auth/refresh') {
          refreshCallCount++;
          // Hold the refresh open so both callers overlap in flight.
          await new Promise((r) => setTimeout(r, 10));
          return new Response(
            JSON.stringify({
              accessToken: 'new-token',
              user: { id: '1', username: 'test', role: 'user' },
            }),
            { headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response(JSON.stringify({ ok: true }), {
          headers: { 'Content-Type': 'application/json' },
        });
      },
    );

    // A competing refresh (as apiFetch would kick off on a 401) is already in
    // flight when the hook mounts.
    void refreshAccessTokenOnce();
    renderHook(() => useSessionInit());

    await waitFor(() => {
      expect(mockSetAuth).toHaveBeenCalledWith('new-token', {
        id: '1',
        username: 'test',
        role: 'user',
      });
    });

    // Both paths shared one refresh — not two racing rotations.
    expect(refreshCallCount).toBe(1);
  });
});
