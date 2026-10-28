import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useAuthStore } from '../../stores/auth-store';
import { useSessionInit } from '../hooks/useSessionInit';
import { apiFetch, refreshAccessTokenOnce, RefreshUnavailableError } from './api';

const USER = { id: '00000000-0000-4000-8000-000000000001', username: 'alice', role: 'user' as const };
const SUCCESS = { accessToken: 'synthetic-new-token', user: USER };

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
}

// Only synthetic responses: no request ever reaches a refresh-cookie endpoint.
const invalidSuccesses: [string, () => Response][] = [
  ['invalid JSON', () => new Response('{', { status: 200 })],
  ['empty body', () => new Response('', { status: 200 })],
  ['unreadable body', () => new Response(new ReadableStream({
    start(controller) { controller.error(new TypeError('synthetic body read failure')); },
  }), { status: 200 })],
  ['null body', () => json(null)],
  ['array body', () => json([])],
  ['string body', () => json('success')],
  ['number body', () => json(1)],
  ['boolean body', () => json(true)],
  ['empty object', () => json({})],
  ['missing token', () => json({ user: USER })],
  ['numeric token', () => json({ ...SUCCESS, accessToken: 42 })],
  ['null token', () => json({ ...SUCCESS, accessToken: null })],
  ['empty token', () => json({ ...SUCCESS, accessToken: '' })],
  ['blank token', () => json({ ...SUCCESS, accessToken: ' \t\n' })],
  ['missing user', () => json({ accessToken: SUCCESS.accessToken })],
  ['null user', () => json({ ...SUCCESS, user: null })],
  ['empty user', () => json({ ...SUCCESS, user: {} })],
  ['invalid user ID', () => json({ ...SUCCESS, user: { ...USER, id: 'not-a-uuid' } })],
  ['invalid username', () => json({ ...SUCCESS, user: { ...USER, username: 42 } })],
  ['invalid role', () => json({ ...SUCCESS, user: { ...USER, role: 'owner' } })],
  ['invalid optional email', () => json({ ...SUCCESS, user: { ...USER, email: 'invalid' } })],
  ['invalid optional display name', () => json({ ...SUCCESS, user: { ...USER, displayName: 42 } })],
];

beforeEach(() => {
  vi.useFakeTimers();
  useAuthStore.getState().setAuth('synthetic-existing-token', USER);
});

afterEach(() => {
  vi.useRealTimers();
  useAuthStore.getState().clearAuth();
});

describe.each(['direct', 'reactive', 'proactive'] as const)('%s refresh success validation', (entry) => {
  it.each(invalidSuccesses)('preserves auth without retrying after %s', async (_label, response) => {
    if (entry === 'proactive') {
      const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) - 60 }));
      useAuthStore.getState().setAuth(`synthetic.${payload}.signature`, USER);
    }
    const before = useAuthStore.getState();
    const persistedBefore = localStorage.getItem('compendiq-auth');
    const mutations = vi.fn();
    const unsubscribe = useAuthStore.subscribe(mutations);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (input === '/api/auth/refresh') return response();
      if (input === '/api/fixture') return new Response(null, { status: 401 });
      throw new Error(`Unexpected synthetic request: ${String(input)}`);
    });

    try {
      const result = entry === 'direct' ? refreshAccessTokenOnce() : apiFetch('/fixture');
      await expect(result).rejects.toBeInstanceOf(RefreshUnavailableError);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(useAuthStore.getState()).toBe(before);
      expect(localStorage.getItem('compendiq-auth')).toBe(persistedBefore);
      expect(mutations).not.toHaveBeenCalled();
      expect(fetchSpy.mock.calls.filter(([url]) => url === '/api/auth/refresh')).toHaveLength(1);
      // The reactive caller may make its initial request, but never replays it.
      expect(fetchSpy).toHaveBeenCalledTimes(entry === 'reactive' ? 2 : 1);
    } finally {
      unsubscribe();
    }
  });
});

describe('refresh result classification', () => {
  it.each([
    USER,
    { ...USER, email: null, displayName: null },
    { ...USER, role: 'admin' as const, email: 'alice@example.test', displayName: 'Alice' },
  ])('adopts a valid response with user %j', async (user) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ ...SUCCESS, user }));
    await expect(refreshAccessTokenOnce()).resolves.toBe(SUCCESS.accessToken);
    expect(useAuthStore.getState()).toMatchObject({ ...SUCCESS, user, isAuthenticated: true });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403])('reserves null for definite session loss (%s)', async (status) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status }));
    await expect(refreshAccessTokenOnce()).resolves.toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403])('still clears auth when the caller receives definite session loss (%s)', async (status) => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
      new Response(null, { status: input === '/api/auth/refresh' ? status : 401 }),
    );
    await expect(apiFetch('/fixture')).rejects.toMatchObject({ statusCode: 401, message: 'Session expired' });
    expect(useAuthStore.getState()).toMatchObject({ accessToken: null, user: null, isAuthenticated: false });
  });

  it('shares an invalid success rejection between concurrent callers', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({}));
    const before = useAuthStore.getState();
    const first = refreshAccessTokenOnce();
    const second = refreshAccessTokenOnce();
    expect(second).toBe(first);
    await expect(first).rejects.toBeInstanceOf(RefreshUnavailableError);
    await expect(second).rejects.toBeInstanceOf(RefreshUnavailableError);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState()).toBe(before);
  });

  it('keeps a restored session on an unreadable success rather than logging out', async () => {
    useAuthStore.setState({ accessToken: null });
    const before = useAuthStore.getState();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{', { status: 200 }));
    renderHook(() => useSessionInit());
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(useAuthStore.getState()).toBe(before);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
