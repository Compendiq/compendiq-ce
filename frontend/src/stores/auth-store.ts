import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { migrateStorageKey } from '../shared/lib/migrate-storage-key';

// One-time migrations for localStorage key renames
migrateStorageKey('kb-auth', 'compendiq-auth');
migrateStorageKey('atlasmind-auth', 'compendiq-auth');

interface User {
  id: string;
  username: string;
  role: 'user' | 'admin';
}

interface AuthState {
  accessToken: string | null;
  user: User | null;
  isAuthenticated: boolean;
  setAuth: (accessToken: string, user: User) => void;
  clearAuth: () => void;
}

/**
 * Cross-tab auth messages carried over an in-memory BroadcastChannel.
 * The access token is a session secret (CWE-922) and MUST NOT travel through
 * Web Storage — BroadcastChannel keeps it same-origin and in-memory only.
 */
type AuthBroadcast =
  | { type: 'token'; accessToken: string; user: User }
  | { type: 'logout' };

// Same-origin, in-memory channel for propagating token adoption and logout
// between tabs without ever writing the token to localStorage/sessionStorage.
// Feature-guarded: where BroadcastChannel is unavailable we fall back to the
// retained `storage` event, which still coordinates logout (isAuthenticated
// persists) — each tab then re-mints its own token from the refresh cookie.
const authChannel: BroadcastChannel | null =
  typeof BroadcastChannel !== 'undefined'
    ? new BroadcastChannel('compendiq-auth')
    : null;

// Re-entrancy guard: while applying a message received from another tab we must
// not re-broadcast it, or two tabs would ping-pong messages forever.
let applyingRemote = false;

function postAuthMessage(msg: AuthBroadcast): void {
  if (applyingRemote) return;
  authChannel?.postMessage(msg);
}

// Run `fn` (a store mutation driven by a remote tab) with the re-entrancy guard
// raised so setAuth/clearAuth do not re-broadcast the change back out.
function applyRemote(fn: () => void): void {
  applyingRemote = true;
  try {
    fn();
  } finally {
    applyingRemote = false;
  }
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      accessToken: null,
      user: null,
      isAuthenticated: false,
      setAuth: (accessToken, user) => {
        set({ accessToken, user, isAuthenticated: true });
        // Share the fresh token with other tabs in-memory (never via storage).
        postAuthMessage({ type: 'token', accessToken, user });
      },
      clearAuth: () => {
        const wasAuthenticated = get().isAuthenticated;
        set({ accessToken: null, user: null, isAuthenticated: false });
        // Only broadcast on a genuine authenticated→unauthenticated transition
        // to avoid a logout-broadcast storm across tabs.
        if (wasAuthenticated) postAuthMessage({ type: 'logout' });
      },
    }),
    {
      name: 'compendiq-auth',
      // Bumped 0→1 to strip a legacy on-disk access token on first load after
      // upgrade (see `migrate`).
      version: 1,
      // Persist only non-sensitive state. The access token is deliberately
      // omitted: it lives in memory only and is re-minted from the HttpOnly
      // refresh cookie on reload/new tab via useSessionInit.
      partialize: (state) => ({
        user: state.user,
        isAuthenticated: state.isAuthenticated,
      }),
      // Upgrade path: older installs persisted `accessToken`. Strip it while
      // preserving user + isAuthenticated so upgraded users stay logged in
      // (the token is re-minted from the refresh cookie). Must return the
      // persisted object MINUS accessToken — never undefined/partial.
      migrate: (persisted) => {
        const s = { ...(persisted as Record<string, unknown>) };
        delete s.accessToken;
        return s;
      },
    },
  ),
);

/**
 * Cross-tab coordination:
 *
 * 1. BroadcastChannel('compendiq-auth') — in-memory, same-origin. Carries the
 *    access token (token adoption) and logout between tabs WITHOUT persisting
 *    the token. Received messages are applied with the re-entrancy guard so we
 *    don't echo them back.
 * 2. `storage` event — retained purely as a logout fallback. Since only
 *    `user` + `isAuthenticated` persist, it can no longer carry a token; it
 *    still fires on logout (blob cleared, or isAuthenticated flips false).
 */
if (authChannel) {
  authChannel.onmessage = (event: MessageEvent<AuthBroadcast>) => {
    const msg = event.data;
    if (!msg) return;
    applyRemote(() => {
      if (msg.type === 'token') {
        // Memory only — partialize omits accessToken, so nothing is persisted.
        useAuthStore.setState({
          accessToken: msg.accessToken,
          user: msg.user,
          isAuthenticated: true,
        });
      } else if (msg.type === 'logout') {
        useAuthStore.setState({
          accessToken: null,
          user: null,
          isAuthenticated: false,
        });
      }
    });
  };
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== 'compendiq-auth') return;

    if (event.newValue === null) {
      // localStorage was cleared (logout in another tab). Apply under the
      // re-entrancy guard so clearAuth doesn't re-broadcast a redundant logout.
      applyRemote(() => useAuthStore.getState().clearAuth());
      return;
    }

    try {
      const parsed = JSON.parse(event.newValue);
      const synced = parsed?.state;
      if (!synced) return;

      if (!synced.isAuthenticated) {
        // Other tab logged out.
        applyRemote(() => useAuthStore.getState().clearAuth());
      } else if (!authChannel && synced.user && !useAuthStore.getState().isAuthenticated) {
        // BroadcastChannel unavailable (e.g. Safari < 15.4): propagate cross-tab
        // LOGIN via the storage event too, so a tab that was logged out reflects
        // a login in another tab without a manual reload. This carries only
        // user + isAuthenticated — never the token — so the token stays null and
        // is re-minted from the HttpOnly refresh cookie by useSessionInit / the
        // 401 interceptor. When BroadcastChannel IS present, login + token
        // adoption go through it and this branch is skipped, so it can never
        // clobber the token the broadcast just adopted.
        applyRemote(() =>
          useAuthStore.setState({ user: synced.user, isAuthenticated: true }),
        );
      }
      // The access token never touches storage.
    } catch {
      // Malformed JSON — ignore
    }
  });
}
