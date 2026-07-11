import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { useClearCacheOnLogout } from './useClearCacheOnLogout';
import { useAuthStore } from '../../stores/auth-store';

function Probe() {
  useClearCacheOnLogout();
  return null;
}

function renderProbe(queryClient: QueryClient) {
  return render(
    createElement(QueryClientProvider, { client: queryClient }, createElement(Probe)),
  );
}

describe('useClearCacheOnLogout', () => {
  beforeEach(() => {
    // Start every test from a clean, logged-out store.
    useAuthStore.getState().clearAuth();
  });

  afterEach(() => {
    useAuthStore.getState().clearAuth();
  });

  it('clears cached page and permission data on logout (authenticated -> unauthenticated)', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(['pages', { page: 1 }], { items: [{ title: 'SECRET' }] });
    queryClient.setQueryData(['permissions', 'manage', 'space', 'SECRET'], { allowed: true });

    // Authenticated before the hook mounts, so the ref guard starts "was true".
    act(() => {
      useAuthStore.getState().setAuth('tok', { id: '1', username: 'a', role: 'admin' });
    });

    renderProbe(queryClient);

    // Sanity: cache is populated while the user is logged in.
    expect(queryClient.getQueryData(['pages', { page: 1 }])).toBeDefined();
    expect(queryClient.getQueryData(['permissions', 'manage', 'space', 'SECRET'])).toBeDefined();

    // Logout should wipe the in-memory cache so the next user in this tab
    // cannot read the previous user's data or cached permission results.
    act(() => {
      useAuthStore.getState().clearAuth();
    });

    expect(queryClient.getQueryData(['pages', { page: 1 }])).toBeUndefined();
    expect(queryClient.getQueryData(['permissions', 'manage', 'space', 'SECRET'])).toBeUndefined();
  });

  it('does not clear pre-existing cache when mounted while already logged out', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(['pages', { page: 1 }], { items: [{ title: 'PRELOGIN' }] });

    // The store is logged out (beforeEach) BEFORE the hook mounts, so there is
    // no authenticated -> unauthenticated transition. The ref guard starts
    // "was false", so a correct implementation must leave the cache intact.
    // A naive `if (!isAuthenticated) queryClient.clear()` on mount would wipe
    // this pre-login data and fail here — this is the case the ref guard exists
    // for (the live-session token-refresh test below does not exercise it,
    // since isAuthenticated stays true and the effect never re-runs).
    renderProbe(queryClient);

    expect(queryClient.getQueryData(['pages', { page: 1 }])).toEqual({
      items: [{ title: 'PRELOGIN' }],
    });
  });

  it('does not clear the cache on a token refresh within a live session', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(['pages', { page: 1 }], { items: [{ title: 'SECRET' }] });

    act(() => {
      useAuthStore.getState().setAuth('tok', { id: '1', username: 'a', role: 'admin' });
    });

    renderProbe(queryClient);

    // Token refresh: setAuth fires again but isAuthenticated stays true.
    act(() => {
      useAuthStore.getState().setAuth('tok2', { id: '1', username: 'a', role: 'admin' });
    });

    expect(queryClient.getQueryData(['pages', { page: 1 }])).toEqual({
      items: [{ title: 'SECRET' }],
    });
  });
});
