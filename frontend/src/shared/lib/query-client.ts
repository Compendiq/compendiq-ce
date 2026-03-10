import { QueryClient } from '@tanstack/react-query';
import { ApiError } from './api';

/**
 * Determines whether a failed query should be retried.
 *
 * Client errors that will never succeed on retry (authentication,
 * authorization, not-found) are skipped immediately. All other
 * errors (network failures, 5xx, etc.) are retried up to
 * `maxRetries` times.
 */
export function shouldRetry(failureCount: number, error: unknown, maxRetries = 2): boolean {
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
