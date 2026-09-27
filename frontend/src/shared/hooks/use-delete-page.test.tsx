import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useDeletePage, usePages } from './use-pages';

type CachedPage = { id: string; title: string };
type CachedPages = {
  items: CachedPage[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
};

const firstPage: CachedPage = { id: '1', title: 'First' };
const secondPage: CachedPage = { id: '2', title: 'Second' };

function pages(items: CachedPage[], total = items.length): CachedPages {
  return { items, total, page: 1, limit: 20, totalPages: total === 0 ? 0 : 1 };
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, wrapper };
}

function cached(queryClient: QueryClient, key: readonly unknown[]): CachedPages {
  return queryClient.getQueryData<CachedPages>(key)!;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useDeletePage cache consistency', () => {
  it('keeps an inactive list intact when the server rejects the delete', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(
      { message: 'Protected page content is frozen', reason: 'page_is_frozen' },
      423,
    ));
    vi.stubGlobal('fetch', fetchMock);
    const { queryClient, wrapper } = setup();
    const listKey = ['pages', { page: 1 }] as const;
    queryClient.setQueryData(listKey, pages([firstPage, secondPage]));

    const { result } = renderHook(() => useDeletePage(), { wrapper });

    await act(async () => {
      await expect(result.current.mutateAsync('1')).rejects.toMatchObject({
        statusCode: 423,
        reason: 'page_is_frozen',
      });
    });

    expect(cached(queryClient, listKey)).toEqual(pages([firstPage, secondPage]));
    expect(queryClient.getQueryState(listKey)?.isInvalidated).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the rejected row when active reconciliation also fails', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        return jsonResponse({ message: 'Protected page content is frozen' }, 423);
      }
      return jsonResponse({ message: 'Reconciliation unavailable' }, 503);
    });
    vi.stubGlobal('fetch', fetchMock);
    const { queryClient, wrapper } = setup();
    const listKey = ['pages', {
      spaceKey: undefined,
      search: undefined,
      author: undefined,
      labels: undefined,
      freshness: undefined,
      embeddingStatus: undefined,
      qualityMin: undefined,
      qualityMax: undefined,
      qualityStatus: undefined,
      source: undefined,
      dateFrom: undefined,
      dateTo: undefined,
      page: 1,
      limit: undefined,
      sort: undefined,
    }] as const;
    queryClient.setQueryData(listKey, pages([firstPage, secondPage]), { updatedAt: Date.now() });

    const { result } = renderHook(() => ({
      list: usePages({ page: 1 }),
      remove: useDeletePage(),
    }), { wrapper });

    await act(async () => {
      await expect(result.current.remove.mutateAsync('1')).rejects.toMatchObject({ statusCode: 423 });
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    expect(result.current.list.data).toEqual(pages([firstPage, secondPage]));
    expect(cached(queryClient, listKey)).toEqual(pages([firstPage, secondPage]));
  });

  it('does not invent a lower total for a disjoint filtered cache', async () => {
    const deleteResponse = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn(() => deleteResponse.promise));
    const { queryClient, wrapper } = setup();
    const allKey = ['pages', { page: 1 }] as const;
    const otherKey = ['pages', { spaceKey: 'OTHER', page: 1 }] as const;
    queryClient.setQueryData(allKey, pages([firstPage, secondPage]));
    queryClient.setQueryData(otherKey, pages([secondPage]));

    const { result } = renderHook(() => useDeletePage(), { wrapper });
    let mutation!: Promise<unknown>;
    act(() => {
      mutation = result.current.mutateAsync('1');
    });

    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1));
    expect(cached(queryClient, allKey)).toEqual(pages([firstPage, secondPage]));
    expect(cached(queryClient, otherKey)).toEqual(pages([secondPage]));

    deleteResponse.resolve(jsonResponse({ message: 'Protected page content is frozen' }, 423));
    await act(async () => {
      await expect(mutation).rejects.toMatchObject({ statusCode: 423 });
    });
  });

  it('updates only confirmed Library membership and invalidates related collections', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    const { queryClient, wrapper } = setup();
    const listKey = ['pages', { page: 1 }] as const;
    const disjointKey = ['pages', { spaceKey: 'OTHER', page: 1 }] as const;
    const treeKey = ['pages', 'tree', { spaceKey: undefined }] as const;
    const pinnedKey = ['pages', 'pinned'] as const;
    const trashKey = ['trash'] as const;
    const tree = { items: [firstPage, secondPage], total: 2 };
    const pinned = { items: [firstPage, secondPage], total: 2 };
    const trash = { items: [], total: 0 };
    queryClient.setQueryData(listKey, pages([firstPage, secondPage]));
    queryClient.setQueryData(disjointKey, pages([secondPage]));
    queryClient.setQueryData(treeKey, tree);
    queryClient.setQueryData(pinnedKey, pinned);
    queryClient.setQueryData(trashKey, trash);

    const { result } = renderHook(() => useDeletePage(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync('1');
    });

    expect(cached(queryClient, listKey)).toEqual(pages([secondPage]));
    expect(cached(queryClient, disjointKey)).toEqual(pages([secondPage]));
    expect(queryClient.getQueryData(treeKey)).toEqual(tree);
    expect(queryClient.getQueryData(pinnedKey)).toEqual(pinned);
    expect(queryClient.getQueryState(treeKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(pinnedKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(trashKey)?.isInvalidated).toBe(true);
  });

  it('preserves a successful overlapping deletion when another delete fails', async () => {
    const firstDelete = deferred<Response>();
    const secondDelete = deferred<Response>();
    let reconciliationCount = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'DELETE' && url.endsWith('/pages/1')) return firstDelete.promise;
      if (init?.method === 'DELETE' && url.endsWith('/pages/2')) return secondDelete.promise;
      reconciliationCount += 1;
      return Promise.resolve(reconciliationCount === 1
        ? jsonResponse(pages([firstPage]), 200)
        : jsonResponse({ message: 'Reconciliation unavailable' }, 503));
    });
    vi.stubGlobal('fetch', fetchMock);
    const { queryClient, wrapper } = setup();
    const listKey = ['pages', {
      spaceKey: undefined,
      search: undefined,
      author: undefined,
      labels: undefined,
      freshness: undefined,
      embeddingStatus: undefined,
      qualityMin: undefined,
      qualityMax: undefined,
      qualityStatus: undefined,
      source: undefined,
      dateFrom: undefined,
      dateTo: undefined,
      page: 1,
      limit: undefined,
      sort: undefined,
    }] as const;
    queryClient.setQueryData(listKey, pages([firstPage, secondPage]), { updatedAt: Date.now() });

    const { result } = renderHook(() => ({
      list: usePages({ page: 1 }),
      remove: useDeletePage(),
    }), { wrapper });
    let rejectedDelete!: Promise<unknown>;
    let successfulDelete!: Promise<unknown>;
    act(() => {
      rejectedDelete = result.current.remove.mutateAsync('1');
      successfulDelete = result.current.remove.mutateAsync('2');
    });

    secondDelete.resolve(new Response(null, { status: 204 }));
    await act(async () => {
      await expect(successfulDelete).resolves.toBeUndefined();
    });
    await waitFor(() => expect(cached(queryClient, listKey).items).toEqual([firstPage]));
    await waitFor(() => expect(reconciliationCount).toBe(1));

    firstDelete.resolve(jsonResponse({ message: 'Protected page content is frozen' }, 423));
    await act(async () => {
      await expect(rejectedDelete).rejects.toMatchObject({ statusCode: 423 });
    });
    await waitFor(() => expect(reconciliationCount).toBe(2));

    expect(result.current.list.data?.items).toEqual([firstPage]);
    expect(cached(queryClient, listKey).total).toBe(1);
  });
});
