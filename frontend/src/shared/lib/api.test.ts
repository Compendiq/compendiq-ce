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
const { apiFetch, logoutApi, ApiError } = await import('./api');

/** Build a JWT whose payload carries the given `exp` (seconds since epoch). */
function makeJwt(exp: number): string {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = btoa(JSON.stringify({ exp }));
  return `${header}.${payload}.sig`;
}

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

  it('proactively refreshes an already-expired JWT before firing the request', async () => {
    // Token expired 60s ago — the "401 storm" scenario on session resume.
    storeState.accessToken = makeJwt(Math.floor(Date.now() / 1000) - 60);

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (input: string | URL | Request) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url === '/api/auth/refresh') {
          return new Response(
            JSON.stringify({
              accessToken: 'fresh-token',
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

    const result = await apiFetch('/data');

    expect(result).toEqual({ ok: true });
    // The FIRST network call must be the proactive refresh, not /api/data.
    expect(fetchSpy.mock.calls[0][0]).toBe('/api/auth/refresh');
    // /api/data must be fetched exactly once, carrying the refreshed token.
    const dataCalls = fetchSpy.mock.calls.filter((c) => c[0] === '/api/data');
    expect(dataCalls).toHaveLength(1);
    expect((dataCalls[0][1]?.headers as Headers).get('Authorization')).toBe('Bearer fresh-token');
    // Auth store received the fresh token.
    expect(mockSetAuth).toHaveBeenCalledWith('fresh-token', { id: '1', username: 'test', role: 'user' });
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

  // ── Response decoding: what the user is left holding when it goes wrong ────
  // Every call in the app goes through here, so these cover the ordinary
  // successes as well as the failures that produced an undiagnosable toast
  // (#1178).

  describe('success path', () => {
    it('returns the parsed body for a JSON response', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ id: 7, title: 'Page' }), {
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      await expect(apiFetch('/pages/7')).resolves.toEqual({ id: 7, title: 'Page' });
    });

    it('resolves to undefined when the response is not JSON', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('plain text', { headers: { 'Content-Type': 'text/plain' } }),
      );

      await expect(apiFetch('/thing')).resolves.toBeUndefined();
    });

    it('resolves to undefined for a 204, which carries no body to parse', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(null, { status: 204, headers: { 'Content-Type': 'application/json' } }),
      );

      await expect(apiFetch('/pages/7')).resolves.toBeUndefined();
    });

    it('reports an empty JSON body as an ApiError, not a raw SyntaxError', async () => {
      // A 200 that promises JSON and delivers nothing. `res.json()` rejects
      // with a SyntaxError that is not an ApiError, so every caller's
      // `err instanceof ApiError` check misses and the toast shows a parser
      // message — or nothing at all.
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('', { status: 200, headers: { 'Content-Type': 'application/json' } }),
      );

      const err = await apiFetch('/pages/7').catch((e) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect(err.statusCode).toBe(200);
      expect(err.message).toMatch(/empty|malformed/i);
    });

    it('reports a malformed JSON body as an ApiError', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('<html>oops</html>', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      await expect(apiFetch('/pages/7')).rejects.toBeInstanceOf(ApiError);
    });
  });

  describe('error path', () => {
    it("surfaces the backend's own message verbatim", async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ message: 'Markdown too large (max ~1MB)' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const err = await apiFetch('/pages/import/preview').catch((e) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect(err.statusCode).toBe(400);
      expect(err.message).toBe('Markdown too large (max ~1MB)');
    });

    it('names the status when the error body is JSON without a message', async () => {
      // The one branch that could ever emit the bare 'Request failed' — which
      // took a full code audit to identify, because the string named nothing.
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ error: 'Bad Gateway' }), {
          status: 502,
          statusText: '',
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const err = await apiFetch('/pages').catch((e) => e);
      expect(err.message).toContain('502');
    });

    it('names the status for an HTML error page from the edge proxy', async () => {
      // What nginx returns above client_max_body_size: an HTML 413 that
      // Fastify never saw, so none of the app's error contract applies.
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('<html><body><center>nginx</center></body></html>', {
          status: 413,
          statusText: 'Request Entity Too Large',
          headers: { 'Content-Type': 'text/html' },
        }),
      );

      const err = await apiFetch('/pages/import/preview').catch((e) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect(err.statusCode).toBe(413);
      expect(err.message).toContain('413');
      expect(err.message).toContain('Request Entity Too Large');
    });

    it('names the status when there is no body and no reason phrase', async () => {
      // HTTP/2 has no reason phrase, so statusText is always '' — and the old
      // `body.message ?? …` let that empty string through as the message.
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(null, { status: 500, statusText: '' }),
      );

      const err = await apiFetch('/pages').catch((e) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect(err.message.trim().length).toBeGreaterThan(0);
      expect(err.message).toContain('500');
    });
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
