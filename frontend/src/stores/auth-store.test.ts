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
    const refreshEvent = new Event('storage');
    Object.defineProperty(refreshEvent, 'key', { value: 'compendiq-auth', configurable: true });
    Object.defineProperty(refreshEvent, 'newValue', {
      value: JSON.stringify(newState),
      configurable: true,
    });
    window.dispatchEvent(refreshEvent);

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
    const logoutEvent = new Event('storage');
    Object.defineProperty(logoutEvent, 'key', { value: 'compendiq-auth', configurable: true });
    Object.defineProperty(logoutEvent, 'newValue', {
      value: JSON.stringify(loggedOutState),
      configurable: true,
    });
    window.dispatchEvent(logoutEvent);

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
    const unrelatedEvent = new Event('storage');
    Object.defineProperty(unrelatedEvent, 'key', { value: 'some-other-key', configurable: true });
    Object.defineProperty(unrelatedEvent, 'newValue', { value: null, configurable: true });
    window.dispatchEvent(unrelatedEvent);

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
    const malformedEvent = new Event('storage');
    Object.defineProperty(malformedEvent, 'key', { value: 'compendiq-auth', configurable: true });
    Object.defineProperty(malformedEvent, 'newValue', {
      value: 'not-valid-json{{{',
      configurable: true,
    });
    window.dispatchEvent(malformedEvent);

    // Should not crash or change state
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    expect(useAuthStore.getState().accessToken).toBe('my-token');
  });
});
