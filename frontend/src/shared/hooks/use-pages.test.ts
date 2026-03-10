import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { usePages, usePageTree, usePinPage, useUnpinPage, type PinnedPage } from './use-pages';
import type { PageFilters } from './use-pages';

// Mock auth store
vi.mock('../../stores/auth-store', () => ({
  useAuthStore: Object.assign(
    () => ({ accessToken: 'test-token' }),
    {
      getState: () => ({ accessToken: 'test-token', setAuth: vi.fn(), clearAuth: vi.fn() }),
    },
  ),
}));

// Mock apiFetch (used by pin/unpin mutations)
const apiFetchMock = vi.fn();
vi.mock('../lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

const MOCK_PAGINATED = {
  items: [],
  total: 0,
  page: 1,
  limit: 20,
  totalPages: 0,
};

const MOCK_TREE = {
  items: [],
  total: 0,
};

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

function createQueryClientAndWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  return { queryClient, wrapper };
}

const mockPinnedPage: PinnedPage = {
  id: 'page-1',
  spaceKey: 'DEV',
  title: 'Test Page',
  author: 'admin',
  lastModifiedAt: '2025-01-01T00:00:00Z',
  excerpt: 'Test excerpt',
  pinnedAt: '2025-06-01T00:00:00Z',
  pinOrder: 1,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('usePages', () => {
  it('should fetch pages with query params', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(MOCK_PAGINATED), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const { result } = renderHook(
      () => usePages({ spaceKey: 'DEV', search: 'test', page: 1, limit: 20 }),
      { wrapper: createWrapper() },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/pages?'),
      expect.objectContaining({}),
    );

    // Verify all query params are included
    const callUrl = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(callUrl).toContain('spaceKey=DEV');
    expect(callUrl).toContain('search=test');
    expect(callUrl).toContain('page=1');
    expect(callUrl).toContain('limit=20');
  });

  it('should produce a stable query key for identical params across re-renders', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(MOCK_PAGINATED), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const { queryClient, wrapper } = createQueryClientAndWrapper();

    const filters: PageFilters = { spaceKey: 'DEV', search: 'test', page: 1 };

    // Render with the same primitive values but a new object reference each time
    const { result, rerender } = renderHook(
      ({ params }: { params: PageFilters }) => usePages(params),
      { wrapper, initialProps: { params: { ...filters } } },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // Re-render with a new object reference containing the same values
    rerender({ params: { ...filters } });

    // Wait for any potential refetch to settle
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // There should be exactly ONE cache entry for 'pages', not multiple
    const allQueries = queryClient.getQueryCache().findAll({ queryKey: ['pages'] });
    const pagesListQueries = allQueries.filter(
      (q) => q.queryKey.length === 2 && q.queryKey[0] === 'pages',
    );
    expect(pagesListQueries).toHaveLength(1);

    // fetch should have been called only once (no duplicate due to key change)
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('should create a new cache entry when params actually change', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify(MOCK_PAGINATED), {
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    const { queryClient, wrapper } = createQueryClientAndWrapper();

    const { result, rerender } = renderHook(
      ({ params }: { params: PageFilters }) => usePages(params),
      { wrapper, initialProps: { params: { spaceKey: 'DEV', page: 1 } } },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // Change to a different spaceKey -- should create a new cache entry
    rerender({ params: { spaceKey: 'OPS', page: 1 } });

    await waitFor(() => {
      const allQueries = queryClient.getQueryCache().findAll({ queryKey: ['pages'] });
      const pagesListQueries = allQueries.filter(
        (q) => q.queryKey.length === 2 && q.queryKey[0] === 'pages',
      );
      expect(pagesListQueries).toHaveLength(2);
    });

    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it('should handle empty params without errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(MOCK_PAGINATED), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const { result } = renderHook(() => usePages(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const callUrl = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(callUrl).toBe('/api/pages');
  });
});

describe('usePageTree', () => {
  it('should fetch page tree with spaceKey', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(MOCK_TREE), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const { result } = renderHook(
      () => usePageTree({ spaceKey: 'DEV' }),
      { wrapper: createWrapper() },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const callUrl = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(callUrl).toContain('/api/pages/tree?spaceKey=DEV');
  });

  it('should produce a stable query key for identical spaceKey across re-renders', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(MOCK_TREE), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const { queryClient, wrapper } = createQueryClientAndWrapper();

    const { result, rerender } = renderHook(
      ({ params }: { params: { spaceKey?: string } }) => usePageTree(params),
      { wrapper, initialProps: { params: { spaceKey: 'DEV' } } },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // Re-render with new object reference, same spaceKey value
    rerender({ params: { spaceKey: 'DEV' } });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const treeQueries = queryClient.getQueryCache().findAll({ queryKey: ['pages', 'tree'] });
    expect(treeQueries).toHaveLength(1);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('usePinPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('optimistically adds a page to pinned list on mutate', async () => {
    // apiFetch resolves after a delay to allow us to check optimistic state
    apiFetchMock.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ message: 'Page pinned', pageId: 'page-2' }), 100)),
    );

    const { wrapper, queryClient } = createWrapper();

    // Seed the pinned pages cache
    queryClient.setQueryData(['pages', 'pinned'], {
      items: [mockPinnedPage],
      total: 1,
    });

    const { result } = renderHook(() => usePinPage(), { wrapper });

    // Trigger the mutation
    act(() => {
      result.current.mutate('page-2');
    });

    // Check optimistic state: the new page should appear immediately
    await waitFor(() => {
      const data = queryClient.getQueryData<{ items: PinnedPage[]; total: number }>(['pages', 'pinned']);
      expect(data).toBeDefined();
      expect(data!.items).toHaveLength(2);
      expect(data!.items[1].id).toBe('page-2');
      expect(data!.total).toBe(2);
    });
  });

  it('rolls back on error', async () => {
    apiFetchMock.mockRejectedValue(new Error('Server error'));

    const { wrapper, queryClient } = createWrapper();

    // Seed the pinned pages cache
    queryClient.setQueryData(['pages', 'pinned'], {
      items: [mockPinnedPage],
      total: 1,
    });

    const { result } = renderHook(() => usePinPage(), { wrapper });

    act(() => {
      result.current.mutate('page-2');
    });

    // Wait for the error to propagate and rollback
    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    const data = queryClient.getQueryData<{ items: PinnedPage[]; total: number }>(['pages', 'pinned']);
    expect(data!.items).toHaveLength(1);
    expect(data!.items[0].id).toBe('page-1');
    expect(data!.total).toBe(1);
  });

  it('creates pinned list from empty when no cache exists', async () => {
    apiFetchMock.mockResolvedValue({ message: 'Page pinned', pageId: 'page-1' });

    const { wrapper, queryClient } = createWrapper();
    // No seeded cache

    const { result } = renderHook(() => usePinPage(), { wrapper });

    act(() => {
      result.current.mutate('page-1');
    });

    // Check optimistic state
    await waitFor(() => {
      const data = queryClient.getQueryData<{ items: PinnedPage[]; total: number }>(['pages', 'pinned']);
      expect(data).toBeDefined();
      expect(data!.items).toHaveLength(1);
      expect(data!.items[0].id).toBe('page-1');
    });
  });
});

describe('useUnpinPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('optimistically removes a page from pinned list on mutate', async () => {
    apiFetchMock.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ message: 'Page unpinned', pageId: 'page-1' }), 100)),
    );

    const { wrapper, queryClient } = createWrapper();

    queryClient.setQueryData(['pages', 'pinned'], {
      items: [mockPinnedPage],
      total: 1,
    });

    const { result } = renderHook(() => useUnpinPage(), { wrapper });

    act(() => {
      result.current.mutate('page-1');
    });

    // Check optimistic state: the page should be removed immediately
    await waitFor(() => {
      const data = queryClient.getQueryData<{ items: PinnedPage[]; total: number }>(['pages', 'pinned']);
      expect(data).toBeDefined();
      expect(data!.items).toHaveLength(0);
      expect(data!.total).toBe(0);
    });
  });

  it('rolls back on error', async () => {
    apiFetchMock.mockRejectedValue(new Error('Server error'));

    const { wrapper, queryClient } = createWrapper();

    queryClient.setQueryData(['pages', 'pinned'], {
      items: [mockPinnedPage],
      total: 1,
    });

    const { result } = renderHook(() => useUnpinPage(), { wrapper });

    act(() => {
      result.current.mutate('page-1');
    });

    // Wait for the error to propagate and rollback
    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    const data = queryClient.getQueryData<{ items: PinnedPage[]; total: number }>(['pages', 'pinned']);
    expect(data!.items).toHaveLength(1);
    expect(data!.items[0].id).toBe('page-1');
    expect(data!.total).toBe(1);
  });

  it('handles empty cache gracefully', async () => {
    apiFetchMock.mockResolvedValue({ message: 'Page unpinned', pageId: 'page-1' });

    const { wrapper, queryClient } = createWrapper();
    // No seeded cache

    const { result } = renderHook(() => useUnpinPage(), { wrapper });

    act(() => {
      result.current.mutate('page-1');
    });

    await waitFor(() => {
      const data = queryClient.getQueryData<{ items: PinnedPage[]; total: number }>(['pages', 'pinned']);
      expect(data).toBeDefined();
      expect(data!.items).toHaveLength(0);
      expect(data!.total).toBe(0);
    });
  });
});
