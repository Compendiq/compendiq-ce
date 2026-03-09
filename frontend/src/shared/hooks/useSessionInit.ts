import { useEffect, useRef } from 'react';
import { useAuthStore } from '../../stores/auth-store';

const API_BASE = '/api';

/**
 * On app load, if the user appears authenticated (from persisted localStorage)
 * but has no in-memory access token (it's not persisted for security), attempt
 * a silent token refresh using the httpOnly refresh cookie. If the refresh fails
 * (expired session, revoked token, etc.), clear auth so the user is redirected
 * to login immediately instead of seeing broken API errors.
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
