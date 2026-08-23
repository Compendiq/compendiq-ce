import { useMemo } from 'react';
import {
  useInfiniteQuery,
  type InfiniteData,
  type UseInfiniteQueryResult,
} from '@tanstack/react-query';
import type { ConversationListResponse, ConversationSummary } from '@compendiq/contracts';
import { apiFetch, type ApiError } from '../../../shared/lib/api';

/**
 * The conversations pane owns its server state (#1361 PR 2). `AiContext`'s
 * `useState` mirror and its `['llm','conversations']` query are deleted, so
 * this is the single reader of `GET /llm/conversations` (ADR-009).
 *
 * The key is three segments deep on purpose. Everything that moves a row or its
 * position invalidates the PREFIX `['llm','conversations']` — every ask that
 * carries or acquires a conversation id, the stale-404 recovery, rename and
 * delete — so one invalidation reaches this list and anything later work keys
 * beneath the same prefix (including the pending-title poll) without either side
 * naming the other.
 */
export const CONVERSATIONS_LIST_KEY = ['llm', 'conversations', 'list'] as const;

export const PENDING_TITLE_POLL_MS = 3_000;
const PENDING_TITLE_WINDOW_MS = 60_000;

/**
 * Poll only while a newly-created row still carries its question fallback.
 * Generated and user-renamed titles are terminal, and the 60-second ceiling
 * prevents a failed soft-side completion from turning into permanent polling.
 */
export function pendingTitlePollInterval(
  data: InfiniteData<ConversationListResponse> | undefined,
  now = Date.now(),
): number | false {
  const hasPendingTitle = data?.pages.some((page) =>
    page.items.some((row) => {
      if (row.titleSource !== 'question') return false;
      const createdAt = Date.parse(row.createdAt);
      if (!Number.isFinite(createdAt)) return false;
      const age = now - createdAt;
      return age >= 0 && age < PENDING_TITLE_WINDOW_MS;
    })) ?? false;
  return hasPendingTitle ? PENDING_TITLE_POLL_MS : false;
}

export interface ConversationListResult {
  query: UseInfiniteQueryResult<InfiniteData<ConversationListResponse>, ApiError>;
  /** Every loaded page's items, flattened, in server order (`updated_at DESC`). */
  rows: ConversationSummary[];
}

export function useConversationList(): ConversationListResult {
  const query = useInfiniteQuery<
    ConversationListResponse,
    ApiError,
    InfiniteData<ConversationListResponse>,
    typeof CONVERSATIONS_LIST_KEY,
    string | undefined
  >({
    queryKey: CONVERSATIONS_LIST_KEY,
    queryFn: ({ pageParam }) =>
      apiFetch<ConversationListResponse>(
        pageParam === undefined
          ? '/llm/conversations'
          : `/llm/conversations?cursor=${encodeURIComponent(pageParam)}`,
      ),
    initialPageParam: undefined,
    // The route answers `nextCursor: null` on the last page; TanStack reads
    // `undefined` as "no next page" and would take a null for a real page param.
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    refetchInterval: (currentQuery) =>
      pendingTitlePollInterval(currentQuery.state.data),
    // A failed list is a FAILURE the pane renders (the three list states), not
    // something to hide behind three silent retries — the tree learned this.
    retry: false,
    staleTime: 30_000,
  });

  const rows = useMemo(
    () => query.data?.pages.flatMap((page) => page.items) ?? [],
    [query.data],
  );

  return { query, rows };
}
