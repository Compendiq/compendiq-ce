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
 * Queries the setup status endpoint to determine whether the first-run
 * wizard has been completed. The result is cached for 30 seconds to avoid
 * hammering the endpoint on every route navigation.
 */
export function useSetupStatus() {
  const { data, isLoading, error, refetch } = useQuery<SetupStatus>({
    queryKey: ['setup-status'],
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
    isLoading,
    error,
    refetch,
  };
}
