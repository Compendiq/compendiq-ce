import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockSetAuth = vi.fn();
const mockClearAuth = vi.fn();
let storeState: Record<string, unknown> = {};

vi.mock('../../stores/auth-store', () => ({
  useAuthStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) => selector(storeState),
    { getState: () => storeState },
  ),
}));

const { fetchJson, FetchJsonError } = await import('./fetch-json');

const USER = { id: '1', username: 'test', role: 'user' };

describe('fetchJson', () => {
  beforeEach(() => {
    storeState = {
      accessToken: 'valid-token',
      user: USER,
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

  it('sends the Authorization header and parses JSON', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const result = await fetchJson('/admin/thing');
    expect(result).toEqual({ ok: true });
    const headers = fetchSpy.mock.calls[0][1]?.headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer valid-token');
  });

  it('refreshes the token and retries once on 401', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ accessToken: 'new-token', user: USER }), {
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: 'ok' }), {
          headers: { 'Content-Type': 'application/json' },
        }),
      );

    const result = await fetchJson('/admin/thing');
    expect(result).toEqual({ data: 'ok' });
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/auth/refresh',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(mockSetAuth).toHaveBeenCalledWith('new-token', USER);
    const retryHeaders = fetchSpy.mock.calls[2][1]?.headers as Headers;
    expect(retryHeaders.get('Authorization')).toBe('Bearer new-token');
  });

  it('clears auth and throws FetchJsonError(401) when the refresh fails', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }))
      .mockResolvedValueOnce(new Response('Invalid', { status: 401 }));

    await expect(fetchJson('/admin/thing')).rejects.toMatchObject({
      name: 'FetchJsonError',
      status: 401,
    });
    expect(mockClearAuth).toHaveBeenCalled();
  });

  it('preserves the structured error body on failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'invalid_cidr', cidr: '10.0.0.0/8' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    try {
      await fetchJson('/admin/ip-allowlist', { method: 'PUT', body: '{}' });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(FetchJsonError);
      const fe = err as InstanceType<typeof FetchJsonError>;
      expect(fe.status).toBe(400);
      expect(fe.body).toEqual({ error: 'invalid_cidr', cidr: '10.0.0.0/8' });
    }
  });

  it('returns undefined on 204 No Content', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(null, { status: 204 }));
    const result = await fetchJson('/admin/thing', { method: 'DELETE' });
    expect(result).toBeUndefined();
  });

  it('sets Content-Type when a body is present', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 204 }),
    );
    await fetchJson('/admin/thing', { method: 'POST', body: JSON.stringify({ a: 1 }) });
    const headers = fetchSpy.mock.calls[0][1]?.headers as Headers;
    expect(headers.get('Content-Type')).toBe('application/json');
  });
});
