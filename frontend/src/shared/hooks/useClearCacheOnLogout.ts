import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuthStore } from '../../stores/auth-store';

/**
 * Wipe the in-memory TanStack Query cache whenever the session ends.
 *
 * The QueryClient is created once for the whole SPA (main.tsx) and survives
 * a logout→relogin in the same tab because login is a pure SPA transition
 * with no page reload. Query keys carry no user identity (e.g. ['pages', …],
 * ['permissions', …]), so without an explicit clear the next user in the same
 * tab would read the previous user's cached pages, search results, and cached
 * `allowed` permission results (issue #885).
 *
 * This is the single choke point for every clearAuth path — the logout button,
 * the api.ts token-expiry handlers, the cross-tab storage event, and a failed
 * session refresh — because they all flip `isAuthenticated` to false. The ref
 * guard ensures we only clear on a true→false transition: a token refresh
 * (setAuth while already authenticated) must NOT drop a live session's cache.
 */
export function useClearCacheOnLogout(): void {
  const queryClient = useQueryClient();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const wasAuthenticated = useRef(isAuthenticated);

  useEffect(() => {
    if (wasAuthenticated.current && !isAuthenticated) {
      queryClient.clear();
    }
    wasAuthenticated.current = isAuthenticated;
  }, [isAuthenticated, queryClient]);
}
