import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { ConversationListResponse, ConversationSummary } from '@compendiq/contracts';
import { ApiError } from '../../../shared/lib/api';
import { useConversationList, CONVERSATIONS_LIST_KEY } from './use-conversation-list';

function summary(id: string, title: string): ConversationSummary {
  return {
    id,
    title,
    titleSource: 'question',
    model: 'test-model',
    pageId: null,
    pageTitle: null,
    createdAt: '2026-08-18T09:00:00.000Z',
    updatedAt: '2026-08-18T09:00:00.000Z',
  };
}

function jsonResponse(body: ConversationListResponse): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function createWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useConversationList', () => {
  it('is keyed under the invalidation prefix the rest of the app uses', () => {
    expect(CONVERSATIONS_LIST_KEY).toEqual(['llm', 'conversations', 'list']);
    // A prefix invalidation of ['llm','conversations'] must reach this key, or
    // every ask, rename and delete would leave a stale list behind.
    expect(CONVERSATIONS_LIST_KEY.slice(0, 2)).toEqual(['llm', 'conversations']);
  });

  it('fetches the first page with no cursor and flattens its items into rows', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ items: [summary('a', 'Alpha'), summary('b', 'Beta')], nextCursor: null }));

    const { result } = renderHook(() => useConversationList(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));
    expect(result.current.rows.map((r) => r.id)).toEqual(['a', 'b']);
    expect(result.current.query.hasNextPage).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/llm/conversations');
  });

  it('pages the server with ?cursor= and appends the second page to rows', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ items: [summary('a', 'Alpha')], nextCursor: 'cur-1' }))
      .mockResolvedValueOnce(jsonResponse({ items: [summary('b', 'Beta')], nextCursor: null }));

    const { result } = renderHook(() => useConversationList(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));
    expect(result.current.query.hasNextPage).toBe(true);

    await act(async () => {
      await result.current.query.fetchNextPage();
    });

    await waitFor(() => expect(result.current.rows).toHaveLength(2));
    expect(result.current.rows.map((r) => r.id)).toEqual(['a', 'b']);
    expect(result.current.query.hasNextPage).toBe(false);
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/llm/conversations?cursor=cur-1');
  });

  it('percent-encodes the cursor into the query string', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ items: [summary('a', 'Alpha')], nextCursor: 'a+b/c=' }))
      .mockResolvedValueOnce(jsonResponse({ items: [], nextCursor: null }));

    const { result } = renderHook(() => useConversationList(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));

    await act(async () => {
      await result.current.query.fetchNextPage();
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/llm/conversations?cursor=a%2Bb%2Fc%3D');
  });

  it('surfaces a failed fetch as an ApiError and does not retry', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ message: 'Database unavailable' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const { result } = renderHook(() => useConversationList(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.query.isError).toBe(true));
    expect(result.current.query.error).toBeInstanceOf(ApiError);
    expect(result.current.query.error?.message).toBe('Database unavailable');
    // Task 11 renders the failed-with-nothing-cached block off exactly this.
    expect(result.current.rows).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the loaded rows when a later page fails, so the list can degrade rather than disappear', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ items: [summary('a', 'Alpha')], nextCursor: 'cur-1' }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: 'Database unavailable' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

    const { result } = renderHook(() => useConversationList(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));

    await act(async () => {
      await result.current.query.fetchNextPage();
    });

    await waitFor(() => expect(result.current.query.isError).toBe(true));
    expect(result.current.rows.map((r) => r.id)).toEqual(['a']);
  });
});
