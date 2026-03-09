import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useAuthStore } from '../../stores/auth-store';
import { apiFetch } from './api';

describe('apiFetch', () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch');

  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.setState({
      accessToken: 'valid-token',
      user: { id: '1', username: 'test', role: 'user' },
      isAuthenticated: true,
    });
  });

  afterEach(() => {
    useAuthStore.getState().clearAuth();
  });

  it('sends Authorization header when accessToken is present', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    await apiFetch('/test');

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [, init] = fetchSpy.mock.calls[0];
    const headers = new Headers(init?.headers);
    expect(headers.get('Authorization')).toBe('Bearer valid-token');
  });

  it('attempts token refresh on 401 even when accessToken is null (page reload case)', async () => {
    // Simulate page reload: isAuthenticated=true but accessToken=null
    useAuthStore.setState({ accessToken: null, isAuthenticated: true });

    // First call returns 401
    fetchSpy.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));
    // Refresh call succeeds
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
      accessToken: 'refreshed-token',
      user: { id: '1', username: 'test', role: 'user' },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    // Retry with new token succeeds
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ data: 'ok' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const result = await apiFetch('/settings');

    expect(result).toEqual({ data: 'ok' });
    // 3 calls: original 401, refresh, retry
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(fetchSpy.mock.calls[1][0]).toBe('/api/auth/refresh');
    // Retry uses refreshed token
    const retryHeaders = new Headers(fetchSpy.mock.calls[2][1]?.headers);
    expect(retryHeaders.get('Authorization')).toBe('Bearer refreshed-token');
  });

  it('clears auth and throws when refresh fails and no accessToken', async () => {
    useAuthStore.setState({ accessToken: null, isAuthenticated: true });

    fetchSpy.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));
    // Refresh fails
    fetchSpy.mockResolvedValueOnce(new Response('Forbidden', { status: 403 }));

    await expect(apiFetch('/settings')).rejects.toThrow('Session expired');
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
  });

  it('refreshes token on 401 when accessToken was set but expired', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
      accessToken: 'new-token',
      user: { id: '1', username: 'test', role: 'user' },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    await apiFetch('/test');

    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });
});
