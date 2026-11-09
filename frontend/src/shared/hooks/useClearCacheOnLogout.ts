import { useLayoutEffect } from 'react';
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
 * session refresh — because they all flip `isAuthenticated` to false. Only a
 * true→false transition clears: a token refresh (setAuth while already
 * authenticated) must NOT drop a live session's cache.
 *
 * The one exception is a refresh or an adopted cross-tab token that carries a
 * DIFFERENT account while this tab stays authenticated: someone else signed
 * in through a tab this one never heard sign out (during an upgrade, a tab of
 * the other build — #1881). That is an account switch, so the same wipe runs;
 * active queries are reset rather than removed so mounted views refetch as
 * the new account instead of keeping the old account's data on screen.
 *
 * The wipe runs inside the store transition itself (a store subscription),
 * not in a render effect: React renders the new session only afterwards, so
 * the shell `ProtectedRoute` remounts for a new account never reads — and a
 * form that copies its values once never keeps — the previous account's
 * cache.
 */
export function useClearCacheOnLogout(): void {
  const queryClient = useQueryClient();

  // Layout effect: subscribed within the first commit, so a cross-tab logout
  // or token message delivered before passive effects flush is not missed.
  useLayoutEffect(() => useAuthStore.subscribe((state, previous) => {
    const loggedOut = previous.isAuthenticated && !state.isAuthenticated;
    const previousUserId = previous.user?.id ?? null;
    const userId = state.user?.id ?? null;
    const switchedAccount = previous.isAuthenticated && state.isAuthenticated
      && previousUserId !== null && userId !== null && previousUserId !== userId;
    if (!loggedOut && !switchedAccount) return;

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
  }), [queryClient]);
}
