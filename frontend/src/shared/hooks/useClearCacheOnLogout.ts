import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuthStore } from '../../stores/auth-store';
import { useUiStore } from '../../stores/ui-store';
import { forgetLastConfluenceSpace } from '../../features/pages/last-confluence-space';
import { forgetRecentLibrarySpaces } from '../../features/pages/library-space-history';
import { SETUP_STATUS_QUERY_KEY } from './useSetupStatus';
import { resetOnboardingSessionWrites } from './use-onboarding';

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
 * It also drops the remembered New Page space (#1122), the Library's recent
 * spaces and the sidebar tree's selected space (persisted in `compendiq-ui`):
 * those live in localStorage rather than the query cache, so
 * `queryClient.clear()` would leave the previous user's space keys behind and
 * the next user would start in the previous user's space.
 *
 * This is the single choke point for every clearAuth path — the logout button,
 * the api.ts token-expiry handlers, the cross-tab storage event, and a failed
 * session refresh — because they all flip `isAuthenticated` to false. The ref
 * guard ensures we only clear on a true→false transition: a token refresh
 * (setAuth while already authenticated) must NOT drop a live session's cache.
 *
 * The one exception is a refresh or an adopted cross-tab token that carries a
 * DIFFERENT account while this tab stays authenticated: someone else signed
 * in through a tab this one never heard sign out (during an upgrade, a tab of
 * the other build — #1881). That is an account switch, so the same wipe runs;
 * active queries are reset rather than removed so mounted views refetch as
 * the new account instead of keeping the old account's data on screen.
 */
export function useClearCacheOnLogout(): void {
  const queryClient = useQueryClient();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const wasAuthenticated = useRef(isAuthenticated);
  const previousUserId = useRef(userId);

  useEffect(() => {
    const loggedOut = wasAuthenticated.current && !isAuthenticated;
    const switchedAccount = isAuthenticated
      && previousUserId.current !== null && userId !== null
      && previousUserId.current !== userId;
    if (loggedOut || switchedAccount) {
      // Everything EXCEPT the setup-status query, which describes the
      // deployment rather than any user and so is outside what this wipe
      // protects. A blanket queryClient.clear() also removed it *mid-flight*:
      // the in-flight response then arrived for a query that no longer existed
      // and was discarded, leaving ProtectedRoute's `isLoading` gate stuck on
      // the loading fallback with nothing left to trigger a refetch — an
      // expired session rendered a permanent spinner instead of the login page.
      const accountScoped = {
        predicate: (query: { queryKey: readonly unknown[] }) => query.queryKey[0] !== SETUP_STATUS_QUERY_KEY[0],
      };
      if (loggedOut) {
        queryClient.removeQueries(accountScoped);
      } else {
        void queryClient.resetQueries(accountScoped);
      }
      // clear() dropped mutation state too; keep doing that so an interrupted
      // mutation can't surface to whoever logs in next in this tab.
      queryClient.getMutationCache().clear();
      // The onboarding auto-mark dedupe is keyed by this same never-rebuilt
      // client (#1402), so it is exactly as stale as the cache above: without
      // this the next user in the tab has their milestones suppressed for the
      // rest of the page load while their own flags are still false.
      resetOnboardingSessionWrites(queryClient);
      forgetLastConfluenceSpace();
      forgetRecentLibrarySpaces();
      useUiStore.getState().setTreeSidebarSpaceKey(undefined);
    }
    wasAuthenticated.current = isAuthenticated;
    previousUserId.current = userId;
  }, [isAuthenticated, userId, queryClient]);
}
