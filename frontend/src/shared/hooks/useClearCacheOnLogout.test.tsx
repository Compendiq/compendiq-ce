import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { useClearCacheOnLogout } from './useClearCacheOnLogout';
import { useAuthStore } from '../../stores/auth-store';
import { useUiStore } from '../../stores/ui-store';
import { logoutApi } from '../lib/api';

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

  // The remembered New Page space lives in localStorage, not the query cache,
  // so `queryClient.clear()` would leave the previous user's space key behind
  // for whoever logs in next in the same tab (#1122).
  it('forgets remembered Confluence and Library spaces on logout', () => {
    localStorage.setItem('compendiq:last-confluence-space', 'DEV');
    localStorage.setItem('compendiq:library-recent-spaces', '["DEV","OPS"]');

    act(() => {
      useAuthStore.getState().setAuth('tok', { id: '1', username: 'a', role: 'admin' });
    });
    renderProbe(new QueryClient());
    expect(localStorage.getItem('compendiq:last-confluence-space')).toBe('DEV');
    expect(localStorage.getItem('compendiq:library-recent-spaces')).toBe('["DEV","OPS"]');

    act(() => {
      useAuthStore.getState().clearAuth();
    });

    expect(localStorage.getItem('compendiq:last-confluence-space')).toBeNull();
    expect(localStorage.getItem('compendiq:library-recent-spaces')).toBeNull();
  });

  // The sidebar tree's selected space is persisted in `compendiq-ui`, which is
  // shared by every account in the browser.
  it("does not start the next account in the previous account's sidebar space", async () => {
    act(() => {
      useAuthStore.getState().setAuth('tok-a', { id: 'user-a', username: 'alice', role: 'user' });
    });
    renderProbe(new QueryClient());
    act(() => {
      useUiStore.getState().setTreeSidebarSpaceKey('ALICE-PRIVATE');
    });
    expect(localStorage.getItem('compendiq-ui')).toContain('ALICE-PRIVATE');

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    await act(async () => {
      await logoutApi();
    });
    vi.restoreAllMocks();
    act(() => {
      useAuthStore.getState().setAuth('tok-b', { id: 'user-b', username: 'bob', role: 'user' });
    });

    expect(useUiStore.getState().treeSidebarSpaceKey).toBeUndefined();
    expect(localStorage.getItem('compendiq-ui')).not.toContain('ALICE-PRIVATE');
  });
});
