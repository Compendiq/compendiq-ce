import { useQuery } from '@tanstack/react-query';

interface SetupStatus {
  setupComplete: boolean;
  steps: {
    admin: boolean;
    llm: boolean;
    confluence: boolean;
  };
}

/**
 * Describes the deployment, not the signed-in user — `{ setupComplete, steps }`
 * carries no per-user data. Exported so the logout cache wipe can spare it:
 * ProtectedRoute gates on this query's loading state, so dropping it mid-flight
 * strands the router on the loading fallback (see useClearCacheOnLogout).
 */
export const SETUP_STATUS_QUERY_KEY = ['setup-status'] as const;

/**
 * Queries the setup status endpoint to determine whether the first-run
 * wizard has been completed. The result is cached for 30 seconds to avoid
 * hammering the endpoint on every route navigation.
 */
export function useSetupStatus() {
  const { data, isLoading, error, refetch } = useQuery<SetupStatus>({
    queryKey: SETUP_STATUS_QUERY_KEY,
    queryFn: async () => {
      const res = await fetch('/api/health/setup-status');
      if (!res.ok) {
        throw new Error('Failed to check setup status');
      }
      return res.json();
    },
    staleTime: 30_000,
    retry: 2,
    refetchOnWindowFocus: false,
  });

  return {
    setupComplete: data?.setupComplete ?? false,
    steps: data?.steps ?? { admin: false, llm: false, confluence: false },
    // True when React Query holds a (possibly stale) successful response.
    // Lets callers distinguish "errored with no data at all" from "background
    // refetch failed but the cached answer is still routable" (#932).
    hasData: data !== undefined,
    isLoading,
    error,
    refetch,
  };
}
