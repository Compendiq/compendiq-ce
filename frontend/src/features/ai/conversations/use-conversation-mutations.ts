import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { ConversationSummary } from '@compendiq/contracts';
import { apiFetch, type ApiError } from '../../../shared/lib/api';
import { useAiContext } from '../AiContext';

/**
 * The prefix every conversation-changing event invalidates (#1361 §Invalidation).
 * `CONVERSATIONS_LIST_KEY` sits under it, so one invalidation reaches the list
 * without these mutations importing it — and `AiContext` invalidates the same
 * literal from the ask path.
 */
const CONVERSATIONS_KEY = ['llm', 'conversations'] as const;

export interface RenameConversationVariables {
  id: string;
  title: string;
}

export interface DeleteConversationVariables {
  id: string;
  /**
   * Not sent — the request needs only `id`. It rides along because the confirm
   * dialog names it ("<title>" will be permanently deleted.), so the dialog,
   * the mutation and any later optimistic update read one object.
   */
  title: string;
}

/**
 * Inline rename (#1361). Deliberately has **no** `onError`: the spec puts the
 * remedy in the row — on failure the input stays open with the user's text and
 * toasts from there — so a toast here would fire a second one over it and would
 * report an edit as finished while the field is still on screen.
 *
 * The route does not bump `updated_at` (a rename must not re-bucket the row
 * into "Today"), so the invalidation is about the title, not the position.
 */
export function useRenameConversation(): UseMutationResult<
  ConversationSummary,
  ApiError,
  RenameConversationVariables
> {
  const queryClient = useQueryClient();
  return useMutation<ConversationSummary, ApiError, RenameConversationVariables>({
    mutationFn: ({ id, title }) =>
      apiFetch<ConversationSummary>(`/llm/conversations/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ title }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: CONVERSATIONS_KEY });
    },
  });
}

/**
 * Delete (#1361, decision 8 — no undo). `purgeConversation` is the thread-side
 * half: it drops the retained `conv:<id>` thread, clears the id off any other
 * thread carrying it, and navigates to `/ai` when the deleted row is the open
 * one. It runs BEFORE the invalidation so the refetch lands on a URL that still
 * exists.
 */
export function useDeleteConversation(): UseMutationResult<
  void,
  ApiError,
  DeleteConversationVariables
> {
  const queryClient = useQueryClient();
  const { purgeConversation } = useAiContext();
  return useMutation<void, ApiError, DeleteConversationVariables>({
    mutationFn: async ({ id }) => {
      await apiFetch(`/llm/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' });
    },
    onSuccess: (_data, { id }) => {
      purgeConversation(id);
      void queryClient.invalidateQueries({ queryKey: CONVERSATIONS_KEY });
      toast.success('Conversation deleted');
    },
    onError: (error) => {
      // `ApiError.message` is already the backend's curated sentence; the
      // fallback covers a failure that carried no readable message at all.
      toast.error(error.message || 'Failed to delete conversation');
    },
  });
}
