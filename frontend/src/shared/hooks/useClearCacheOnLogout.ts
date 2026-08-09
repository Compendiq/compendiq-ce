import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuthStore } from '../../stores/auth-store';
import { forgetLastConfluenceSpace } from '../../features/pages/last-confluence-space';
import { SETUP_STATUS_QUERY_KEY } from './useSetupStatus';

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
 * It also drops the remembered New Page space (#1122): that lives in
 * localStorage rather than the query cache, so `queryClient.clear()` would
 * leave the previous user's space key behind.
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
      // Everything EXCEPT the setup-status query, which describes the
      // deployment rather than any user and so is outside what this wipe
      // protects. A blanket queryClient.clear() also removed it *mid-flight*:
      // the in-flight response then arrived for a query that no longer existed
      // and was discarded, leaving ProtectedRoute's `isLoading` gate stuck on
      // the loading fallback with nothing left to trigger a refetch — an
      // expired session rendered a permanent spinner instead of the login page.
      queryClient.removeQueries({
        predicate: (query) => query.queryKey[0] !== SETUP_STATUS_QUERY_KEY[0],
      });
      // clear() dropped mutation state too; keep doing that so an interrupted
      // mutation can't surface to whoever logs in next in this tab.
      queryClient.getMutationCache().clear();
      forgetLastConfluenceSpace();
    }
    wasAuthenticated.current = isAuthenticated;
  }, [isAuthenticated, queryClient]);
}
