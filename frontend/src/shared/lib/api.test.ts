import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockSetAuth = vi.fn();
const mockClearAuth = vi.fn();
let storeState: Record<string, unknown> = {};

vi.mock('../../stores/auth-store', () => ({
  useAuthStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) => selector(storeState),
    {
      getState: () => storeState,
    },
  ),
}));

// Import after mocks are set up
const { apiFetch, logoutApi } = await import('./api');

describe('apiFetch', () => {
  beforeEach(() => {
    storeState = {
      accessToken: 'valid-token',
      user: { id: '1', username: 'test', role: 'user' },
      isAuthenticated: true,
      setAuth: mockSetAuth,
      clearAuth: mockClearAuth,
    };
    mockSetAuth.mockClear();
    mockClearAuth.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends Authorization header when access token exists', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await apiFetch('/test');

    expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/test',
      expect.objectContaining({
        headers: expect.any(Headers),
      }),
    );
    const call = vi.mocked(globalThis.fetch).mock.calls[0];
    const headers = call[1]?.headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer valid-token');
  });

  it('attempts token refresh on 401 even when accessToken is null', async () => {
    storeState.accessToken = null;

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      // First call: 401 (no token sent)
      .mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }))
      // Refresh call: success
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ accessToken: 'new-token', user: { id: '1', username: 'test', role: 'user' } }),
          { headers: { 'Content-Type': 'application/json' } },
        ),
      )
      // Retry call: success
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: 'ok' }), {
          headers: { 'Content-Type': 'application/json' },
        }),
      );

    const result = await apiFetch('/test');

    expect(result).toEqual({ data: 'ok' });
    // Should have called refresh endpoint
    expect(fetchSpy).toHaveBeenCalledWith('/api/auth/refresh', expect.objectContaining({ method: 'POST' }));
    // Should have set auth with new token
    expect(mockSetAuth).toHaveBeenCalledWith('new-token', { id: '1', username: 'test', role: 'user' });
  });

  it('clears auth and throws when refresh fails on 401', async () => {
    storeState.accessToken = null;

    vi.spyOn(globalThis, 'fetch')
      // First call: 401
      .mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }))
      // Refresh call: fail
      .mockResolvedValueOnce(new Response('Invalid', { status: 401 }));

    await expect(apiFetch('/test')).rejects.toThrow('Session expired');
    expect(mockClearAuth).toHaveBeenCalled();
  });

  it('deduplicates concurrent refresh calls on multiple 401s', async () => {
    storeState.accessToken = 'expired-token';

    let refreshCallCount = 0;
    // Track per-path call counts to distinguish initial vs retry calls
    const callCounts = new Map<string, number>();

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

      if (url === '/api/auth/refresh') {
        refreshCallCount++;
        await new Promise((r) => setTimeout(r, 10));
        // Update store so retry calls pick up the new token
        storeState.accessToken = 'refreshed-token';
        return new Response(
          JSON.stringify({ accessToken: 'refreshed-token', user: { id: '1', username: 'test', role: 'user' } }),
          { headers: { 'Content-Type': 'application/json' } },
        );
      }

      // Track call count per path
      const count = (callCounts.get(url) ?? 0) + 1;
      callCounts.set(url, count);

      // First call to each path returns 401; retry (count 2) succeeds
      if (count === 1) {
        return new Response('Unauthorized', { status: 401 });
      }

      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    });

    // Fire 5 concurrent requests — all will get 401 and try to refresh
    const results = await Promise.all([
      apiFetch('/a'),
      apiFetch('/b'),
      apiFetch('/c'),
      apiFetch('/d'),
      apiFetch('/e'),
    ]);

    // All should succeed
    results.forEach((r) => expect(r).toEqual({ ok: true }));

    // Only ONE refresh call should have been made (deduplication)
    expect(refreshCallCount).toBe(1);
  });

  it('attempts refresh on 401 when accessToken exists but expired', async () => {
    storeState.accessToken = 'expired-token';

    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ accessToken: 'refreshed', user: { id: '1', username: 'test', role: 'user' } }),
          { headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ result: 'success' }), {
          headers: { 'Content-Type': 'application/json' },
        }),
      );

    const result = await apiFetch('/data');
    expect(result).toEqual({ result: 'success' });
    expect(mockSetAuth).toHaveBeenCalledWith('refreshed', expect.any(Object));
  });
});

describe('logoutApi', () => {
  beforeEach(() => {
    storeState = {
      accessToken: 'my-token',
      user: { id: '1', username: 'test', role: 'user' },
      isAuthenticated: true,
      setAuth: mockSetAuth,
      clearAuth: mockClearAuth,
    };
    mockSetAuth.mockClear();
    mockClearAuth.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls backend logout and clears auth', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ message: 'Logged out' }), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await logoutApi();

    expect(fetchSpy).toHaveBeenCalledWith('/api/auth/logout', expect.objectContaining({
      method: 'POST',
      credentials: 'include',
      headers: { Authorization: 'Bearer my-token' },
    }));
    expect(mockClearAuth).toHaveBeenCalled();
  });

  it('clears auth even when backend call fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network error'));

    await logoutApi();

    expect(mockClearAuth).toHaveBeenCalled();
  });

  it('sends request without Authorization when no token', async () => {
    storeState.accessToken = null;

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ message: 'Logged out' }), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await logoutApi();

    expect(fetchSpy).toHaveBeenCalledWith('/api/auth/logout', expect.objectContaining({
      method: 'POST',
      credentials: 'include',
      headers: {},
    }));
    expect(mockClearAuth).toHaveBeenCalled();
  });
});
