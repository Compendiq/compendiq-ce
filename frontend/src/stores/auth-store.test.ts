import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import { useAuthStore } from './auth-store';

// BroadcastChannel instances created by individual tests. Closed in afterEach
// so a stray async message can't leak into the next test.
const channels: BroadcastChannel[] = [];

describe('auth-store', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    // Reset via setState (not clearAuth) so the reset never broadcasts.
    useAuthStore.setState({
      accessToken: null,
      user: null,
      isAuthenticated: false,
    });
  });

  afterEach(() => {
    while (channels.length) channels.pop()?.close();
    localStorage.clear();
    sessionStorage.clear();
    useAuthStore.setState({
      accessToken: null,
      user: null,
      isAuthenticated: false,
    });
  });

  it('keeps the access token in memory only, never in the persisted blob', () => {
    useAuthStore.getState().setAuth('test-token-123', {
      id: '1',
      username: 'alice',
      role: 'user',
    });

    // In memory.
    expect(useAuthStore.getState().accessToken).toBe('test-token-123');

    // Absent from the persisted localStorage blob; only non-sensitive state persists.
    const stored = JSON.parse(localStorage.getItem('compendiq-auth') || '{}');
    expect(stored.state.accessToken).toBeUndefined();
    expect(stored.state.isAuthenticated).toBe(true);
    expect(stored.state.user.username).toBe('alice');
  });

  it('never writes the access or refresh token to localStorage OR sessionStorage', () => {
    const secret = 'super-secret-access-token-xyz';
    useAuthStore.getState().setAuth(secret, {
      id: '1',
      username: 'alice',
      role: 'user',
    });

    const scan = (storage: Storage) => {
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (key === null) continue;
        expect(storage.getItem(key) ?? '').not.toContain(secret);
      }
    };
    scan(localStorage);
    scan(sessionStorage);

    // Sanity: the token IS available in memory for API calls.
    expect(useAuthStore.getState().accessToken).toBe(secret);
  });

  it('clears in-memory token and persists only logged-out non-sensitive state on logout', () => {
    useAuthStore.getState().setAuth('test-token-123', {
      id: '1',
      username: 'alice',
      role: 'user',
    });

    useAuthStore.getState().clearAuth();

    expect(useAuthStore.getState().accessToken).toBeNull();
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(useAuthStore.getState().user).toBeNull();

    const stored = JSON.parse(localStorage.getItem('compendiq-auth') || '{}');
    expect(stored.state.accessToken).toBeUndefined();
    expect(stored.state.isAuthenticated).toBe(false);
    expect(stored.state.user).toBeNull();
  });

  it('broadcasts the token to other tabs on setAuth (in-memory, not via storage)', async () => {
    const peer = new BroadcastChannel('compendiq-auth');
    channels.push(peer);
    const received: Array<Record<string, unknown>> = [];
    peer.onmessage = (e: MessageEvent) => received.push(e.data);

    useAuthStore.getState().setAuth('broadcast-me', {
      id: '1',
      username: 'alice',
      role: 'user',
    });

    await waitFor(() => expect(received.length).toBeGreaterThan(0));
    expect(received[0]).toEqual({
      type: 'token',
      accessToken: 'broadcast-me',
      user: { id: '1', username: 'alice', role: 'user' },
    });
  });

  it('broadcasts logout to other tabs on clearAuth', async () => {
    useAuthStore.getState().setAuth('a-token', {
      id: '1',
      username: 'alice',
      role: 'user',
    });

    // Attach the peer listener AFTER setAuth so it only observes the logout.
    const peer = new BroadcastChannel('compendiq-auth');
    channels.push(peer);
    const received: Array<Record<string, unknown>> = [];
    peer.onmessage = (e: MessageEvent) => received.push(e.data);

    useAuthStore.getState().clearAuth();

    await waitFor(() =>
      expect(received.some((m) => m?.type === 'logout')).toBe(true),
    );
  });

  it('does NOT broadcast logout when already unauthenticated (no storm)', async () => {
    // Already logged out from beforeEach.
    const peer = new BroadcastChannel('compendiq-auth');
    channels.push(peer);
    const received: Array<Record<string, unknown>> = [];
    peer.onmessage = (e: MessageEvent) => received.push(e.data);

    useAuthStore.getState().clearAuth();

    // Give any (unexpected) message time to arrive.
    await new Promise((r) => setTimeout(r, 20));
    expect(received).toEqual([]);
  });

  it('adopts a token broadcast from another tab via BroadcastChannel (not storage)', async () => {
    expect(useAuthStore.getState().isAuthenticated).toBe(false);

    const peer = new BroadcastChannel('compendiq-auth');
    channels.push(peer);
    peer.postMessage({
      type: 'token',
      accessToken: 'peer-token',
      user: { id: '2', username: 'bob', role: 'user' },
    });

    await waitFor(() =>
      expect(useAuthStore.getState().accessToken).toBe('peer-token'),
    );
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    expect(useAuthStore.getState().user?.username).toBe('bob');

    // Adopted in memory only — the token never lands in storage.
    const stored = JSON.parse(localStorage.getItem('compendiq-auth') || '{}');
    expect(stored.state?.accessToken).toBeUndefined();
  });

  it('adopts a logout broadcast from another tab via BroadcastChannel', async () => {
    useAuthStore.getState().setAuth('my-token', {
      id: '1',
      username: 'alice',
      role: 'user',
    });
    expect(useAuthStore.getState().isAuthenticated).toBe(true);

    const peer = new BroadcastChannel('compendiq-auth');
    channels.push(peer);
    peer.postMessage({ type: 'logout' });

    await waitFor(() =>
      expect(useAuthStore.getState().isAuthenticated).toBe(false),
    );
    expect(useAuthStore.getState().accessToken).toBeNull();
  });

  it('syncs logout across tabs via storage event (fallback path)', () => {
    // Simulate being logged in
    useAuthStore.getState().setAuth('my-token', {
      id: '1',
      username: 'alice',
      role: 'user',
    });

    expect(useAuthStore.getState().isAuthenticated).toBe(true);

    // Simulate another tab clearing localStorage (logout)
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'compendiq-auth',
        newValue: null,
      }),
    );

    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(useAuthStore.getState().accessToken).toBeNull();
  });

  it('syncs explicit logout (isAuthenticated=false) across tabs via storage event', () => {
    useAuthStore.getState().setAuth('my-token', {
      id: '1',
      username: 'alice',
      role: 'user',
    });

    // Simulate another tab setting isAuthenticated to false
    const loggedOutState = {
      state: {
        user: null,
        isAuthenticated: false,
      },
      version: 1,
    };
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'compendiq-auth',
        newValue: JSON.stringify(loggedOutState),
      }),
    );

    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(useAuthStore.getState().accessToken).toBeNull();
  });

  it('does NOT adopt a token from a storage event (token never travels via storage)', () => {
    // A malicious/legacy blob carrying a token in storage must be ignored:
    // token adoption only happens over the in-memory BroadcastChannel.
    expect(useAuthStore.getState().isAuthenticated).toBe(false);

    const blobWithToken = {
      state: {
        accessToken: 'token-from-storage',
        user: { id: '1', username: 'alice', role: 'user' },
        isAuthenticated: true,
      },
      version: 1,
    };
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'compendiq-auth',
        newValue: JSON.stringify(blobWithToken),
      }),
    );

    // isAuthenticated=true → no clearAuth, but the token is NOT adopted.
    expect(useAuthStore.getState().accessToken).toBeNull();
  });

  it('ignores storage events for unrelated keys', () => {
    useAuthStore.getState().setAuth('my-token', {
      id: '1',
      username: 'alice',
      role: 'user',
    });

    // Simulate storage event for a different key
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'some-other-key',
        newValue: null,
      }),
    );

    // Should not affect auth state
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    expect(useAuthStore.getState().accessToken).toBe('my-token');
  });

  it('handles malformed storage event values gracefully', () => {
    useAuthStore.getState().setAuth('my-token', {
      id: '1',
      username: 'alice',
      role: 'user',
    });

    // Simulate malformed JSON in storage event
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'compendiq-auth',
        newValue: 'not-valid-json{{{',
      }),
    );

    // Should not crash or change state
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    expect(useAuthStore.getState().accessToken).toBe('my-token');
  });

  it('scrubs a legacy persisted access token on rehydrate (upgrade path)', async () => {
    // Simulate an older install that persisted the token at version 0.
    localStorage.setItem(
      'compendiq-auth',
      JSON.stringify({
        state: {
          accessToken: 'legacy-on-disk-token',
          user: { id: '1', username: 'alice', role: 'user' },
          isAuthenticated: true,
        },
        version: 0,
      }),
    );

    await useAuthStore.persist.rehydrate();

    // User stays logged in (token is re-minted from the refresh cookie later)...
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    expect(useAuthStore.getState().user?.username).toBe('alice');
    // ...but the legacy token is gone from memory...
    expect(useAuthStore.getState().accessToken).toBeNull();
    // ...and scrubbed from storage on the migration write-back.
    const stored = JSON.parse(localStorage.getItem('compendiq-auth') || '{}');
    expect(stored.version).toBe(1);
    expect(stored.state.accessToken).toBeUndefined();
    expect(stored.state.isAuthenticated).toBe(true);
    expect(stored.state.user.username).toBe('alice');
  });
});

// The storage-event LOGIN fallback only activates when BroadcastChannel is
// unavailable (e.g. Safari < 15.4). We re-import the store with the global
// removed so its module-level `authChannel` is null and the fallback branch runs.
describe('auth-store — storage login-sync fallback (BroadcastChannel unavailable)', () => {
  const originalBC = globalThis.BroadcastChannel;

  afterEach(() => {
    globalThis.BroadcastChannel = originalBC;
    vi.resetModules();
    localStorage.clear();
  });

  it('propagates cross-tab LOGIN via the storage event (no token) when BroadcastChannel is unavailable', async () => {
    // @ts-expect-error deliberately unset for the no-BroadcastChannel scenario
    globalThis.BroadcastChannel = undefined;
    vi.resetModules();
    const { useAuthStore: freshStore } = await import('./auth-store');

    // Fresh tab starts logged out.
    freshStore.setState({ accessToken: null, user: null, isAuthenticated: false });

    const user = { id: '7', username: 'carol', role: 'user' as const };
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'compendiq-auth',
        newValue: JSON.stringify({ state: { user, isAuthenticated: true }, version: 1 }),
      }),
    );

    await waitFor(() => expect(freshStore.getState().isAuthenticated).toBe(true));
    expect(freshStore.getState().user).toEqual(user);
    // Login sync carries only user + isAuthenticated — the token stays null and
    // is re-minted from the HttpOnly refresh cookie.
    expect(freshStore.getState().accessToken).toBeNull();
  });

  it('does NOT re-adopt when already authenticated (no clobber of the current token)', async () => {
    // @ts-expect-error deliberately unset for the no-BroadcastChannel scenario
    globalThis.BroadcastChannel = undefined;
    vi.resetModules();
    const { useAuthStore: freshStore } = await import('./auth-store');

    freshStore.setState({
      accessToken: 'live-token',
      user: { id: '1', username: 'alice', role: 'user' },
      isAuthenticated: true,
    });

    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'compendiq-auth',
        newValue: JSON.stringify({
          state: { user: { id: '2', username: 'bob', role: 'user' }, isAuthenticated: true },
          version: 1,
        }),
      }),
    );

    // Already authenticated → branch is skipped; the live token is untouched.
    expect(freshStore.getState().accessToken).toBe('live-token');
    expect(freshStore.getState().user?.username).toBe('alice');
  });
});
