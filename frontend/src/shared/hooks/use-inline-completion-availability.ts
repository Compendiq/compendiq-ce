import { useQuery } from '@tanstack/react-query';
import type { UsecaseDefault } from '@compendiq/contracts';
import { apiFetch } from '../lib/api';

/**
 * Assignment availability is separate from the personal enabled preference:
 * an unassigned `inline_completion` use case returns 404 and keeps the editor
 * plugin dormant without probing the provider or showing an error toast.
 */
export function useInlineCompletionAvailability() {
  return useQuery<boolean>({
    queryKey: ['llm', 'usecase-default', 'inline_completion'],
    queryFn: async () => {
      try {
        await apiFetch<UsecaseDefault>(
          '/llm/usecase-default?usecase=inline_completion',
        );
        return true;
      } catch (err) {
        // ApiError exposes statusCode; structural reading also survives a
        // cross-realm boundary without weakening the decision to 403/404.
        const status = typeof err === 'object' && err !== null
          ? (err as { statusCode?: unknown }).statusCode
          : undefined;
        if (status === 403 || status === 404) {
          return false;
        }
        throw err;
      }
    },
    retry: false,
    staleTime: 30_000,
  });
}
