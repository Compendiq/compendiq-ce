import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { useAuthStore } from './auth-store';

describe('auth-store', () => {
  beforeEach(() => {
    localStorage.clear();
    useAuthStore.getState().clearAuth();
  });

  afterEach(() => {
    localStorage.clear();
    useAuthStore.getState().clearAuth();
  });

  it('persists accessToken to localStorage', () => {
    useAuthStore.getState().setAuth('test-token-123', {
      id: '1',
      username: 'alice',
      role: 'user',
    });

    const stored = JSON.parse(localStorage.getItem('compendiq-auth') || '{}');
    expect(stored.state.accessToken).toBe('test-token-123');
    expect(stored.state.isAuthenticated).toBe(true);
    expect(stored.state.user.username).toBe('alice');
  });

  it('clears accessToken from localStorage on logout', () => {
    useAuthStore.getState().setAuth('test-token-123', {
      id: '1',
      username: 'alice',
      role: 'user',
    });

    useAuthStore.getState().clearAuth();

    const stored = JSON.parse(localStorage.getItem('compendiq-auth') || '{}');
    expect(stored.state.accessToken).toBeNull();
    expect(stored.state.isAuthenticated).toBe(false);
    expect(stored.state.user).toBeNull();
  });

  it('syncs logout across tabs via storage event', () => {
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

  it('syncs token refresh across tabs via storage event', () => {
    // Simulate being logged in with old token
    useAuthStore.getState().setAuth('old-token', {
      id: '1',
      username: 'alice',
      role: 'user',
    });

    // Simulate another tab refreshing the token
    const newState = {
      state: {
        accessToken: 'new-refreshed-token',
        user: { id: '1', username: 'alice', role: 'user' },
        isAuthenticated: true,
      },
      version: 0,
    };
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'compendiq-auth',
        newValue: JSON.stringify(newState),
      }),
    );

    expect(useAuthStore.getState().accessToken).toBe('new-refreshed-token');
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
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
        accessToken: null,
        user: null,
        isAuthenticated: false,
      },
      version: 0,
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
});
