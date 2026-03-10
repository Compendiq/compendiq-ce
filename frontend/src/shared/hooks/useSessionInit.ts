import { useEffect, useRef } from 'react';
import { useAuthStore } from '../../stores/auth-store';

const API_BASE = '/api';

/**
 * On app load, if the user appears authenticated (from persisted localStorage)
 * but has no access token (e.g. token was cleared or corrupted in storage),
 * attempt a silent token refresh using the httpOnly refresh cookie. If the
 * refresh fails (expired session, revoked token, etc.), clear auth so the user
 * is redirected to login immediately instead of seeing broken API errors.
 *
 * Note: The access token IS persisted in localStorage for cross-tab session
 * sharing (see auth-store). Short token expiry and refresh token rotation
 * mitigate the localStorage exposure risk.
 */
export function useSessionInit() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const accessToken = useAuthStore((s) => s.accessToken);
  const setAuth = useAuthStore((s) => s.setAuth);
  const clearAuth = useAuthStore((s) => s.clearAuth);
  const attempted = useRef(false);

  useEffect(() => {
    if (!isAuthenticated || accessToken || attempted.current) return;
    attempted.current = true;

    (async () => {
      try {
        const res = await fetch(`${API_BASE}/auth/refresh`, {
          method: 'POST',
          credentials: 'include',
        });
        if (!res.ok) {
          clearAuth();
          return;
        }
        const data = await res.json();
        setAuth(data.accessToken, data.user);
      } catch {
        clearAuth();
      }
    })();
  }, [isAuthenticated, accessToken, setAuth, clearAuth]);
}
