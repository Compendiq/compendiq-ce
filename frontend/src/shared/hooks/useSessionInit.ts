import { useEffect, useRef } from 'react';
import { useAuthStore } from '../../stores/auth-store';
import { refreshAccessTokenOnce } from '../lib/api';

/**
 * On app load, if the user appears authenticated (from persisted localStorage)
 * but has no access token (e.g. token was cleared or corrupted in storage),
 * attempt a silent token refresh using the httpOnly refresh cookie. If the
 * refresh fails (expired session, revoked token, etc.), clear auth so the user
 * is redirected to login immediately instead of seeing broken API errors.
 *
 * The refresh is routed through the shared refreshAccessTokenOnce() helper so it
 * joins the same single-flight promise as apiFetch's reactive 401 refresh. In
 * this exact state (authenticated, no in-memory token) every mounted query also
 * 401s and triggers refreshAccessTokenOnce(); firing an independent /auth/refresh
 * here would race that deduped path, and the loser would present an
 * already-rotated (revoked) refresh JTI — tripping the backend's token-family
 * reuse detection and forcibly logging the user out despite a valid session.
 *
 * On success refreshAccessTokenOnce persists the new token+user via the store
 * (see api.ts), so no explicit setAuth is needed here.
 *
 * Note: The access token IS persisted in localStorage for cross-tab session
 * sharing (see auth-store). Short token expiry and refresh token rotation
 * mitigate the localStorage exposure risk.
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
