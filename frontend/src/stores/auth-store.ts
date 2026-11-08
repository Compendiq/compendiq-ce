import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { AI_POLICY_CLIENT_PROTOCOL_VERSION } from '@compendiq/contracts';
import { migrateStorageKey } from '../shared/lib/migrate-storage-key';
// Used only at runtime (setAuth, the storage listener), so the import cycle
// (editor-drafts reads this store) never touches an uninitialised binding.
import { forgetDraftSignOut, SIGN_OUT_EPOCH_KEY } from '../shared/lib/editor-drafts';

/**
 * The persisted auth key and the cross-tab channel carry the client protocol
 * version (#1881). A pre-handshake bundle still open in another tab keeps
 * using the unversioned `compendiq-auth` names, so it can neither adopt this
 * bundle's access tokens (which would outlive its own one-token-lifetime
 * residual) nor sign this bundle's tabs out when the server refuses its
 * session with `client_reload_required`. Bump only together with
 * `AI_POLICY_CLIENT_PROTOCOL_VERSION`.
 */
export const AUTH_STORAGE_KEY = `compendiq-auth:p${AI_POLICY_CLIENT_PROTOCOL_VERSION}`;
const UNVERSIONED_AUTH_STORAGE_KEY = 'compendiq-auth';

// One-time migrations for localStorage key renames
migrateStorageKey('kb-auth', UNVERSIONED_AUTH_STORAGE_KEY);
migrateStorageKey('atlasmind-auth', UNVERSIONED_AUTH_STORAGE_KEY);
adoptUnversionedAuthState();

/**
 * Upgrade path: keep a signed-in user signed in by COPYING the unversioned
 * blob (user + isAuthenticated) to the versioned key once. The unversioned
 * key is left in place on purpose: removing it would fire a `storage` event
 * that signs out every pre-upgrade tab. A blob from before the token stopped
 * being persisted is scrubbed in place too (still signed in, so no legacy
 * tab sees a logout), so no access token stays at rest under either key.
 */
function adoptUnversionedAuthState(): void {
  try {
    if (localStorage.getItem(AUTH_STORAGE_KEY) !== null) return;
    let unversioned = localStorage.getItem(UNVERSIONED_AUTH_STORAGE_KEY);
    if (unversioned === null) return;
    try {
      const parsed = JSON.parse(unversioned) as { state?: Record<string, unknown> };
      if (parsed.state && 'accessToken' in parsed.state) {
        delete parsed.state.accessToken;
        unversioned = JSON.stringify(parsed);
        localStorage.setItem(UNVERSIONED_AUTH_STORAGE_KEY, unversioned);
      }
    } catch {
      // Unparseable: copy as-is; the persist rehydrate treats it as empty.
    }
    localStorage.setItem(AUTH_STORAGE_KEY, unversioned);
  } catch {
    // localStorage unavailable — nothing to adopt
  }
}

// Send-only: this bundle never listens on the unversioned channel, so a
// legacy tab's tokens and (refused-refresh) logouts never reach it.
const unversionedAuthChannel: BroadcastChannel | null =
  typeof BroadcastChannel !== 'undefined'
    ? new BroadcastChannel(UNVERSIONED_AUTH_STORAGE_KEY)
    : null;

/**
 * Explicit sign-out only (`logoutApi`): tell tabs of a pre-handshake build
 * too, through both channels they listen on. Neither message carries a
 * token. Without this, a legacy tab would keep the signed-out account's
 * session and cached data until its access token expired.
 */
export function announceExplicitSignOutToUnversionedTabs(): void {
  try {
    unversionedAuthChannel?.postMessage({ type: 'logout' });
  } catch { /* channel closed — the storage write below still reaches them */ }
  try {
    localStorage.setItem(
      UNVERSIONED_AUTH_STORAGE_KEY,
      JSON.stringify({ state: { user: null, isAuthenticated: false }, version: 1 }),
    );
  } catch { /* storage unavailable */ }
}

/**
 * Zustand persist rehydrates asynchronously. ProtectedRoute's boot skeleton
 * would otherwise paint the guest header for a returning session on every
 * reload until hydration lands. Read the persisted flag synchronously; the
 * store remains source of truth for routing once it has hydrated.
 */
export function peekPersistedSession(): boolean {
  try {
    const raw = localStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw) as { state?: { isAuthenticated?: boolean } };
    return parsed.state?.isAuthenticated === true;
  } catch {
    return false;
  }
}

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
    ? new BroadcastChannel(AUTH_STORAGE_KEY)
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
        // A live session for this user lifts the draft refusal an explicit
        // sign-out left behind — on sign-in and on token refresh alike. A
        // refresh only succeeds while the server session is live (e.g. the
        // sign-out's logout request never reached the server), and drafts are
        // only ever written to this user's own scope. Tabs that adopt this
        // token via the broadcast share the cleared marker.
        forgetDraftSignOut(user.id);
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
      name: AUTH_STORAGE_KEY,
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
 * 1. BroadcastChannel(AUTH_STORAGE_KEY) — in-memory, same-origin. Carries the
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
    // Explicit sign-out in ANY build's tab advances the shared draft
    // sign-out epoch (GHSA-r652; unversioned on purpose). Only `logoutApi`
    // writes it — never a refused refresh — so this is the cross-build
    // sign-out signal a pre-handshake tab can still deliver.
    if (event.key === SIGN_OUT_EPOCH_KEY && event.newValue !== null) {
      applyRemote(() => useAuthStore.getState().clearAuth());
      return;
    }
    if (event.key !== AUTH_STORAGE_KEY) return;

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
