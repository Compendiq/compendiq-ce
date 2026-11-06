import { QueryClient } from '@tanstack/react-query';
import { ApiError, RefreshUnavailableError } from './api';

/**
 * Determines whether a failed query should be retried.
 *
 * Client errors that will never succeed on retry (authentication,
 * authorization, not-found) and indeterminate refreshes are skipped immediately.
 * Other errors (including retry-safe refresh busy responses) are retried up to
 * `maxRetries` times.
 */
export function shouldRetry(failureCount: number, error: unknown, maxRetries = 2): boolean {
  if (error instanceof RefreshUnavailableError && !error.retrySafe) return false;
  if (error instanceof ApiError) {
    const status = error.statusCode;
    if (status === 401 || status === 403 || status === 404) {
      return false;
    }
  }
  return failureCount < maxRetries;
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        retry: (failureCount, error) => shouldRetry(failureCount, error),
      },
    },
  });
}
