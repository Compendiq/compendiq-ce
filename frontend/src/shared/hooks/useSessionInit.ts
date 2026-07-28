import { useEffect, useRef } from 'react';
import { useAuthStore } from '../../stores/auth-store';
import { refreshAccessTokenOnce } from '../lib/api';

/**
 * On app load the user may look authenticated (only `user` + `isAuthenticated`
 * persist in localStorage) while holding no in-memory access token — the token
 * is deliberately never persisted (CWE-922), so a reload or new tab always
 * starts without one. In that state, attempt a silent token refresh using the
 * httpOnly refresh cookie. If the refresh fails (expired session, revoked
 * token, etc.), clear auth so the user is redirected to login immediately
 * instead of seeing broken API errors.
 *
 * The refresh is routed through the shared refreshAccessTokenOnce() helper so it
 * joins the same single-flight promise as apiFetch's reactive 401 refresh. In
 * this exact state (authenticated, no in-memory token) every mounted query also
 * 401s and triggers refreshAccessTokenOnce(); firing an independent /auth/refresh
 * here would race that deduped path, and the loser would present an
 * already-rotated (revoked) refresh JTI — tripping the backend's token-family
 * reuse detection and forcibly logging the user out despite a valid session.
 *
 * On success refreshAccessTokenOnce stores the new token+user via the store
 * (see api.ts), so no explicit setAuth is needed here.
 *
 * Note: The access token lives in memory ONLY — never in localStorage or
 * sessionStorage. Cross-tab token sharing goes through an in-memory
 * BroadcastChannel (see auth-store); Web Storage only ever holds non-sensitive
 * `user` + `isAuthenticated`.
 */
export function useSessionInit() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const accessToken = useAuthStore((s) => s.accessToken);
  const clearAuth = useAuthStore((s) => s.clearAuth);
  const attempted = useRef(false);

  useEffect(() => {
    if (!isAuthenticated || accessToken || attempted.current) return;
    attempted.current = true;

    (async () => {
      const token = await refreshAccessTokenOnce();
      if (!token) clearAuth();
    })();
  }, [isAuthenticated, accessToken, clearAuth]);
}
