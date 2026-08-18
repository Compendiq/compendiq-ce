import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, RouterProvider, createMemoryRouter, useLocation } from 'react-router-dom';
import { toast } from 'sonner';
import { PagesPage } from './PagesPage';
import { installVirtualizerRectShim } from '../../test-utils';

// No <Toaster/> is mounted in these unit tests (it lives at the app root,
// main.tsx), so a real `toast()` call renders nothing this suite can query.
// Mocked as a callable-with-methods stub so both `toast(...)` (the #945
// clear-filters undo toast) and `toast.success(...)` (the embedding-complete
// toast elsewhere in this file) keep working without a real Toaster.
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          {/* Provide the scroll container that PagesPage looks for via
              document.querySelector('[data-scroll-container]') */}
          <div data-scroll-container style={{ height: 800, overflow: 'auto' }}>
            {children}
          </div>
        </MemoryRouter>
      </QueryClientProvider>
    );
  };
}

const mockPagesResponse = {
  items: [
    {
      id: 'page-1',
      spaceKey: 'DEV',
      title: 'Test Page',
      version: 1,
      parentId: null,
      labels: ['howto'],
      author: 'Alice',
      lastModifiedAt: '2025-01-15T00:00:00Z',
      lastSynced: '2025-01-16T00:00:00Z',
      embeddingDirty: false,
      embeddingStatus: 'embedded',
      embeddedAt: '2025-01-16T00:00:00Z',
    },
  ],
  total: 1,
  page: 1,
  limit: 50,
  totalPages: 1,
};

const mockFilterOptions = {
  authors: ['Alice', 'Bob'],
  labels: ['howto', 'architecture', 'troubleshooting'],
};

const mockSpaces = [
  { key: 'DEV', name: 'Development', type: 'global' },
];

const mockEmbeddingStatusIdle = {
  totalPages: 50,
  embeddedPages: 50,
  dirtyPages: 0,
  totalEmbeddings: 50,
  isProcessing: false,
};

const mockEmbeddingStatusProcessing = {
  totalPages: 50,
  embeddedPages: 30,
  dirtyPages: 12,
  totalEmbeddings: 38,
  isProcessing: true,
};

function mockFetchWithEmbeddingStatus(embeddingStatus: typeof mockEmbeddingStatusIdle) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    if (url.includes('/embeddings/status')) {
      return new Response(JSON.stringify(embeddingStatus), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/pages/filters')) {
      return new Response(JSON.stringify(mockFilterOptions), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/spaces')) {
      return new Response(JSON.stringify(mockSpaces), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/sync/status')) {
      return new Response(JSON.stringify({ status: 'idle' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/pages/pinned')) {
      return new Response(JSON.stringify({ items: [], total: 0 }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/settings')) {
      return new Response(JSON.stringify({}), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    // Default: pages list
    return new Response(JSON.stringify(mockPagesResponse), {
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

/** Generate N mock page items for large-list tests */
function makeManyPages(n: number) {
  return {
    items: Array.from({ length: n }, (_, i) => ({
      id: `page-${i + 1}`,
      spaceKey: 'DEV',
      title: `Page ${i + 1}`,
      version: 1,
      parentId: null,
      labels: [],
      author: 'Alice',
      lastModifiedAt: '2025-01-15T00:00:00Z',
      lastSynced: '2025-01-16T00:00:00Z',
      embeddingDirty: false,
      embeddingStatus: 'embedded' as const,
      embeddedAt: '2025-01-16T00:00:00Z',
    })),
    total: n,
    page: 1,
    limit: n,
    totalPages: 1,
  };
}

const mockPinnedResponse = {
  items: [
    {
      id: 'pinned-1',
      spaceKey: 'DEV',
      title: 'Getting Started Guide',
      author: 'Alice',
      lastModifiedAt: '2025-05-20T00:00:00Z',
      excerpt: 'A guide for new developers.',
      pinnedAt: '2025-06-01T00:00:00Z',
      pinOrder: 0,
    },
    {
      id: 'pinned-2',
      spaceKey: 'OPS',
      title: 'Deployment Runbook',
      author: 'Bob',
      lastModifiedAt: '2025-05-25T00:00:00Z',
      excerpt: 'Step-by-step deployment instructions.',
      pinnedAt: '2025-06-02T00:00:00Z',
      pinOrder: 1,
    },
  ],
  total: 2,
};

const emptyPinnedResponse = { items: [], total: 0 };

function mockFetchWithPages(pagesResponse: ReturnType<typeof makeManyPages>) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    if (url.includes('/embeddings/status')) {
      return new Response(JSON.stringify(mockEmbeddingStatusIdle), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/pages/filters')) {
      return new Response(JSON.stringify(mockFilterOptions), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/spaces')) {
      return new Response(JSON.stringify(mockSpaces), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/sync/status')) {
      return new Response(JSON.stringify({ status: 'idle' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/pages/pinned')) {
      return new Response(JSON.stringify({ items: [], total: 0 }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/settings')) {
      return new Response(JSON.stringify({}), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(pagesResponse), {
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

function mockFetchWithPinnedPages(pinnedResponse: typeof mockPinnedResponse | typeof emptyPinnedResponse) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    if (url.includes('/embeddings/status')) {
      return new Response(JSON.stringify(mockEmbeddingStatusIdle), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/pages/filters')) {
      return new Response(JSON.stringify(mockFilterOptions), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/spaces')) {
      return new Response(JSON.stringify(mockSpaces), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/sync/status')) {
      return new Response(JSON.stringify({ status: 'idle' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/pages/pinned')) {
      return new Response(JSON.stringify(pinnedResponse), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/settings')) {
      return new Response(JSON.stringify({}), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(mockPagesResponse), {
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

describe('PagesPage', () => {
  let restoreRects: () => void;

  beforeEach(() => {
    mockFetchWithEmbeddingStatus(mockEmbeddingStatusIdle);
    restoreRects = installVirtualizerRectShim();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restoreRects();
  });

  it('renders KPI cards at the top of the page', () => {
    render(<PagesPage />, { wrapper: createWrapper() });
    expect(screen.getByTestId('kpi-cards')).toBeInTheDocument();
    expect(screen.getByTestId('kpi-total-articles')).toBeInTheDocument();
    expect(screen.getByTestId('kpi-embedded-pages')).toBeInTheDocument();
    expect(screen.getByTestId('kpi-spaces-synced')).toBeInTheDocument();
    expect(screen.getByTestId('kpi-last-sync')).toBeInTheDocument();
    expect(screen.getByTestId('kpi-embedding-coverage')).toBeInTheDocument();
  });

  it('keeps corpus KPIs out of the 48px header slot', () => {
    render(<PagesPage />, { wrapper: createWrapper() });
    const kpis = screen.getByTestId('kpi-cards');
    expect(kpis.closest('#app-header-slot')).toBeNull();
    expect(kpis.closest('header')).toBeNull();
  });

  it('keeps Trash and New Page out of the 48px header slot', () => {
    render(<PagesPage />, { wrapper: createWrapper() });
    expect(screen.getByTestId('trash-link').closest('#app-header-slot')).toBeNull();
    expect(screen.getByTestId('new-page-button').closest('#app-header-slot')).toBeNull();
    expect(screen.getByTestId('trash-link').closest('header')).toBeNull();
    expect(screen.getByTestId('new-page-button').closest('header')).toBeNull();
  });

  it('renders the page title, search input, and filter controls', () => {
    render(<PagesPage />, { wrapper: createWrapper() });
    expect(screen.getByText('Pages')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Search pages...')).toBeInTheDocument();
    expect(screen.getByTestId('advanced-filters-toggle')).toBeInTheDocument();
  });

  it('puts the list search before pinned pages', async () => {
    vi.restoreAllMocks();
    mockFetchWithPinnedPages(mockPinnedResponse);
    render(<PagesPage />, { wrapper: createWrapper() });
    const search = screen.getByLabelText('Search pages');
    const pinned = await screen.findByTestId('pinned-articles-section');
    expect(
      search.compareDocumentPosition(pinned) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('demotes New Page from the filled primary treatment', () => {
    render(<PagesPage />, { wrapper: createWrapper() });
    const newPage = screen.getByTestId('new-page-button');
    expect(newPage.className).toContain('nm-button-ghost');
    expect(newPage.className).not.toContain('nm-button-primary');
  });

  it('renders the advanced filters toggle button', () => {
    render(<PagesPage />, { wrapper: createWrapper() });
    const btn = screen.getByTestId('advanced-filters-toggle');
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveTextContent('Filters');
  });

  it('shows advanced filters panel when toggle is clicked', () => {
    render(<PagesPage />, { wrapper: createWrapper() });
    const btn = screen.getByTestId('advanced-filters-toggle');
    fireEvent.click(btn);
    expect(screen.getByTestId('advanced-filters-panel')).toBeInTheDocument();
    expect(screen.getByTestId('filter-author')).toBeInTheDocument();
    expect(screen.getByTestId('filter-labels')).toBeInTheDocument();
    expect(screen.getByTestId('filter-freshness')).toBeInTheDocument();
    expect(screen.getByTestId('filter-embedding')).toBeInTheDocument();
    expect(screen.getByTestId('filter-date-from')).toBeInTheDocument();
    expect(screen.getByTestId('filter-date-to')).toBeInTheDocument();
  });

  it('hides advanced filters panel when toggle is clicked again', () => {
    render(<PagesPage />, { wrapper: createWrapper() });
    const btn = screen.getByTestId('advanced-filters-toggle');
    fireEvent.click(btn);
    expect(screen.getByTestId('advanced-filters-panel')).toBeInTheDocument();
    fireEvent.click(btn);
    expect(screen.queryByTestId('advanced-filters-panel')).not.toBeInTheDocument();
  });

  it('shows active filter count badge when filters are selected', () => {
    render(<PagesPage />, { wrapper: createWrapper() });
    // Open advanced filters
    fireEvent.click(screen.getByTestId('advanced-filters-toggle'));

    // Select a freshness filter
    fireEvent.change(screen.getByTestId('filter-freshness'), { target: { value: 'fresh' } });

    // Badge should show 1
    const badge = screen.getByTestId('advanced-filters-toggle');
    expect(badge).toHaveTextContent('1');
  });

  it('shows the "Clear all" pill-row control when filters are active (harden pass: the panel no longer duplicates it)', () => {
    render(<PagesPage />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByTestId('advanced-filters-toggle'));
    fireEvent.change(screen.getByTestId('filter-freshness'), { target: { value: 'stale' } });
    expect(screen.getByTestId('clear-all-pill-filters')).toBeInTheDocument();
    // The panel's own duplicate "Clear filters" button is gone — one control,
    // not two disagreeing on label and visual weight (polish pass, 2026-08-17).
    expect(screen.queryByTestId('clear-filters')).not.toBeInTheDocument();
  });

  it('clears all advanced filters when "Clear all" is clicked, and shows a 5s undo toast', () => {
    render(<PagesPage />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByTestId('advanced-filters-toggle'));

    // Set some filters
    fireEvent.change(screen.getByTestId('filter-freshness'), { target: { value: 'stale' } });
    fireEvent.change(screen.getByTestId('filter-embedding'), { target: { value: 'pending' } });

    // Click clear
    fireEvent.click(screen.getByTestId('clear-all-pill-filters'));

    // Verify filters are reset
    expect((screen.getByTestId('filter-freshness') as HTMLSelectElement).value).toBe('');
    expect((screen.getByTestId('filter-embedding') as HTMLSelectElement).value).toBe('');
    expect(screen.queryByTestId('clear-all-pill-filters')).not.toBeInTheDocument();

    expect(toast).toHaveBeenCalledWith('Filters cleared', expect.objectContaining({
      duration: 5000,
      action: expect.objectContaining({ label: 'Undo' }),
    }));
  });

  it('"Undo" on the clear-filters toast restores the cleared filters', () => {
    render(<PagesPage />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByTestId('advanced-filters-toggle'));
    fireEvent.change(screen.getByTestId('filter-freshness'), { target: { value: 'stale' } });

    fireEvent.click(screen.getByTestId('clear-all-pill-filters'));
    expect((screen.getByTestId('filter-freshness') as HTMLSelectElement).value).toBe('');

    // No <Toaster/> is mounted in this suite, so there is no rendered "Undo"
    // button to click — invoke the action the mocked toast() was called
    // with, exactly as a real Toaster would when the user clicks it.
    const call = vi.mocked(toast).mock.calls.at(-1);
    act(() => {
      call?.[1]?.action?.onClick?.(new MouseEvent('click') as unknown as Event);
    });

    expect((screen.getByTestId('filter-freshness') as HTMLSelectElement).value).toBe('stale');
  });

  it('the "Clear all" control is never styled as destructive (clearing filters loses no data)', () => {
    render(<PagesPage />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByTestId('advanced-filters-toggle'));
    fireEvent.change(screen.getByTestId('filter-freshness'), { target: { value: 'stale' } });

    const clearAll = screen.getByTestId('clear-all-pill-filters');
    expect(clearAll.className).not.toContain('destructive');
  });

  it('renders freshness filter options', () => {
    render(<PagesPage />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByTestId('advanced-filters-toggle'));
    const select = screen.getByTestId('filter-freshness') as HTMLSelectElement;
    expect(select.options.length).toBe(5); // Any + 4 levels
  });

  it('renders embedding status filter options', () => {
    render(<PagesPage />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByTestId('advanced-filters-toggle'));
    const select = screen.getByTestId('filter-embedding') as HTMLSelectElement;
    expect(select.options.length).toBe(3); // Any + pending + done
  });

  it('updates freshness filter select value when changed', () => {
    render(<PagesPage />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByTestId('advanced-filters-toggle'));
    const select = screen.getByTestId('filter-freshness') as HTMLSelectElement;
    // Freshness options are static (not from API), so they're always available
    fireEvent.change(select, { target: { value: 'stale' } });
    expect(select.value).toBe('stale');
  });

  it('renders article title left-aligned without preceding icon', async () => {
    render(<PagesPage />, { wrapper: createWrapper() });
    const title = await screen.findByText('Test Page');
    expect(title).toBeInTheDocument();
    // Title ancestor container should have text-left alignment
    // (title is inside a flex wrapper for badges, which is inside the text-left container)
    const textLeftAncestor = title.closest('.text-left');
    expect(textLeftAncestor).not.toBeNull();
  });

  it('shows embedding progress banner when embedding is processing', async () => {
    vi.restoreAllMocks();
    mockFetchWithEmbeddingStatus(mockEmbeddingStatusProcessing);
    render(<PagesPage />, { wrapper: createWrapper() });
    const banner = await screen.findByTestId('embedding-progress-banner');
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveTextContent('Embedding in progress');
    expect(banner).toHaveTextContent('12 pages remaining');
    expect(banner).toHaveTextContent('30/50');
  });

  it('does not show embedding progress banner when embedding is idle', async () => {
    render(<PagesPage />, { wrapper: createWrapper() });
    // Wait for pages to load to ensure all queries have resolved
    await screen.findByText('Test Page');
    expect(screen.queryByTestId('embedding-progress-banner')).not.toBeInTheDocument();
  });

  // --- Virtual scrolling tests (#511) ---

  it('renders a virtual list container for the page list', async () => {
    render(<PagesPage />, { wrapper: createWrapper() });
    await screen.findByTestId('virtual-list-container');
    expect(screen.getByTestId('virtual-list-container')).toBeInTheDocument();
  });

  it('uses the app-level scroll container (no nested overflow)', async () => {
    render(<PagesPage />, { wrapper: createWrapper() });
    await screen.findByTestId('virtual-list-container');
    const container = screen.getByTestId('virtual-list-container');
    // The virtual list container should not have its own overflow scrolling
    const style = container.style;
    expect(style.overflow).not.toBe('auto');
    expect(style.overflow).not.toBe('scroll');
  });

  // --- Pinned articles section tests ---

  it('renders pinned articles section when user has pinned pages', async () => {
    vi.restoreAllMocks();
    mockFetchWithPinnedPages(mockPinnedResponse);
    render(<PagesPage />, { wrapper: createWrapper() });

    const section = await screen.findByTestId('pinned-articles-section');
    expect(section).toBeInTheDocument();
    expect(screen.getByText('Pinned Pages')).toBeInTheDocument();
    expect(screen.getByText('Getting Started Guide')).toBeInTheDocument();
    expect(screen.getByText('Deployment Runbook')).toBeInTheDocument();
  });

  it('does not render pinned articles section when user has no pinned pages', async () => {
    vi.restoreAllMocks();
    mockFetchWithPinnedPages(emptyPinnedResponse);
    render(<PagesPage />, { wrapper: createWrapper() });

    // Wait for page list to render so all queries are settled
    await screen.findByText('Test Page');
    expect(screen.queryByTestId('pinned-articles-section')).not.toBeInTheDocument();
  });

  it('renders the filters section before pinned articles', async () => {
    vi.restoreAllMocks();
    mockFetchWithPinnedPages(mockPinnedResponse);
    render(<PagesPage />, { wrapper: createWrapper() });

    const section = await screen.findByTestId('pinned-articles-section');
    const filtersToggle = screen.getByTestId('advanced-filters-toggle');

    // Find is the first content control; pinned follows it.
    const comparison = filtersToggle.compareDocumentPosition(section);
    expect(comparison & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  describe('error state (pages query failed)', () => {
    /** Mock fetch where /pages errors with the given status, but all other
     *  endpoints return their normal mock responses. */
    function mockFetchWithPagesError(status: number, message: string) {
      return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const url = typeof input === 'string' ? input : (input as Request).url;
        if (url.includes('/embeddings/status')) {
          return new Response(JSON.stringify(mockEmbeddingStatusIdle), { headers: { 'Content-Type': 'application/json' } });
        }
        if (url.includes('/pages/filters')) {
          return new Response(JSON.stringify(mockFilterOptions), { headers: { 'Content-Type': 'application/json' } });
        }
        if (url.includes('/spaces')) {
          return new Response(JSON.stringify(mockSpaces), { headers: { 'Content-Type': 'application/json' } });
        }
        if (url.includes('/sync/status')) {
          return new Response(JSON.stringify({ status: 'idle' }), { headers: { 'Content-Type': 'application/json' } });
        }
        if (url.includes('/pages/pinned')) {
          return new Response(JSON.stringify({ items: [], total: 0 }), { headers: { 'Content-Type': 'application/json' } });
        }
        if (url.includes('/settings')) {
          return new Response(JSON.stringify({}), { headers: { 'Content-Type': 'application/json' } });
        }
        // /api/pages list query — fail with the requested status
        return new Response(JSON.stringify({ message }), {
          status,
          headers: { 'Content-Type': 'application/json' },
        });
      });
    }

    it('renders the error panel (not "No pages found") when the pages query fails', async () => {
      vi.restoreAllMocks();
      mockFetchWithPagesError(429, 'Rate limit exceeded, retry in 9 seconds');
      render(<PagesPage />, { wrapper: createWrapper() });

      // The error panel must render with the API message — NOT the misleading
      // "No pages found" empty state (which historically appeared for any
      // undefined pagesData and tricked users into thinking they had zero
      // articles when the real cause was a transient 429).
      expect(await screen.findByTestId('pages-error-state')).toBeInTheDocument();
      expect(screen.getByText("Couldn't load pages")).toBeInTheDocument();
      expect(screen.getByText('Rate limit exceeded, retry in 9 seconds')).toBeInTheDocument();
      expect(screen.queryByTestId('empty-state-title')).not.toBeInTheDocument();
    });

    it('does not show the misleading empty state even when items array would also be missing', async () => {
      vi.restoreAllMocks();
      mockFetchWithPagesError(500, 'Internal Server Error');
      render(<PagesPage />, { wrapper: createWrapper() });

      await screen.findByTestId('pages-error-state');
      // "No pages found" was the historical lie — never both UIs at once,
      // and not the empty state when the real issue is a failed fetch.
      expect(screen.queryByText('No pages found')).not.toBeInTheDocument();
    });

    it('shows a Retry button that calls refetch (and recovers when the server starts responding again)', async () => {
      vi.restoreAllMocks();
      let shouldFail = true;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const url = typeof input === 'string' ? input : (input as Request).url;
        if (url.includes('/embeddings/status')) return new Response(JSON.stringify(mockEmbeddingStatusIdle), { headers: { 'Content-Type': 'application/json' } });
        if (url.includes('/pages/filters')) return new Response(JSON.stringify(mockFilterOptions), { headers: { 'Content-Type': 'application/json' } });
        if (url.includes('/spaces')) return new Response(JSON.stringify(mockSpaces), { headers: { 'Content-Type': 'application/json' } });
        if (url.includes('/sync/status')) return new Response(JSON.stringify({ status: 'idle' }), { headers: { 'Content-Type': 'application/json' } });
        if (url.includes('/pages/pinned')) return new Response(JSON.stringify({ items: [], total: 0 }), { headers: { 'Content-Type': 'application/json' } });
        if (url.includes('/settings')) return new Response(JSON.stringify({}), { headers: { 'Content-Type': 'application/json' } });
        if (shouldFail) {
          return new Response(JSON.stringify({ message: 'Rate limited' }), {
            status: 429, headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify(mockPagesResponse), { headers: { 'Content-Type': 'application/json' } });
      });

      render(<PagesPage />, { wrapper: createWrapper() });
      const retry = await screen.findByTestId('pages-error-retry');

      shouldFail = false;
      fireEvent.click(retry);

      // After successful refetch the error panel goes away and the article list renders
      await screen.findByText('Test Page');
      expect(screen.queryByTestId('pages-error-state')).not.toBeInTheDocument();
    });
  });

  describe('empty state (no pages)', () => {
    const emptyPages = { items: [], total: 0, page: 1, limit: 50, totalPages: 0 };

    it('renders EmptyState with "No pages found" title', async () => {
      vi.restoreAllMocks();
      mockFetchWithPages(emptyPages as ReturnType<typeof makeManyPages>);
      render(<PagesPage />, { wrapper: createWrapper() });
      expect(await screen.findByTestId('empty-state-title')).toHaveTextContent('No pages found');
    });

    it('shows "Go to Settings" action button when no search is active', async () => {
      vi.restoreAllMocks();
      mockFetchWithPages(emptyPages as ReturnType<typeof makeManyPages>);
      render(<PagesPage />, { wrapper: createWrapper() });
      expect(await screen.findByText('Go to Settings')).toBeInTheDocument();
    });

    it('shows "Try a different search term" when search is active', async () => {
      vi.restoreAllMocks();
      mockFetchWithPages(emptyPages as ReturnType<typeof makeManyPages>);
      render(<PagesPage />, { wrapper: createWrapper() });
      // Type in the search box
      const searchInput = screen.getByPlaceholderText('Search pages...');
      fireEvent.change(searchInput, { target: { value: 'nonexistent' } });
      expect(await screen.findByText('Try a different search term')).toBeInTheDocument();
    });

    it('hides "Go to Settings" action when search is active', async () => {
      vi.restoreAllMocks();
      mockFetchWithPages(emptyPages as ReturnType<typeof makeManyPages>);
      render(<PagesPage />, { wrapper: createWrapper() });
      const searchInput = screen.getByPlaceholderText('Search pages...');
      fireEvent.change(searchInput, { target: { value: 'nonexistent' } });
      // Wait for re-render
      await screen.findByText('Try a different search term');
      expect(screen.queryByText('Go to Settings')).not.toBeInTheDocument();
    });

    // --- Empty state misdiagnosis (harden pass, 2026-08-17) ---
    //
    // This branched on `search` alone and never consulted the active
    // filters: filtering to zero results reported "Sync your Confluence
    // spaces to see pages here" and sent the user to Settings — the wrong
    // room for a problem their own filters caused, with no mention of which
    // filter did it and no way to clear it from this screen.
    describe('when filters (not corpus emptiness) caused the empty result set', () => {
      it('names the active filter instead of blaming an unsynced knowledge base', async () => {
        vi.restoreAllMocks();
        mockFetchWithPages(emptyPages as ReturnType<typeof makeManyPages>);
        render(<PagesPage />, { wrapper: createWrapper() });

        fireEvent.click(screen.getByTestId('advanced-filters-toggle'));
        fireEvent.change(screen.getByTestId('filter-freshness'), { target: { value: 'stale' } });

        expect(await screen.findByText(/No pages match Freshness: Stale \(>90 days\)/)).toBeInTheDocument();
        expect(screen.queryByText('Sync your Confluence spaces to see pages here')).not.toBeInTheDocument();
      });

      it('shows "Clear filters" instead of "Go to Settings" as the primary action', async () => {
        vi.restoreAllMocks();
        mockFetchWithPages(emptyPages as ReturnType<typeof makeManyPages>);
        render(<PagesPage />, { wrapper: createWrapper() });

        fireEvent.click(screen.getByTestId('advanced-filters-toggle'));
        fireEvent.change(screen.getByTestId('filter-freshness'), { target: { value: 'stale' } });

        expect(await screen.findByText('Clear filters')).toBeInTheDocument();
        expect(screen.queryByText('Go to Settings')).not.toBeInTheDocument();
      });

      it('clicking "Clear filters" in the empty state actually clears the filter', async () => {
        vi.restoreAllMocks();
        mockFetchWithPages(emptyPages as ReturnType<typeof makeManyPages>);
        render(<PagesPage />, { wrapper: createWrapper() });

        fireEvent.click(screen.getByTestId('advanced-filters-toggle'));
        fireEvent.change(screen.getByTestId('filter-freshness'), { target: { value: 'stale' } });
        const clearAction = await screen.findByText('Clear filters');

        fireEvent.click(clearAction);

        await waitFor(() => {
          expect((screen.getByTestId('filter-freshness') as HTMLSelectElement).value).toBe('');
        });
      });

      it('mentions both the search term and the filter when both are active', async () => {
        vi.restoreAllMocks();
        mockFetchWithPages(emptyPages as ReturnType<typeof makeManyPages>);
        render(<PagesPage />, { wrapper: createWrapper() });

        fireEvent.click(screen.getByTestId('advanced-filters-toggle'));
        fireEvent.change(screen.getByTestId('filter-freshness'), { target: { value: 'stale' } });
        fireEvent.change(screen.getByPlaceholderText('Search pages...'), { target: { value: 'zzznotathing' } });

        expect(await screen.findByText('No pages match "zzznotathing" with Freshness: Stale (>90 days)')).toBeInTheDocument();
      });

      it('summarizes more than 3 active filters instead of listing every label', async () => {
        vi.restoreAllMocks();
        mockFetchWithPages(emptyPages as ReturnType<typeof makeManyPages>);
        render(<PagesPage />, { wrapper: createWrapper() });

        fireEvent.click(screen.getByTestId('advanced-filters-toggle'));
        await waitFor(() => expect(screen.getByRole('option', { name: 'Alice' })).toBeInTheDocument());
        fireEvent.change(screen.getByTestId('filter-freshness'), { target: { value: 'stale' } });
        fireEvent.change(screen.getByTestId('filter-embedding'), { target: { value: 'pending' } });
        fireEvent.change(screen.getByTestId('filter-quality'), { target: { value: 'poor' } });
        fireEvent.change(screen.getByTestId('filter-author'), { target: { value: 'Alice' } });

        expect(await screen.findByText(/and 1 more/)).toBeInTheDocument();
      });
    });
  });

  // --- Similarity percentage on search results (#1117) ---

  describe('search result similarity percentage (#1117)', () => {
    /**
     * Mock fetch where /search returns the given items.
     *
     * `useSearch` fires two requests — a keyword one (phase 1, immediateResults)
     * and a semantic one (phase 2, enhancedResults) — and the component renders
     * `enhancedResults ?? immediateResults`. The real keyword branch never emits
     * `similarity` (routes/knowledge/search.ts builds those items with `rank`
     * and `snippet` only), so this mock strips it from the keyword reply too.
     * Serving it on both legs would let these tests pass with the semantic query
     * failing outright, or with the `??` fallback deleted — a green suite for a
     * feature that renders nothing in production.
     */
    function mockFetchWithSearchItems(items: unknown[]) {
      return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const url = typeof input === 'string' ? input : (input as Request).url;
        if (url.includes('/search?')) {
          const mode = new URL(url, 'http://localhost').searchParams.get('mode') ?? 'keyword';
          const body = mode === 'keyword'
            ? items.map((it) =>
                Object.fromEntries(
                  Object.entries(it as Record<string, unknown>).filter(([k]) => k !== 'similarity'),
                ),
              )
            : items;
          return new Response(
            JSON.stringify({ items: body, total: body.length, page: 1, limit: 10, totalPages: 1, mode, hasEmbeddings: true }),
            { headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (url.includes('/embeddings/status')) {
          return new Response(JSON.stringify(mockEmbeddingStatusIdle), { headers: { 'Content-Type': 'application/json' } });
        }
        if (url.includes('/pages/filters')) {
          return new Response(JSON.stringify(mockFilterOptions), { headers: { 'Content-Type': 'application/json' } });
        }
        if (url.includes('/spaces')) {
          return new Response(JSON.stringify(mockSpaces), { headers: { 'Content-Type': 'application/json' } });
        }
        if (url.includes('/sync/status')) {
          return new Response(JSON.stringify({ status: 'idle' }), { headers: { 'Content-Type': 'application/json' } });
        }
        if (url.includes('/pages/pinned')) {
          return new Response(JSON.stringify({ items: [], total: 0 }), { headers: { 'Content-Type': 'application/json' } });
        }
        if (url.includes('/settings')) {
          return new Response(JSON.stringify({}), { headers: { 'Content-Type': 'application/json' } });
        }
        return new Response(JSON.stringify(mockPagesResponse), { headers: { 'Content-Type': 'application/json' } });
      });
    }

    function renderSearchWith(items: unknown[]) {
      vi.restoreAllMocks();
      mockFetchWithSearchItems(items);
      render(<PagesPage />, { wrapper: createWrapper() });
      // Semantic mode is load-bearing, but not because of the similarity:
      // `useSemanticSearch = !!(search && searchMode !== 'keyword')` gates the
      // whole search-results section, so keyword mode never renders a result
      // row at all.
      fireEvent.change(screen.getByPlaceholderText('Search pages...'), {
        target: { value: 'redis' },
      });
      fireEvent.click(screen.getByTestId('search-mode-semantic'));
    }

    it('renders the similarity, not the ranking score', async () => {
      // `rank`/`score` here are an RRF fusion value. Rendering those produced
      // "2%" for a strong match; the similarity is 0.74 -> "74%".
      renderSearchWith([
        { id: 1, title: 'Redis Guide', spaceKey: 'DEV', snippet: 'x', rank: 0.0328, score: 0.0328, similarity: 0.74 },
      ]);

      expect(await screen.findByText('Redis Guide', undefined, { timeout: 2000 })).toBeInTheDocument();
      expect(screen.getByText('74%')).toBeInTheDocument();
      expect(screen.queryByText('3%')).not.toBeInTheDocument();
    });

    it('renders no percentage when no similarity was measured', async () => {
      // Keyword mode, or a hybrid row matched only by full-text. A page nobody
      // measured must show nothing rather than "0%".
      renderSearchWith([
        { id: 2, title: 'Keyword Only', spaceKey: 'DEV', snippet: 'x', rank: 0.5, similarity: null },
      ]);

      expect(await screen.findByText('Keyword Only', undefined, { timeout: 2000 })).toBeInTheDocument();
      expect(screen.queryByText('50%')).not.toBeInTheDocument();
      expect(screen.queryByText('0%')).not.toBeInTheDocument();
    });

    it('renders no percentage for a negative similarity', async () => {
      // pgvector cosine distance runs to 2, so `1 - distance` can be negative.
      // "-40%" is not a useful badge.
      renderSearchWith([
        { id: 3, title: 'Opposing Page', spaceKey: 'DEV', snippet: 'x', rank: 0.1, similarity: -0.4 },
      ]);

      expect(await screen.findByText('Opposing Page', undefined, { timeout: 2000 })).toBeInTheDocument();
      // Assert the badge is ABSENT, not merely that "-40%" is missing: an
      // implementation that clamped to 0 would render "0%" and satisfy the
      // weaker check while still showing a figure for a chunk pointing away
      // from the query.
      expect(screen.queryByTitle('Semantic similarity to your query')).not.toBeInTheDocument();
    });
  });

  // --- Semantic search empty state (#938, review follow-up on #993) ---

  describe('semantic search empty state (#938)', () => {
    /** Mock fetch where /search returns zero results for every mode, with the
     *  given hasEmbeddings flag. All other endpoints return their normal mocks. */
    function mockFetchWithEmptySearch(hasEmbeddings: boolean) {
      return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const url = typeof input === 'string' ? input : (input as Request).url;
        if (url.includes('/search?')) {
          const mode = new URL(url, 'http://localhost').searchParams.get('mode') ?? 'keyword';
          return new Response(
            JSON.stringify({ items: [], total: 0, page: 1, limit: 10, totalPages: 0, mode, hasEmbeddings }),
            { headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (url.includes('/embeddings/status')) {
          return new Response(JSON.stringify(mockEmbeddingStatusIdle), { headers: { 'Content-Type': 'application/json' } });
        }
        if (url.includes('/pages/filters')) {
          return new Response(JSON.stringify(mockFilterOptions), { headers: { 'Content-Type': 'application/json' } });
        }
        if (url.includes('/spaces')) {
          return new Response(JSON.stringify(mockSpaces), { headers: { 'Content-Type': 'application/json' } });
        }
        if (url.includes('/sync/status')) {
          return new Response(JSON.stringify({ status: 'idle' }), { headers: { 'Content-Type': 'application/json' } });
        }
        if (url.includes('/pages/pinned')) {
          return new Response(JSON.stringify({ items: [], total: 0 }), { headers: { 'Content-Type': 'application/json' } });
        }
        if (url.includes('/settings')) {
          return new Response(JSON.stringify({}), { headers: { 'Content-Type': 'application/json' } });
        }
        return new Response(JSON.stringify(mockPagesResponse), { headers: { 'Content-Type': 'application/json' } });
      });
    }

    /** Render, switch to semantic mode, and type a query that matches nothing.
     *  useSearch debounces 300ms before firing, so assertions must findBy/waitFor. */
    function renderSemanticSearchWithNoResults(hasEmbeddings: boolean) {
      vi.restoreAllMocks();
      const fetchSpy = mockFetchWithEmptySearch(hasEmbeddings);
      render(<PagesPage />, { wrapper: createWrapper() });
      fireEvent.change(screen.getByPlaceholderText('Search pages...'), {
        target: { value: 'nonexistent topic' },
      });
      fireEvent.click(screen.getByTestId('search-mode-semantic'));
      return fetchSpy;
    }

    /** Mock fetch where /search answers mode-aware, production-realistic
     *  responses: keyword mode never carries the coverage signal, the
     *  semantic/hybrid response does (#1117). */
    function mockFetchWithCoverage(opts: {
      hasEmbeddings: boolean;
      embeddingCoverage: number | null;
      degradedReason: 'no_embeddings' | 'partial_embeddings' | null;
    }) {
      return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const url = typeof input === 'string' ? input : (input as Request).url;
        if (url.includes('/search?')) {
          const mode = new URL(url, 'http://localhost').searchParams.get('mode') ?? 'keyword';
          const signal =
            mode === 'keyword'
              ? { hasEmbeddings: true, embeddingCoverage: null, degradedReason: null }
              : opts;
          return new Response(
            JSON.stringify({
              items: [{ id: 7, title: 'Runbook', spaceKey: 'DEV', snippet: 'restart', rank: 0.5, similarity: 0.9 }],
              total: 1, page: 1, limit: 10, totalPages: 1, mode, ...signal,
            }),
            { headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (url.includes('/embeddings/status')) {
          return new Response(JSON.stringify(mockEmbeddingStatusIdle), { headers: { 'Content-Type': 'application/json' } });
        }
        if (url.includes('/pages/filters')) {
          return new Response(JSON.stringify(mockFilterOptions), { headers: { 'Content-Type': 'application/json' } });
        }
        if (url.includes('/spaces')) {
          return new Response(JSON.stringify(mockSpaces), { headers: { 'Content-Type': 'application/json' } });
        }
        if (url.includes('/sync/status')) {
          return new Response(JSON.stringify({ status: 'idle' }), { headers: { 'Content-Type': 'application/json' } });
        }
        if (url.includes('/pages/pinned')) {
          return new Response(JSON.stringify({ items: [], total: 0 }), { headers: { 'Content-Type': 'application/json' } });
        }
        if (url.includes('/settings')) {
          return new Response(JSON.stringify({}), { headers: { 'Content-Type': 'application/json' } });
        }
        return new Response(JSON.stringify(mockPagesResponse), { headers: { 'Content-Type': 'application/json' } });
      });
    }

    function renderSemanticSearch() {
      render(<PagesPage />, { wrapper: createWrapper() });
      fireEvent.change(screen.getByPlaceholderText('Search pages...'), {
        target: { value: 'runbook' },
      });
      fireEvent.click(screen.getByTestId('search-mode-semantic'));
    }

    it('partial coverage: degraded banner names the measured percentage (#1117)', async () => {
      vi.restoreAllMocks();
      mockFetchWithCoverage({ hasEmbeddings: true, embeddingCoverage: 0.42, degradedReason: 'partial_embeddings' });
      renderSemanticSearch();

      const banner = await screen.findByTestId('degraded-embeddings-warning', undefined, { timeout: 2000 });
      expect(banner).toHaveTextContent('42%');
      // The zero-embeddings banner is a different state and must not stack.
      expect(screen.queryByTestId('no-embeddings-warning')).not.toBeInTheDocument();
    });

    it('degraded banner never claims 0% or the threshold value at the edges (review r1)', async () => {
      // 0.0033 coverage must not render "only 0%" (that state is the sibling
      // zero-embeddings banner's), and 0.949 must not render "95%" — the copy
      // would contradict the <95% threshold that made it degraded.
      vi.restoreAllMocks();
      mockFetchWithCoverage({ hasEmbeddings: true, embeddingCoverage: 0.0033, degradedReason: 'partial_embeddings' });
      renderSemanticSearch();
      const banner = await screen.findByTestId('degraded-embeddings-warning', undefined, { timeout: 2000 });
      expect(banner).toHaveTextContent('less than 1%');
      expect(banner).not.toHaveTextContent('only 0%');
      cleanup();

      vi.restoreAllMocks();
      mockFetchWithCoverage({ hasEmbeddings: true, embeddingCoverage: 0.949, degradedReason: 'partial_embeddings' });
      renderSemanticSearch();
      const banner2 = await screen.findByTestId('degraded-embeddings-warning', undefined, { timeout: 2000 });
      expect(banner2).toHaveTextContent('94%');
      expect(banner2).not.toHaveTextContent('95%');
      cleanup();

      // 29/100 embedded must say 29%, not 28 — Math.floor(0.29 * 100) is 28
      // in binary floating point (review r2).
      vi.restoreAllMocks();
      mockFetchWithCoverage({ hasEmbeddings: true, embeddingCoverage: 0.29, degradedReason: 'partial_embeddings' });
      renderSemanticSearch();
      const banner3 = await screen.findByTestId('degraded-embeddings-warning', undefined, { timeout: 2000 });
      expect(banner3).toHaveTextContent('29%');
    });

    it('full coverage: no degraded banner, no zero-embeddings banner (#1117)', async () => {
      vi.restoreAllMocks();
      mockFetchWithCoverage({ hasEmbeddings: true, embeddingCoverage: 1, degradedReason: null });
      renderSemanticSearch();

      // Wait for results to land, then pin the absence of both banners.
      await screen.findAllByText('Runbook', undefined, { timeout: 2000 });
      expect(screen.queryByTestId('degraded-embeddings-warning')).not.toBeInTheDocument();
      expect(screen.queryByTestId('no-embeddings-warning')).not.toBeInTheDocument();
    });

    it('zero embeddings + zero results: empty state acknowledges the keyword fallback and the missing embeddings', async () => {
      renderSemanticSearchWithNoResults(false);

      // The fallback banner and the empty state show together, so their copy
      // must not contradict: the banner already says keyword search ran, so
      // the empty state must not imply embedding alone would find a match.
      expect(await screen.findByText('No matching pages', undefined, { timeout: 2000 })).toBeInTheDocument();
      expect(
        screen.getByText('Keyword search found no matches. Semantic search is unavailable until pages are embedded — configure an embedding provider in Settings → AI Models and run an embedding pass.'),
      ).toBeInTheDocument();
      expect(screen.getByTestId('no-embeddings-warning')).toBeInTheDocument();
    });

    it('embeddings exist + zero results: empty state blames the query, not embeddings', async () => {
      const fetchSpy = renderSemanticSearchWithNoResults(true);

      // Wait for the debounced search queries to actually fire and settle so
      // the assertion pins the resolved state, not the optimistic first render.
      await waitFor(
        () => {
          const urls = fetchSpy.mock.calls.map(([input]) =>
            typeof input === 'string' ? input : (input as Request).url,
          );
          expect(urls.some((u) => u.includes('/search?') && u.includes('mode=semantic'))).toBe(true);
        },
        { timeout: 2000 },
      );

      expect(await screen.findByTestId('empty-state-title')).toHaveTextContent('No pages found');
      expect(screen.getByText('Try a different search term or switch to keyword mode')).toBeInTheDocument();
      expect(screen.queryByTestId('no-embeddings-warning')).not.toBeInTheDocument();
      expect(screen.queryByText(/Semantic search is unavailable until pages are embedded/)).not.toBeInTheDocument();
    });
  });

  // --- Search clear button tests ---

  it('does not show search clear button when search is empty', () => {
    render(<PagesPage />, { wrapper: createWrapper() });
    expect(screen.queryByTestId('search-clear')).not.toBeInTheDocument();
  });

  it('shows search clear button when search has text', () => {
    render(<PagesPage />, { wrapper: createWrapper() });
    const input = screen.getByPlaceholderText('Search pages...');
    fireEvent.change(input, { target: { value: 'test query' } });
    expect(screen.getByTestId('search-clear')).toBeInTheDocument();
  });

  it('clears search when clear button is clicked', () => {
    render(<PagesPage />, { wrapper: createWrapper() });
    const input = screen.getByPlaceholderText('Search pages...') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'test query' } });
    expect(input.value).toBe('test query');

    fireEvent.click(screen.getByTestId('search-clear'));
    expect(input.value).toBe('');
    expect(screen.queryByTestId('search-clear')).not.toBeInTheDocument();
  });

  // --- Active filter pills tests ---

  it('shows active filter pills when filters are set', () => {
    render(<PagesPage />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByTestId('advanced-filters-toggle'));
    fireEvent.change(screen.getByTestId('filter-freshness'), { target: { value: 'stale' } });

    expect(screen.getByTestId('active-filter-pills')).toBeInTheDocument();
    // Human label, not the raw wire value (polish pass, 2026-08-17) — the
    // dropdown that set this reads "Stale (>90 days)"; the pill used to
    // print "stale", forcing the user to translate between two vocabularies
    // for the same value.
    expect(screen.getByTestId('filter-pill-freshness')).toHaveTextContent('Freshness: Stale (>90 days)');
  });

  it('does not show active filter pills when no filters are active', () => {
    render(<PagesPage />, { wrapper: createWrapper() });
    expect(screen.queryByTestId('active-filter-pills')).not.toBeInTheDocument();
  });

  it('shows multiple filter pills when multiple filters are set', () => {
    render(<PagesPage />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByTestId('advanced-filters-toggle'));
    fireEvent.change(screen.getByTestId('filter-freshness'), { target: { value: 'fresh' } });
    fireEvent.change(screen.getByTestId('filter-embedding'), { target: { value: 'pending' } });

    expect(screen.getByTestId('filter-pill-freshness')).toHaveTextContent('Freshness: Fresh (<7 days)');
    expect(screen.getByTestId('filter-pill-embedding')).toHaveTextContent('Embedding: Needs Embedding');
  });

  it('removes individual filter when pill is clicked', () => {
    render(<PagesPage />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByTestId('advanced-filters-toggle'));
    fireEvent.change(screen.getByTestId('filter-freshness'), { target: { value: 'stale' } });
    fireEvent.change(screen.getByTestId('filter-embedding'), { target: { value: 'done' } });

    // Remove freshness pill by clicking the pill button itself
    fireEvent.click(screen.getByTestId('filter-pill-freshness'));

    // Freshness pill gone, embedding pill remains
    expect(screen.queryByTestId('filter-pill-freshness')).not.toBeInTheDocument();
    expect(screen.getByTestId('filter-pill-embedding')).toBeInTheDocument();

    // Freshness select reset to empty
    expect((screen.getByTestId('filter-freshness') as HTMLSelectElement).value).toBe('');
  });

  it('removes all filter pills when "Clear all" is clicked', () => {
    render(<PagesPage />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByTestId('advanced-filters-toggle'));
    fireEvent.change(screen.getByTestId('filter-freshness'), { target: { value: 'aging' } });
    fireEvent.change(screen.getByTestId('filter-embedding'), { target: { value: 'pending' } });

    expect(screen.getByTestId('active-filter-pills')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('clear-all-pill-filters'));

    expect(screen.queryByTestId('active-filter-pills')).not.toBeInTheDocument();
    expect(screen.queryByTestId('filter-pill-freshness')).not.toBeInTheDocument();
    expect(screen.queryByTestId('filter-pill-embedding')).not.toBeInTheDocument();
  });

  // --- Advanced filters ignored in semantic/hybrid search (#945) ---
  //
  // The backend applies author/date/label/etc. filters only in keyword mode —
  // semantic (vectorSearch) and hybrid (hybridSearch) ignore them entirely.
  // The UI must stop pretending they're active: show a notice and visually
  // mark the active-filter pills as inactive whenever semantic/hybrid search
  // is running, so users aren't misled into thinking their filters applied.
  describe('advanced filters honesty in semantic/hybrid search (#945)', () => {
    it('shows an "ignored" notice and marks pills inactive when a filter is set in semantic mode', async () => {
      render(<PagesPage />, { wrapper: createWrapper() });

      // Activate an advanced filter → pill appears.
      fireEvent.click(screen.getByTestId('advanced-filters-toggle'));
      fireEvent.change(screen.getByTestId('filter-freshness'), { target: { value: 'stale' } });
      expect(screen.getByTestId('filter-pill-freshness')).toBeInTheDocument();

      // Keyword mode honors the filter: no notice, pills are active.
      expect(screen.queryByTestId('filters-ignored-notice')).not.toBeInTheDocument();
      expect(screen.getByTestId('active-filter-pills')).not.toHaveAttribute('data-inactive', 'true');

      // Switch to semantic mode and enter a query — the backend now ignores
      // the filter, so the UI must say so.
      fireEvent.change(screen.getByPlaceholderText('Search pages...'), {
        target: { value: 'kubernetes' },
      });
      fireEvent.click(screen.getByTestId('search-mode-semantic'));

      const notice = await screen.findByTestId('filters-ignored-notice');
      expect(notice).toBeInTheDocument();
      expect(screen.getByTestId('active-filter-pills')).toHaveAttribute('data-inactive', 'true');
    });

    it('does not show the notice in semantic mode when no advanced filters are active', () => {
      render(<PagesPage />, { wrapper: createWrapper() });
      fireEvent.change(screen.getByPlaceholderText('Search pages...'), {
        target: { value: 'kubernetes' },
      });
      fireEvent.click(screen.getByTestId('search-mode-semantic'));
      expect(screen.queryByTestId('filters-ignored-notice')).not.toBeInTheDocument();
    });
  });

  // --- #945 harden pass (2026-08-17) ---
  //
  // A design critique of this surface found the Space filter was silently
  // ignored by semantic/hybrid search exactly like the advanced filters
  // above, but had no pill, was never counted, and was never named in the
  // #945 notice — the scoped-to-a-space search kept returning results from
  // other spaces while the UI reported nothing wrong. The same pass found
  // the Filters disclosure had no aria-expanded/aria-controls, and that the
  // "inactive" pill treatment (opacity-50 + aria-disabled on live, clickable
  // buttons) failed contrast and lied to assistive tech, since the buttons
  // were never actually disabled.
  //
  // #1351 later made the BACKEND actually honor spaceKey in semantic/hybrid
  // mode (backend/src/domains/llm/services/rag-service.ts). The tests below
  // were updated in the same change: Space still gets a pill and is still
  // counted (it is still a real filter), but it is no longer named in the
  // #945 notice, and its pill no longer points at that notice — naming it
  // now would be the honesty bug in the opposite direction.
  describe('#945 harden pass — Space filter honesty, disclosure ARIA, and non-fake-disabled pills', () => {
    it('the Space filter gets a pill and is counted, but is NOT named in the notice — semantic search now honors it (#1351)', async () => {
      render(<PagesPage />, { wrapper: createWrapper() });

      await waitFor(() => expect(screen.getByRole('option', { name: 'Development' })).toBeInTheDocument());
      const spaceSelect = screen.getByRole('combobox', { name: /filter by space/i });
      fireEvent.change(spaceSelect, { target: { value: 'DEV' } });

      const pill = screen.getByTestId('filter-pill-space');
      expect(pill).toHaveTextContent('Space: Development');

      // Keyword mode: Space genuinely filters results, so no notice yet.
      expect(screen.queryByTestId('filters-ignored-notice')).not.toBeInTheDocument();

      fireEvent.change(screen.getByPlaceholderText('Search pages...'), {
        target: { value: 'kubernetes' },
      });
      fireEvent.click(screen.getByTestId('search-mode-semantic'));
      await waitFor(() => expect(screen.getByPlaceholderText('Search pages...')).toHaveValue('kubernetes'));

      // Space is the ONLY active filter, and the backend now applies it in
      // semantic/hybrid mode too — no filter is genuinely ignored, so the
      // notice must not appear at all.
      expect(screen.queryByTestId('filters-ignored-notice')).not.toBeInTheDocument();
      expect(pill).not.toHaveAttribute('aria-describedby');
    });

    it('Space stays out of the notice even when another, genuinely-ignored filter triggers it', async () => {
      render(<PagesPage />, { wrapper: createWrapper() });

      await waitFor(() => expect(screen.getByRole('option', { name: 'Development' })).toBeInTheDocument());
      fireEvent.change(screen.getByRole('combobox', { name: /filter by space/i }), { target: { value: 'DEV' } });
      fireEvent.click(screen.getByTestId('advanced-filters-toggle'));
      fireEvent.change(screen.getByTestId('filter-freshness'), { target: { value: 'stale' } });

      fireEvent.change(screen.getByPlaceholderText('Search pages...'), {
        target: { value: 'kubernetes' },
      });
      fireEvent.click(screen.getByTestId('search-mode-semantic'));

      const notice = await screen.findByTestId('filters-ignored-notice');
      expect(notice).toHaveTextContent('Freshness: Stale (>90 days)');
      expect(notice).not.toHaveTextContent('Space: Development');

      // The Space pill still doesn't point at a notice that isn't about it;
      // the Freshness pill does.
      expect(screen.getByTestId('filter-pill-space')).not.toHaveAttribute('aria-describedby');
      expect(screen.getByTestId('filter-pill-freshness')).toHaveAttribute('aria-describedby', 'filters-ignored-notice');
    });

    it('removing the Space pill clears the space filter, and it resets the select', async () => {
      render(<PagesPage />, { wrapper: createWrapper() });
      await waitFor(() => expect(screen.getByRole('option', { name: 'Development' })).toBeInTheDocument());
      fireEvent.change(screen.getByRole('combobox', { name: /filter by space/i }), { target: { value: 'DEV' } });
      expect(screen.getByTestId('filter-pill-space')).toBeInTheDocument();

      fireEvent.click(screen.getByTestId('filter-pill-space'));

      expect(screen.queryByTestId('filter-pill-space')).not.toBeInTheDocument();
      expect(screen.getByRole('combobox', { name: /filter by space/i })).toHaveValue('');
    });

    it('"Clear all" also clears an active Space filter alongside the advanced ones', async () => {
      render(<PagesPage />, { wrapper: createWrapper() });
      fireEvent.click(screen.getByTestId('advanced-filters-toggle'));
      await waitFor(() => expect(screen.getByRole('option', { name: 'Development' })).toBeInTheDocument());
      fireEvent.change(screen.getByRole('combobox', { name: /filter by space/i }), { target: { value: 'DEV' } });
      fireEvent.change(screen.getByTestId('filter-freshness'), { target: { value: 'stale' } });
      expect(screen.getByTestId('filter-pill-space')).toBeInTheDocument();

      fireEvent.click(screen.getByTestId('clear-all-pill-filters'));

      expect(screen.queryByTestId('filter-pill-space')).not.toBeInTheDocument();
      expect(screen.queryByTestId('filter-pill-freshness')).not.toBeInTheDocument();
    });

    it('the Filters toggle declares its disclosure state via aria-expanded/aria-controls', () => {
      render(<PagesPage />, { wrapper: createWrapper() });
      const toggle = screen.getByTestId('advanced-filters-toggle');
      expect(toggle).toHaveAttribute('aria-expanded', 'false');
      expect(toggle).toHaveAttribute('aria-controls', 'advanced-filters-panel');

      fireEvent.click(toggle);

      expect(toggle).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByTestId('advanced-filters-panel')).toHaveAttribute('id', 'advanced-filters-panel');
    });

    it('active-filter pills stay fully operable in semantic mode — no opacity/aria-disabled, but they point at the notice', async () => {
      render(<PagesPage />, { wrapper: createWrapper() });
      fireEvent.click(screen.getByTestId('advanced-filters-toggle'));
      fireEvent.change(screen.getByTestId('filter-freshness'), { target: { value: 'stale' } });
      fireEvent.change(screen.getByPlaceholderText('Search pages...'), {
        target: { value: 'kubernetes' },
      });
      fireEvent.click(screen.getByTestId('search-mode-semantic'));

      await screen.findByTestId('filters-ignored-notice');
      const pillsWrap = screen.getByTestId('active-filter-pills');
      expect(pillsWrap).not.toHaveAttribute('aria-disabled');
      expect(pillsWrap.className).not.toContain('opacity-50');

      const pill = screen.getByTestId('filter-pill-freshness');
      expect(pill).toHaveAttribute('aria-describedby', 'filters-ignored-notice');
      expect(pill).not.toBeDisabled();

      // Genuinely clickable, not just visually "enabled" — this is exactly
      // the check that used to fool automated tooling the same way it
      // fooled a sighted user.
      fireEvent.click(pill);
      expect(screen.queryByTestId('filter-pill-freshness')).not.toBeInTheDocument();
    });

    it('announces the honesty notice through a persistent sr-only live region', async () => {
      render(<PagesPage />, { wrapper: createWrapper() });
      fireEvent.click(screen.getByTestId('advanced-filters-toggle'));
      fireEvent.change(screen.getByTestId('filter-freshness'), { target: { value: 'stale' } });

      const liveRegion = screen.getByTestId('filters-live-announcer');
      expect(liveRegion).toHaveAttribute('role', 'status');
      expect(liveRegion).toHaveAttribute('aria-live', 'polite');
      expect(liveRegion).toHaveTextContent('');

      fireEvent.change(screen.getByPlaceholderText('Search pages...'), {
        target: { value: 'kubernetes' },
      });
      fireEvent.click(screen.getByTestId('search-mode-semantic'));

      await screen.findByTestId('filters-ignored-notice');
      expect(liveRegion).toHaveTextContent(/ignore your active filters/);
    });

    it('summarizes more than 3 genuinely-ignored filters, but never counts Space toward the truncation (#1351)', async () => {
      render(<PagesPage />, { wrapper: createWrapper() });
      fireEvent.click(screen.getByTestId('advanced-filters-toggle'));
      await waitFor(() => expect(screen.getByRole('option', { name: 'Development' })).toBeInTheDocument());
      fireEvent.change(screen.getByRole('combobox', { name: /filter by space/i }), { target: { value: 'DEV' } });
      fireEvent.change(screen.getByTestId('filter-freshness'), { target: { value: 'stale' } });
      fireEvent.change(screen.getByTestId('filter-embedding'), { target: { value: 'pending' } });
      fireEvent.change(screen.getByTestId('filter-quality'), { target: { value: 'poor' } });
      fireEvent.change(screen.getByTestId('filter-author'), { target: { value: 'Alice' } });
      expect(screen.getByTestId('filter-pill-space')).toBeInTheDocument();

      fireEvent.change(screen.getByPlaceholderText('Search pages...'), {
        target: { value: 'kubernetes' },
      });
      fireEvent.click(screen.getByTestId('search-mode-semantic'));

      // Space is the 5th active filter overall, but it is honored — so the
      // notice must summarize the 4 genuinely-ignored ones (freshness,
      // embedding, quality, author) and truncate THOSE, never mentioning
      // Space at all.
      const notice = await screen.findByTestId('filters-ignored-notice');
      expect(notice).toHaveTextContent('and 1 more');
      expect(notice).not.toHaveTextContent('Space:');
    });
  });

  // --- Visual divider test ---

  it('renders a visual divider between the filter selects and Sort (not between Sort and Filters)', () => {
    render(<PagesPage />, { wrapper: createWrapper() });
    expect(screen.getByTestId('source-sort-divider')).toBeInTheDocument();
  });

  // --- Grid layout test ---

  it('renders advanced filters in a grid layout', () => {
    render(<PagesPage />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByTestId('advanced-filters-toggle'));
    const panel = screen.getByTestId('advanced-filters-panel');
    expect(panel.className).toContain('grid');
    expect(panel.className).toContain('grid-cols-2');
  });

  // --- Accessibility: filter pills as focusable buttons ---

  it('renders filter pills as <button> elements (keyboard navigable)', () => {
    render(<PagesPage />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByTestId('advanced-filters-toggle'));
    fireEvent.change(screen.getByTestId('filter-freshness'), { target: { value: 'stale' } });

    const pill = screen.getByTestId('filter-pill-freshness');
    expect(pill.tagName).toBe('BUTTON');
    expect(pill).toHaveAttribute('aria-label', 'Remove Freshness: Stale (>90 days) filter');
  });

  it('filter pills do not contain nested interactive elements', () => {
    render(<PagesPage />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByTestId('advanced-filters-toggle'));
    fireEvent.change(screen.getByTestId('filter-freshness'), { target: { value: 'fresh' } });

    const pill = screen.getByTestId('filter-pill-freshness');
    // No nested <button> or <a> elements inside the pill
    expect(pill.querySelectorAll('button, a')).toHaveLength(0);
  });

  // --- Accessibility: search clear button focuses input ---

  it('focuses the search input after clearing search', () => {
    render(<PagesPage />, { wrapper: createWrapper() });
    const input = screen.getByPlaceholderText('Search pages...') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'test query' } });

    fireEvent.click(screen.getByTestId('search-clear'));

    expect(input.value).toBe('');
    expect(document.activeElement).toBe(input);
  });

  // --- P0 keyboard fix: search must not steal focus on landing (#1270-ish) ---
  //
  // Unconditionally focusing the search input on mount killed every
  // single-key shortcut on the app's own landing route, since
  // useKeyboardShortcuts correctly suppresses them inside an editable
  // target. "/" (matching LoginPage's own convention) replaces it as an
  // explicit, discoverable path to the same field.
  describe('search input does not steal focus on landing', () => {
    it('does not focus the search input on mount', () => {
      render(<PagesPage />, { wrapper: createWrapper() });
      const input = screen.getByPlaceholderText('Search pages...');
      expect(document.activeElement).not.toBe(input);
    });

    it('focuses the search input on "/"', () => {
      render(<PagesPage />, { wrapper: createWrapper() });
      const input = screen.getByPlaceholderText('Search pages...');
      expect(document.activeElement).not.toBe(input);

      fireEvent.keyDown(document, { key: '/' });

      expect(document.activeElement).toBe(input);
    });

    it('does not hijack "/" while already typing in an editable field', () => {
      render(<PagesPage />, { wrapper: createWrapper() });
      const input = screen.getByPlaceholderText('Search pages...') as HTMLInputElement;
      input.focus();
      fireEvent.change(input, { target: { value: 'a/b' } });

      fireEvent.keyDown(input, { key: '/' });

      // The event is suppressed inside an editable target, so the character
      // reaches the field normally rather than being intercepted as a shortcut.
      expect(input.value).toBe('a/b');
    });
  });

  // --- Performance: memoized page list items (#521) ---

  // --- Mobile responsive header buttons (#499) ---

  it('wraps header action button text in hidden sm:inline spans for mobile', () => {
    render(<PagesPage />, { wrapper: createWrapper() });
    const trashBtn = screen.getByTestId('trash-link');
    // The button text "Trash" should be in a span with responsive classes
    const span = trashBtn.querySelector('span');
    expect(span).toBeTruthy();
    expect(span?.className).toContain('hidden');
    expect(span?.className).toContain('sm:inline');
  });

  it('uses flex-wrap on the header button container', () => {
    render(<PagesPage />, { wrapper: createWrapper() });
    const trashBtn = screen.getByTestId('trash-link');
    const container = trashBtn.parentElement!;
    expect(container.className).toContain('flex-wrap');
  });

  // --- Search mode toggle visual differentiation (#506) ---

  describe('search mode toggle (#506)', () => {
    function typeSearch() {
      fireEvent.change(screen.getByPlaceholderText('Search pages...'), {
        target: { value: 'runbook' },
      });
    }

    it('hides the retrieval-mode toggle until there is a query', () => {
      render(<PagesPage />, { wrapper: createWrapper() });
      expect(screen.queryByTestId('search-mode-toggle')).not.toBeInTheDocument();
    });

    it('renders three search mode buttons (keyword, semantic, hybrid)', () => {
      render(<PagesPage />, { wrapper: createWrapper() });
      typeSearch();
      expect(screen.getByTestId('search-mode-keyword')).toBeInTheDocument();
      expect(screen.getByTestId('search-mode-semantic')).toBeInTheDocument();
      expect(screen.getByTestId('search-mode-hybrid')).toBeInTheDocument();
    });

    it('defaults to keyword mode as active', () => {
      render(<PagesPage />, { wrapper: createWrapper() });
      typeSearch();
      const keyword = screen.getByTestId('search-mode-keyword');
      expect(keyword).toHaveAttribute('aria-pressed', 'true');
      // A segmented control: the active segment is the raised one on the track
      // (`nm-pill-active`). It used to be a near-black `bg-action` fill with a
      // shadow and ring, which made picking a retrieval strategy louder than
      // the page's primary action.
      expect(keyword.className).toContain('nm-pill-active');
    });

    it('marks inactive buttons with aria-pressed=false', () => {
      render(<PagesPage />, { wrapper: createWrapper() });
      typeSearch();
      const semantic = screen.getByTestId('search-mode-semantic');
      const hybrid = screen.getByTestId('search-mode-hybrid');
      expect(semantic).toHaveAttribute('aria-pressed', 'false');
      expect(hybrid).toHaveAttribute('aria-pressed', 'false');
    });

    it('switches active mode on click', () => {
      render(<PagesPage />, { wrapper: createWrapper() });
      typeSearch();
      const semantic = screen.getByTestId('search-mode-semantic');
      fireEvent.click(semantic);

      expect(semantic).toHaveAttribute('aria-pressed', 'true');
      expect(semantic.className).toContain('nm-pill-active');

      const keyword = screen.getByTestId('search-mode-keyword');
      expect(keyword).toHaveAttribute('aria-pressed', 'false');
      expect(keyword.className).not.toContain('nm-pill-active');
    });

    // Selection is carried by fill and weight, not by a shadow or a ring —
    // neither of which this system has outside overlays and focus.
    it('distinguishes the active segment from the inactive ones', () => {
      render(<PagesPage />, { wrapper: createWrapper() });
      typeSearch();
      const active = screen.getByTestId('search-mode-keyword');
      const inactive = screen.getByTestId('search-mode-semantic');

      expect(active.className).toContain('nm-pill-active');
      expect(inactive.className).not.toContain('nm-pill-active');
      expect(inactive.className).toContain('text-muted-foreground');

      for (const el of [active, inactive]) {
        expect(el.className).not.toContain('shadow-md');
        expect(el.className).not.toContain('ring-1');
      }
    });
  });

  // --- Source filter wire value (#873) ---
  //
  // The "Local" source option must send the contract-valid wire value
  // 'standalone' (PageSourceEnum = ['confluence', 'standalone']). Sending
  // 'local' fails Zod validation on GET /api/pages and breaks the list.
  describe('source filter (#873)', () => {
    it('renders the Local option with the contract value "standalone", not "local"', () => {
      render(<PagesPage />, { wrapper: createWrapper() });
      const select = screen.getByTestId('filter-source') as HTMLSelectElement;
      const localOption = Array.from(select.options).find((o) => o.textContent === 'Local');
      expect(localOption).toBeTruthy();
      // 'local' is not a member of PageSourceEnum and would 400 the pages query.
      expect(localOption!.value).toBe('standalone');
    });

    it('fires the pages query with source=standalone when Local is selected', async () => {
      vi.restoreAllMocks();
      const fetchSpy = mockFetchWithEmbeddingStatus(mockEmbeddingStatusIdle);
      render(<PagesPage />, { wrapper: createWrapper() });

      const select = screen.getByTestId('filter-source') as HTMLSelectElement;
      const localOption = Array.from(select.options).find((o) => o.textContent === 'Local');
      fireEvent.change(select, { target: { value: localOption!.value } });

      await waitFor(() => {
        const urls = fetchSpy.mock.calls.map(([input]) =>
          typeof input === 'string' ? input : (input as Request).url,
        );
        const pagesUrls = urls.filter((u) => /\/pages\?/.test(u));
        expect(pagesUrls.some((u) => u.includes('source=standalone'))).toBe(true);
        expect(pagesUrls.some((u) => u.includes('source=local'))).toBe(false);
      });
    });

    it('shows the user-facing label "Local" (not the wire value) in the active-filter pill', () => {
      render(<PagesPage />, { wrapper: createWrapper() });
      const select = screen.getByTestId('filter-source') as HTMLSelectElement;
      fireEvent.change(select, { target: { value: 'standalone' } });

      const pill = screen.getByTestId('filter-pill-source');
      expect(pill).toHaveTextContent('Source: Local');
      expect(pill).not.toHaveTextContent('standalone');
    });
  });

  // --- Accessibility: filter/sort controls have accessible names (#946) ---
  //
  // The three top-row selects (space / source / sort) had no accessible name,
  // and the advanced-panel <label>s were not programmatically associated with
  // their controls (no htmlFor/id). Screen readers announced these as unnamed
  // "combobox"/"edit" fields. These tests pin the aria-label + label/for wiring.
  describe('filter control accessible names (#946)', () => {
    it('top-row space/source/sort selects expose an accessible name', () => {
      render(<PagesPage />, { wrapper: createWrapper() });
      expect(screen.getByRole('combobox', { name: /filter by space/i })).toBeInTheDocument();
      expect(screen.getByRole('combobox', { name: /filter by source/i })).toBeInTheDocument();
      expect(screen.getByRole('combobox', { name: /sort pages/i })).toBeInTheDocument();
    });

    // Every other control in the section already had one; the search field —
    // the sole control the route's own `/` shortcut exists to focus — was the
    // one exception, named only by its placeholder (polish pass, 2026-08-17).
    it('the search field exposes an accessible name (was placeholder-only)', () => {
      render(<PagesPage />, { wrapper: createWrapper() });
      expect(screen.getByRole('textbox', { name: /search pages/i })).toBeInTheDocument();
    });

    it('advanced-panel labels are programmatically associated with their controls', () => {
      render(<PagesPage />, { wrapper: createWrapper() });
      fireEvent.click(screen.getByTestId('advanced-filters-toggle'));

      // Role-name / label-text queries only match once htmlFor/id wiring exists.
      expect(screen.getByRole('combobox', { name: /author/i })).toBeInTheDocument();
      expect(screen.getByRole('combobox', { name: /labels/i })).toBeInTheDocument();
      expect(screen.getByRole('combobox', { name: /freshness/i })).toBeInTheDocument();
      expect(screen.getByRole('combobox', { name: /embedding/i })).toBeInTheDocument();
      expect(screen.getByRole('combobox', { name: /quality/i })).toBeInTheDocument();
      expect(screen.getByLabelText(/modified from/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/modified to/i)).toBeInTheDocument();
    });
  });

  // --- Search box polish (2026-08-17) ---
  //
  // The `/` shortcut that focuses this field was completely undiscoverable —
  // "New Page" carried a visible ShortcutHint chip, this field carried
  // nothing. And Escape didn't clear a populated field, the one universal
  // convention on search inputs, leaving only the 18px clear `×` as an exit.
  describe('search box polish (2026-08-17)', () => {
    it('shows the "/" shortcut hint when the field is empty, and swaps to the clear button once populated', () => {
      render(<PagesPage />, { wrapper: createWrapper() });

      expect(screen.getByText('/')).toBeInTheDocument();
      expect(screen.queryByTestId('search-clear')).not.toBeInTheDocument();

      fireEvent.change(screen.getByPlaceholderText('Search pages...'), { target: { value: 'kubernetes' } });

      expect(screen.getByTestId('search-clear')).toBeInTheDocument();
      expect(screen.queryByText('/')).not.toBeInTheDocument();
    });

    it('Escape clears a populated search field', () => {
      render(<PagesPage />, { wrapper: createWrapper() });
      const input = screen.getByPlaceholderText('Search pages...') as HTMLInputElement;
      fireEvent.change(input, { target: { value: 'kubernetes' } });
      expect(input.value).toBe('kubernetes');

      fireEvent.keyDown(input, { key: 'Escape' });

      expect(input.value).toBe('');
    });

    it('Escape on an already-empty search field is a no-op', () => {
      render(<PagesPage />, { wrapper: createWrapper() });
      const input = screen.getByPlaceholderText('Search pages...') as HTMLInputElement;

      // Should not throw, and should not, say, clear an unrelated filter.
      expect(() => fireEvent.keyDown(input, { key: 'Escape' })).not.toThrow();
      expect(input.value).toBe('');
    });
  });

  describe('performance: virtual scrolling + memoized items (#511, #521)', () => {
    it('renders visible page list items with stable keys (by id, not index)', async () => {
      render(<PagesPage />, { wrapper: createWrapper() });
      const item = await screen.findByTestId('article-hover-page-1');
      expect(item).toBeInTheDocument();
      expect(screen.getByText('Test Page')).toBeInTheDocument();
    });

    it('renders only a subset of items for large page counts (virtual scrolling)', async () => {
      vi.restoreAllMocks();
      mockFetchWithPages(makeManyPages(200));
      render(<PagesPage />, { wrapper: createWrapper() });

      // Wait for at least one item to appear
      await screen.findByTestId('virtual-list-container');
      const items = screen.queryAllByTestId(/^article-hover-/);
      // Virtual scrolling should render fewer items than total (only visible + overscan)
      // In jsdom the exact count depends on mocked dimensions; just verify fewer than 200
      expect(items.length).toBeLessThan(200);
    });

  });

  // ---------------------------------------------------------------------------
  // Status-pill accessibility (Task 4 of amber-as-AI bundle, bug 1c)
  //
  // Three pill variants previously failed WCAG-AA: Recent (3.37:1),
  // Not Embedded (2.67:1 light), Private (borrowed amber w/o AI semantic).
  // These tests verify the swap to AA-pass palettes.
  // ---------------------------------------------------------------------------
  describe('page row status badges (accessibility)', () => {
    function makeStandalonePage(visibility: 'private' | 'shared') {
      return {
        items: [
          {
            id: 'std-1',
            spaceKey: '__local__',
            title: 'Standalone Page',
            version: 1,
            parentId: null,
            labels: [],
            author: 'Alice',
            lastModifiedAt: '2025-01-15T00:00:00Z',
            lastSynced: '2025-01-16T00:00:00Z',
            embeddingDirty: false,
            embeddingStatus: 'embedded',
            embeddedAt: '2025-01-16T00:00:00Z',
            source: 'standalone',
            visibility,
          },
        ],
        total: 1,
        page: 1,
        limit: 50,
        totalPages: 1,
      };
    }

    function mockPagesWithStandalone(visibility: 'private' | 'shared') {
      vi.restoreAllMocks();
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const url = typeof input === 'string' ? input : (input as Request).url;
        if (url.includes('/embeddings/status')) {
          return new Response(JSON.stringify(mockEmbeddingStatusIdle), {
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.includes('/pages/filters')) {
          return new Response(JSON.stringify(mockFilterOptions), {
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.includes('/spaces')) {
          return new Response(JSON.stringify(mockSpaces), {
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.includes('/sync/status')) {
          return new Response(JSON.stringify({ status: 'idle' }), {
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.includes('/pages/pinned')) {
          return new Response(JSON.stringify({ items: [], total: 0 }), {
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.includes('/settings')) {
          return new Response(JSON.stringify({}), {
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify(makeStandalonePage(visibility)), {
          headers: { 'Content-Type': 'application/json' },
        });
      });
    }

    // Source and visibility are CATEGORIES, not states, so every badge in
    // this cluster is the same neutral chip and the label/glyph is the
    // differentiator. Local used to wear the success green and Confluence/
    // Shared the informational indigo — status vocabulary borrowed for
    // labels, on the densest scanning surface in the app.
    //
    // The fill is the COMPOSITING TINT `bg-foreground/10`, never `bg-muted`:
    // these rows hover with `bg-accent`, and in Graphite accent == muted
    // (1.00:1 measured), so a bg-muted chip vanished exactly while being
    // pointed at. The tint steps up from any ground.
    //
    // The label is `text-secondary-foreground`, never muted: the tint darkens
    // the ground under the 11px label, and muted-fg measured 3.85:1 on a
    // hovered Paper row — under AA. The secondary ink measures 8.58/7.31:1
    // (Graphite resting/hovered) and 9.73/7.98:1 (Paper).
    it('Local badge is a neutral tint — no borrowed status hue, no bg-muted', async () => {
      mockPagesWithStandalone('private');
      render(<PagesPage />, { wrapper: createWrapper() });
      const badge = await screen.findByTestId('badge-local');
      expect(badge).toHaveTextContent('Local');
      expect(badge.className).toContain('bg-foreground/10');
      expect(badge.className).toContain('text-secondary-foreground');
      expect(badge.className).not.toContain('bg-muted');
      expect(badge.className).not.toContain('text-muted-foreground');
      expect(badge.className).not.toMatch(/success|info|emerald-500|amber|warning|yellow/);
    });

    it('Private badge uses the neutral tint, not amber/primary/warning', async () => {
      mockPagesWithStandalone('private');
      render(<PagesPage />, { wrapper: createWrapper() });
      const badge = await screen.findByTestId('badge-private');
      expect(badge).toHaveTextContent('Private');
      expect(badge.className).not.toMatch(/amber|warning|yellow|primary/);
      expect(badge.className).toContain('bg-foreground/10');
      expect(badge.className).toContain('text-secondary-foreground');
      expect(badge.className).not.toContain('bg-muted');
      expect(badge.className).not.toContain('text-muted-foreground');
    });

    it('Shared badge is a neutral tint — no borrowed status hue, no bg-muted', async () => {
      mockPagesWithStandalone('shared');
      render(<PagesPage />, { wrapper: createWrapper() });
      const badge = await screen.findByTestId('badge-shared');
      expect(badge).toHaveTextContent('Shared');
      expect(badge.className).toContain('bg-foreground/10');
      expect(badge.className).toContain('text-secondary-foreground');
      expect(badge.className).not.toContain('bg-muted');
      expect(badge.className).not.toContain('text-muted-foreground');
      expect(badge.className).not.toMatch(/success|info|sky-500|amber|warning|yellow/);
    });
  });

  // --- Search debounce + semantic-mode gating (#874) ---
  //
  // The keyword search input used to feed usePages directly, firing an
  // un-debounced GET /pages?search=… on every keystroke, and it kept firing
  // that wasted keyword query even in semantic/hybrid mode where the results
  // come from useSearch. These tests pin the debounce and the enabled gate.
  describe('search debounce + semantic gating (#874)', () => {
    /** Fetch mock that serves both /search and /pages, so semantic mode has a
     *  real /search response while we watch what /pages does. */
    function mockFetchWithSearchAndPages() {
      return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const url = typeof input === 'string' ? input : (input as Request).url;
        if (url.includes('/search?')) {
          const mode = new URL(url, 'http://localhost').searchParams.get('mode') ?? 'keyword';
          return new Response(
            JSON.stringify({ items: [], total: 0, page: 1, limit: 10, totalPages: 0, mode, hasEmbeddings: true }),
            { headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (url.includes('/embeddings/status')) {
          return new Response(JSON.stringify(mockEmbeddingStatusIdle), { headers: { 'Content-Type': 'application/json' } });
        }
        if (url.includes('/pages/filters')) {
          return new Response(JSON.stringify(mockFilterOptions), { headers: { 'Content-Type': 'application/json' } });
        }
        if (url.includes('/spaces')) {
          return new Response(JSON.stringify(mockSpaces), { headers: { 'Content-Type': 'application/json' } });
        }
        if (url.includes('/sync/status')) {
          return new Response(JSON.stringify({ status: 'idle' }), { headers: { 'Content-Type': 'application/json' } });
        }
        if (url.includes('/pages/pinned')) {
          return new Response(JSON.stringify({ items: [], total: 0 }), { headers: { 'Content-Type': 'application/json' } });
        }
        if (url.includes('/settings')) {
          return new Response(JSON.stringify({}), { headers: { 'Content-Type': 'application/json' } });
        }
        return new Response(JSON.stringify(mockPagesResponse), { headers: { 'Content-Type': 'application/json' } });
      });
    }

    /** Extract the exact `search` param value from every GET /pages?… list
     *  request (ignores /pages/pinned, /pages/filters, /search, etc.). */
    function pagesSearchValues(fetchSpy: MockInstance<typeof fetch>): string[] {
      return fetchSpy.mock.calls
        .map(([firstArg]) => (typeof firstArg === 'string' ? firstArg : (firstArg as Request).url))
        .filter((u) => /\/pages\?/.test(u))
        .map((u) => new URL(u, 'http://localhost').searchParams.get('search'))
        .filter((v): v is string => v !== null);
    }

    it('debounces keyword search: only the final term fires a /pages request', async () => {
      vi.restoreAllMocks();
      const fetchSpy = mockFetchWithEmbeddingStatus(mockEmbeddingStatusIdle);
      render(<PagesPage />, { wrapper: createWrapper() });

      const input = screen.getByPlaceholderText('Search pages...');
      // Four rapid keystrokes — the debounce must collapse them to one request.
      fireEvent.change(input, { target: { value: 'k' } });
      fireEvent.change(input, { target: { value: 'ku' } });
      fireEvent.change(input, { target: { value: 'kub' } });
      fireEvent.change(input, { target: { value: 'kube' } });

      // The debounced term eventually fires exactly one keyword request.
      await waitFor(
        () => {
          expect(pagesSearchValues(fetchSpy)).toContain('kube');
        },
        { timeout: 2000 },
      );

      // The intermediate keystrokes must never have hit the network.
      const values = pagesSearchValues(fetchSpy);
      expect(values).not.toContain('k');
      expect(values).not.toContain('ku');
      expect(values).not.toContain('kub');
    });

    it('does not fire a keyword /pages?search= request while in semantic mode', async () => {
      vi.restoreAllMocks();
      const fetchSpy = mockFetchWithSearchAndPages();
      render(<PagesPage />, { wrapper: createWrapper() });

      fireEvent.change(screen.getByPlaceholderText('Search pages...'), {
        target: { value: 'kubernetes' },
      });
      fireEvent.click(screen.getByTestId('search-mode-semantic'));

      // Wait until the debounced semantic search has actually fired.
      await waitFor(
        () => {
          const urls = fetchSpy.mock.calls.map(([firstArg]) =>
            typeof firstArg === 'string' ? firstArg : (firstArg as Request).url,
          );
          expect(urls.some((u) => u.includes('/search?') && u.includes('mode=semantic'))).toBe(true);
        },
        { timeout: 2000 },
      );

      // The wasted keyword query must be gated off entirely.
      expect(pagesSearchValues(fetchSpy)).toHaveLength(0);
    });

    // --- Atomic query key: the QUERY sort must track the DEBOUNCED term ---
    //
    // `search` is debounced (300ms) into the /pages query key, but `sort` was
    // flipped synchronously by the search input's onChange (→ 'relevance' on the
    // first keystroke, → 'modified' on clear). Because both feed the same query
    // key, the key was non-atomic: the first keystroke minted a key with the new
    // sort but the OLD (empty) search → an immediate GET /pages?sort=relevance
    // with no search term, and the clear button minted a key with the new sort
    // but the STALE debounced term → a wasted stale-term fetch. These tests
    // instrument EVERY /pages? list request (including sort-only ones the
    // `pagesSearchValues` helper is blind to).
    describe('atomic query key: sort tracks the debounced term (#874)', () => {
      beforeEach(() => {
        vi.useFakeTimers();
      });

      afterEach(() => {
        vi.useRealTimers();
      });

      /** Every GET /pages?… list request (not /pages/pinned|filters|tree, not
       *  /search), with its parsed `search` and `sort` params — including
       *  requests that carry NO search term (search === null). */
      function pagesListRequests(fetchSpy: MockInstance<typeof fetch>) {
        return fetchSpy.mock.calls
          .map(([firstArg]) => (typeof firstArg === 'string' ? firstArg : (firstArg as Request).url))
          .filter((u) => /\/pages\?/.test(u))
          .map((u) => {
            const params = new URL(u, 'http://localhost').searchParams;
            return { url: u, search: params.get('search'), sort: params.get('sort') };
          });
      }

      it('first keystroke does not fire an immediate sort=relevance request before the 300ms debounce', async () => {
        vi.restoreAllMocks();
        const fetchSpy = mockFetchWithEmbeddingStatus(mockEmbeddingStatusIdle);
        render(<PagesPage />, { wrapper: createWrapper() });

        // Flush the initial browse-list query (sort=modified, no search).
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        const baseline = pagesListRequests(fetchSpy);

        // One character. onChange flips `sort` to 'relevance' synchronously; the
        // debounced term is still ''. The query sort must track the DEBOUNCED
        // term, so the key must not change and no request may fire yet.
        fireEvent.change(screen.getByPlaceholderText('Search pages...'), {
          target: { value: 'k' },
        });
        // Flush microtasks WITHOUT advancing to the 300ms debounce boundary.
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });

        const afterKeystroke = pagesListRequests(fetchSpy);
        // No new request, and specifically no sort=relevance request that
        // carries no search term (the wrong-data-flash / wasted request).
        expect(afterKeystroke).toHaveLength(baseline.length);
        expect(afterKeystroke.some((r) => r.sort === 'relevance' && r.search === null)).toBe(false);

        // Now let the debounce elapse — exactly ONE new request, the debounced
        // one, carrying the term and the relevance sort together.
        await act(async () => { await vi.advanceTimersByTimeAsync(300); });
        const newRequests = pagesListRequests(fetchSpy).slice(baseline.length);
        expect(newRequests).toHaveLength(1);
        expect(newRequests[0]!.search).toBe('k');
        expect(newRequests[0]!.sort).toBe('relevance');
      });

      it('clear button does not fire a request carrying the stale search term', async () => {
        vi.restoreAllMocks();
        const fetchSpy = mockFetchWithEmbeddingStatus(mockEmbeddingStatusIdle);
        render(<PagesPage />, { wrapper: createWrapper() });
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });

        // Type a term and let its debounced request actually fire.
        fireEvent.change(screen.getByPlaceholderText('Search pages...'), {
          target: { value: 'kube' },
        });
        await act(async () => { await vi.advanceTimersByTimeAsync(300); });
        expect(pagesListRequests(fetchSpy).some((r) => r.search === 'kube')).toBe(true);

        const beforeClear = pagesListRequests(fetchSpy).length;

        // Clear the search. The debounced value must be reset synchronously so
        // no request re-fetches the stale 'kube' term.
        fireEvent.click(screen.getByTestId('search-clear'));
        await act(async () => { await vi.advanceTimersByTimeAsync(300); });

        const afterClear = pagesListRequests(fetchSpy).slice(beforeClear);
        expect(afterClear.some((r) => r.search === 'kube')).toBe(false);
      });
    });
  });

  // --- Pagination chevron accessible names (#947) ---
  //
  // The prev/next chevron buttons are icon-only (a bare <ChevronLeft/> or
  // <ChevronRight/>), so without an aria-label they have no accessible name and
  // screen-reader / keyboard users cannot tell them apart. There are two
  // identical pairs — one for the keyword/browse list and one for the
  // semantic/hybrid results — so both must expose names.
  describe('pagination accessibility (#947)', () => {
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });

    /** Mock fetch so every list/search response reports multiple pages, forcing
     *  the pagination controls to render in either mode. */
    function mockFetchWithMultiplePages(totalPages: number) {
      const items = makeManyPages(3).items;
      return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const url = typeof input === 'string' ? input : (input as Request).url;
        if (url.includes('/embeddings/status')) return json(mockEmbeddingStatusIdle);
        if (url.includes('/pages/filters')) return json(mockFilterOptions);
        if (url.includes('/spaces')) return json(mockSpaces);
        if (url.includes('/sync/status')) return json({ status: 'idle' });
        if (url.includes('/pages/pinned')) return json({ items: [], total: 0 });
        if (url.includes('/settings')) return json({});
        if (url.includes('/search?')) {
          const mode = new URL(url, 'http://localhost').searchParams.get('mode') ?? 'keyword';
          return json({ items, total: items.length, page: 1, limit: 3, totalPages, mode, hasEmbeddings: true });
        }
        return json({ items, total: items.length, page: 1, limit: 3, totalPages });
      });
    }

    it('keyword-mode pagination chevrons expose Previous/Next accessible names', async () => {
      vi.restoreAllMocks();
      mockFetchWithMultiplePages(3);
      render(<PagesPage />, { wrapper: createWrapper() });

      expect(await screen.findByRole('button', { name: /previous page/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /next page/i })).toBeInTheDocument();
    });

    it('semantic-mode pagination chevrons expose Previous/Next accessible names', async () => {
      vi.restoreAllMocks();
      mockFetchWithMultiplePages(3);
      render(<PagesPage />, { wrapper: createWrapper() });

      fireEvent.change(screen.getByPlaceholderText('Search pages...'), {
        target: { value: 'kubernetes' },
      });
      fireEvent.click(screen.getByTestId('search-mode-semantic'));

      expect(
        await screen.findByRole('button', { name: /previous page/i }, { timeout: 2000 }),
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /next page/i })).toBeInTheDocument();
    });
  });

  describe('screen-reader wayfinding', () => {
    // Before the July-2026 critique this page exposed exactly one heading
    // ("Pages") for the whole dashboard, so heading navigation — a screen
    // reader user's primary way of moving around a screen — did nothing.
    it('gives each region of the dashboard a heading', () => {
      render(<PagesPage />, { wrapper: createWrapper() });

      const headings = screen.getAllByRole('heading').map((h) => h.textContent);
      expect(headings).toContain('Pages');
      expect(headings).toContain('Knowledge base status');
      expect(headings).toContain('Search and filter pages');
      expect(headings).toContain('Page results');
    });

    it('associates each region with its heading', () => {
      const { container } = render(<PagesPage />, { wrapper: createWrapper() });

      const labelled = Array.from(container.querySelectorAll('section[aria-labelledby]'));
      expect(labelled.length).toBeGreaterThanOrEqual(3);
      for (const section of labelled) {
        const id = section.getAttribute('aria-labelledby')!;
        expect(container.querySelector(`#${id}`)).not.toBeNull();
      }
    });
  });

  describe('linkable search', () => {
    it('seeds the search box from ?search=', async () => {
      // The 404 page hands the user's query off this way, and it makes result
      // URLs shareable.
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/?search=runbook']}>
            <div data-scroll-container style={{ height: 800, overflow: 'auto' }}>
              <PagesPage />
            </div>
          </MemoryRouter>
        </QueryClientProvider>,
      );

      const input = await screen.findByPlaceholderText('Search pages...');
      expect((input as HTMLInputElement).value).toBe('runbook');
    });

    it('starts empty when no search param is present', async () => {
      render(<PagesPage />, { wrapper: createWrapper() });
      const input = await screen.findByPlaceholderText('Search pages...');
      expect((input as HTMLInputElement).value).toBe('');
    });
  });

  describe('bulk selection', () => {
    // /pages/bulk/{delete,sync,embed,quality} shipped on the backend with no
    // frontend, so re-embedding a large space meant one row at a time.
    it('shows no action bar until something is selected', async () => {
      render(<PagesPage />, { wrapper: createWrapper() });
      await screen.findByText('Test Page');

      expect(screen.getByTestId('select-all-pages')).toBeInTheDocument();
      expect(screen.queryByTestId('bulk-action-bar')).not.toBeInTheDocument();
    });

    it('reveals the action bar when a row is checked', async () => {
      render(<PagesPage />, { wrapper: createWrapper() });
      await screen.findByText('Test Page');

      const checkbox = screen.getByLabelText('Select Test Page');
      fireEvent.click(checkbox);

      expect(await screen.findByTestId('bulk-action-bar')).toBeInTheDocument();
      expect(screen.getByTestId('bulk-selection-count')).toHaveTextContent('1 page selected');
    });

    it('renders the row checkbox as checked once selected', async () => {
      // PageListItem is memoised with a hand-written comparator. When that
      // comparator omitted `selected`, the row skipped its re-render and React
      // restored the controlled input to unchecked — selection state was
      // correct and the action bar counted right, but every box looked empty.
      render(<PagesPage />, { wrapper: createWrapper() });
      await screen.findByText('Test Page');

      const checkbox = screen.getByLabelText('Select Test Page');
      expect(checkbox).not.toBeChecked();

      fireEvent.click(checkbox);

      await waitFor(() => {
        expect(screen.getByLabelText('Select Test Page')).toBeChecked();
      });
    });

    it('unchecks the row when toggled off', async () => {
      render(<PagesPage />, { wrapper: createWrapper() });
      await screen.findByText('Test Page');

      const checkbox = screen.getByLabelText('Select Test Page');
      fireEvent.click(checkbox);
      await waitFor(() => expect(screen.getByLabelText('Select Test Page')).toBeChecked());

      fireEvent.click(screen.getByLabelText('Select Test Page'));
      await waitFor(() => expect(screen.getByLabelText('Select Test Page')).not.toBeChecked());
    });

    it('checks every row when select-all is used', async () => {
      render(<PagesPage />, { wrapper: createWrapper() });
      await screen.findByText('Test Page');

      fireEvent.click(screen.getByTestId('select-all-pages'));

      await waitFor(() => {
        expect(screen.getByLabelText('Select Test Page')).toBeChecked();
      });
    });

    it('selects and clears every visible row from the header checkbox', async () => {
      render(<PagesPage />, { wrapper: createWrapper() });
      await screen.findByText('Test Page');

      const selectAll = screen.getByTestId('select-all-pages');
      fireEvent.click(selectAll);
      expect(await screen.findByTestId('bulk-action-bar')).toBeInTheDocument();

      fireEvent.click(selectAll);
      await waitFor(() => {
        expect(screen.queryByTestId('bulk-action-bar')).not.toBeInTheDocument();
      });
    });

    it('marks the header checkbox indeterminate on a partial selection', async () => {
      render(<PagesPage />, { wrapper: createWrapper() });
      await screen.findByText('Test Page');

      const selectAll = screen.getByTestId('select-all-pages') as HTMLInputElement;
      expect(selectAll.indeterminate).toBe(false);

      fireEvent.click(screen.getByLabelText('Select Test Page'));

      await waitFor(() => {
        const box = screen.getByTestId('select-all-pages') as HTMLInputElement;
        // Partial selection is a third state; without it the box reads
        // "nothing selected" while rows plainly are.
        expect(box.indeterminate || box.checked).toBe(true);
      });
    });

    it('clears the selection from the action bar', async () => {
      render(<PagesPage />, { wrapper: createWrapper() });
      await screen.findByText('Test Page');

      fireEvent.click(screen.getByLabelText('Select Test Page'));
      fireEvent.click(await screen.findByTestId('bulk-clear-btn'));

      await waitFor(() => {
        expect(screen.queryByTestId('bulk-action-bar')).not.toBeInTheDocument();
      });
    });
  });

  describe('bulk wire ids', () => {
    // The bulk routes resolve ids in 'mixed' mode and map each found row back
    // to `confluence_id` unless it is standalone, while `GET /pages` hands the
    // frontend the PK for every row. Posting the PK verbatim still acted on
    // synced pages, but the server could not match the id on the way back and
    // counted every one of them in `failed`/`errors`.
    const mixedPages = {
      items: [
        {
          id: '1',
          confluenceId: 'conf-abc',
          source: 'confluence',
          spaceKey: 'DEV',
          title: 'Synced Page',
          version: 1,
          parentId: null,
          labels: [],
          author: 'Alice',
          lastModifiedAt: '2025-01-15T00:00:00Z',
          lastSynced: '2025-01-16T00:00:00Z',
          embeddingDirty: false,
          embeddingStatus: 'embedded',
          embeddedAt: '2025-01-16T00:00:00Z',
        },
        {
          id: '2',
          confluenceId: null,
          source: 'standalone',
          spaceKey: null,
          title: 'Local Page',
          version: 1,
          parentId: null,
          labels: [],
          author: 'Bob',
          lastModifiedAt: '2025-01-15T00:00:00Z',
          lastSynced: '2025-01-16T00:00:00Z',
          embeddingDirty: false,
          embeddingStatus: 'embedded',
          embeddedAt: '2025-01-16T00:00:00Z',
        },
      ],
      total: 2,
      page: 1,
      limit: 50,
      totalPages: 1,
    };

    /** Installs a fetch mock over `mixedPages` and captures the bulk POST body. */
    function mockMixedFetch() {
      const bulkBodies: { url: string; body: unknown }[] = [];
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const url = typeof input === 'string' ? input : (input as Request).url;
        const json = (data: unknown) =>
          new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });

        if (url.includes('/pages/bulk/')) {
          bulkBodies.push({ url, body: JSON.parse(String(init?.body ?? '{}')) });
          return json({ succeeded: 2, failed: 0, errors: [] });
        }
        if (url.includes('/embeddings/status')) return json(mockEmbeddingStatusIdle);
        if (url.includes('/pages/filters')) return json(mockFilterOptions);
        if (url.includes('/spaces')) return json(mockSpaces);
        if (url.includes('/sync/status')) return json({ status: 'idle' });
        if (url.includes('/pages/pinned')) return json({ items: [], total: 0 });
        if (url.includes('/settings')) return json({});
        return json(mixedPages);
      });
      return bulkBodies;
    }

    it('addresses a synced page by confluence id and a local page by its PK', async () => {
      const bulkBodies = mockMixedFetch();
      render(<PagesPage />, { wrapper: createWrapper() });
      await screen.findByText('Synced Page');

      fireEvent.click(screen.getByTestId('select-all-pages'));
      fireEvent.click(await screen.findByTestId('bulk-embed-btn'));

      await waitFor(() => expect(bulkBodies).toHaveLength(1));
      expect(bulkBodies[0]!.url).toContain('/pages/bulk/embed');
      expect(bulkBodies[0]!.body).toEqual({ ids: ['conf-abc', '2'] });
    });

    it('keeps selection and display keyed by row id', async () => {
      // The wire mapping must not leak into the checkboxes: selection is keyed
      // by PK, which is what the memo comparator and the Set both use.
      const bulkBodies = mockMixedFetch();
      render(<PagesPage />, { wrapper: createWrapper() });
      await screen.findByText('Synced Page');

      fireEvent.click(screen.getByLabelText('Select Synced Page'));

      await waitFor(() => {
        expect(screen.getByLabelText('Select Synced Page')).toBeChecked();
      });
      expect(screen.getByTestId('bulk-selection-count')).toHaveTextContent('1 page selected');

      fireEvent.click(screen.getByTestId('bulk-embed-btn'));
      await waitFor(() => expect(bulkBodies).toHaveLength(1));
      expect(bulkBodies[0]!.body).toEqual({ ids: ['conf-abc'] });
    });
  });

  describe('list row density', () => {
    it('does not print a freshness badge beside the raw date it derives from', async () => {
      render(<PagesPage />, { wrapper: createWrapper() });

      // FreshnessBadge is computed purely from lastModifiedAt, which the row
      // already renders as a date — two renderings of one field.
      await screen.findByText('Test Page');
      expect(screen.queryByTestId('badge-recent')).not.toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// Filter persistence across navigation (#1124)
//
// Filter, search, sort and pagination state used to be `useState`. Opening an
// article unmounts PagesPage; coming back re-mounts it with those seeds empty,
// so the user's filter was silently gone. The state now lives in the URL, which
// survives that round trip — and makes a filtered view linkable, which is the
// part a store could not do.
// ---------------------------------------------------------------------------

describe('PagesPage filter persistence (#1124)', () => {
  let restoreRects: () => void;

  beforeEach(() => {
    restoreRects = installVirtualizerRectShim();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restoreRects();
  });

  /** Renders the current query string so assertions can read the real URL. */
  function LocationProbe() {
    const location = useLocation();
    return <span data-testid="location-probe">{location.pathname + location.search}</span>;
  }

  function probe() {
    return screen.getByTestId('location-probe').textContent ?? '';
  }

  function renderAt(initialEntry: string) {
    mockFetchWithEmbeddingStatus(mockEmbeddingStatusIdle);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[initialEntry]}>
          <div data-scroll-container style={{ height: 800, overflow: 'auto' }}>
            <LocationProbe />
            <PagesPage />
          </div>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it('restores every filter from the URL on mount', async () => {
    renderAt(
      '/?space=DEV&source=standalone&author=Alice&labels=howto&freshness=stale' +
        '&embedding=pending&quality=poor&from=2025-01-01&to=2025-02-01&sort=title&page=2',
    );

    await screen.findByTestId('advanced-filters-panel');
    // The space <option>s arrive with the /spaces query; a <select> whose value
    // has no matching <option> yet reads back as ''.
    await waitFor(() =>
      expect((screen.getByLabelText('Filter by space') as HTMLSelectElement).value).toBe('DEV'),
    );
    expect((screen.getByTestId('filter-source') as HTMLSelectElement).value).toBe('standalone');
    expect((screen.getByLabelText('Sort pages') as HTMLSelectElement).value).toBe('title');
    expect((screen.getByTestId('filter-author') as HTMLSelectElement).value).toBe('Alice');
    expect((screen.getByTestId('filter-labels') as HTMLSelectElement).value).toBe('howto');
    expect((screen.getByTestId('filter-freshness') as HTMLSelectElement).value).toBe('stale');
    expect((screen.getByTestId('filter-embedding') as HTMLSelectElement).value).toBe('pending');
    expect((screen.getByTestId('filter-quality') as HTMLSelectElement).value).toBe('poor');
    expect((screen.getByTestId('filter-date-from') as HTMLInputElement).value).toBe('2025-01-01');
    expect((screen.getByTestId('filter-date-to') as HTMLInputElement).value).toBe('2025-02-01');
  });

  it('sends the restored page number to the API', async () => {
    const fetchSpy = mockFetchWithEmbeddingStatus(mockEmbeddingStatusIdle);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/?page=3']}>
          <div data-scroll-container style={{ height: 800, overflow: 'auto' }}><PagesPage /></div>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      const listCalls = fetchSpy.mock.calls
        .map(([a]) => (typeof a === 'string' ? a : (a as Request).url))
        .filter((u) => /\/pages\?/.test(u));
      expect(listCalls.some((u) => new URL(u, 'http://x').searchParams.get('page') === '3')).toBe(true);
    });
  });

  it('opens the advanced panel when the URL carries one of its filters', async () => {
    renderAt('/?author=Alice');
    expect(await screen.findByTestId('advanced-filters-panel')).toBeInTheDocument();
  });

  it('leaves the advanced panel closed for space / search / sort alone', async () => {
    renderAt('/?space=DEV&search=runbook&sort=title');
    await screen.findByLabelText('Filter by space');
    expect(screen.queryByTestId('advanced-filters-panel')).not.toBeInTheDocument();
  });

  it('writes a filter selection into the URL', async () => {
    renderAt('/');
    await screen.findByTestId('filter-source');

    fireEvent.change(screen.getByTestId('filter-source'), { target: { value: 'standalone' } });

    await waitFor(() => expect(probe()).toContain('source=standalone'));
  });

  it('drops the param from the URL when the filter is cleared', async () => {
    renderAt('/?freshness=stale');
    await screen.findByTestId('filter-pill-freshness');

    fireEvent.click(screen.getByTestId('filter-pill-freshness'));

    await waitFor(() => expect(probe()).not.toContain('freshness'));
    // …and the URL is clean rather than carrying `freshness=`.
    expect(probe()).toBe('/');
  });

  it('clear-all empties the query string', async () => {
    renderAt('/?author=Alice&freshness=stale&source=standalone');
    await screen.findByTestId('clear-all-pill-filters');

    fireEvent.click(screen.getByTestId('clear-all-pill-filters'));

    await waitFor(() => expect(probe()).toBe('/'));
  });

  it('returns to page 1 when a filter changes', async () => {
    renderAt('/?page=4');
    await screen.findByTestId('filter-source');

    fireEvent.change(screen.getByTestId('filter-source'), { target: { value: 'confluence' } });

    await waitFor(() => expect(probe()).toContain('source=confluence'));
    expect(probe()).not.toContain('page=');
  });

  // The whole point of `replace: true`. If each filter change pushed an entry,
  // Back would undo one filter at a time and never reach the page the user
  // actually came from.
  it('replaces history on a filter change instead of pushing', async () => {
    mockFetchWithEmbeddingStatus(mockEmbeddingStatusIdle);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const router = createMemoryRouter(
      [
        { path: '/elsewhere', element: <div>elsewhere</div> },
        { path: '/', element: <div data-scroll-container style={{ height: 800, overflow: 'auto' }}><PagesPage /></div> },
      ],
      { initialEntries: ['/elsewhere', '/'], initialIndex: 1 },
    );

    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await screen.findByTestId('filter-source');

    fireEvent.change(screen.getByTestId('filter-source'), { target: { value: 'standalone' } });
    await waitFor(() => expect(router.state.location.search).toContain('source=standalone'));
    fireEvent.change(screen.getByLabelText('Sort pages'), { target: { value: 'title' } });
    await waitFor(() => expect(router.state.location.search).toContain('sort=title'));

    // Two filter changes, still one entry deep: one Back leaves the overview.
    await act(async () => { await router.navigate(-1); });
    expect(router.state.location.pathname).toBe('/elsewhere');
  });

  // The reported bug, end to end.
  it('keeps the filter when an article is opened and the user navigates back', async () => {
    mockFetchWithEmbeddingStatus(mockEmbeddingStatusIdle);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const router = createMemoryRouter(
      [
        { path: '/', element: <div data-scroll-container style={{ height: 800, overflow: 'auto' }}><PagesPage /></div> },
        { path: '/pages/:id', element: <div>article view</div> },
      ],
      { initialEntries: ['/'] },
    );

    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await screen.findByText('Test Page');

    fireEvent.change(screen.getByTestId('filter-source'), { target: { value: 'standalone' } });
    await waitFor(() => expect(router.state.location.search).toContain('source=standalone'));

    // Open an article — this is the navigation that used to wipe the filter.
    fireEvent.click(await screen.findByText('Test Page'));
    await screen.findByText('article view');

    await act(async () => { await router.navigate(-1); });

    const restored = await screen.findByTestId('filter-source');
    expect((restored as HTMLSelectElement).value).toBe('standalone');
    expect(router.state.location.search).toContain('source=standalone');
  });

  // `mode`, `page` and `space` moved into the URL with everything else but had
  // no round-trip coverage of their own.
  it('round-trips the search mode through the URL', async () => {
    renderAt('/');
    fireEvent.change(await screen.findByPlaceholderText('Search pages...'), {
      target: { value: 'runbook' },
    });
    await screen.findByTestId('search-mode-semantic');

    fireEvent.click(screen.getByTestId('search-mode-semantic'));

    await waitFor(() => expect(probe()).toContain('mode=semantic'));
  });

  it('restores the search mode from the URL', async () => {
    renderAt('/?mode=hybrid');
    await waitFor(() => {
      expect(screen.getByTestId('search-mode-hybrid')).toHaveAttribute('aria-pressed', 'true');
    });
  });

  it('round-trips the space filter through the URL', async () => {
    renderAt('/');
    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'Development' })).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText('Filter by space'), { target: { value: 'DEV' } });

    await waitFor(() => expect(probe()).toContain('space=DEV'));
  });

  it('writes the page number when the pagination control is used', async () => {
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
    const items = makeManyPages(3).items;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.includes('/embeddings/status')) return json(mockEmbeddingStatusIdle);
      if (url.includes('/pages/filters')) return json(mockFilterOptions);
      if (url.includes('/spaces')) return json(mockSpaces);
      if (url.includes('/sync/status')) return json({ status: 'idle' });
      if (url.includes('/pages/pinned')) return json({ items: [], total: 0 });
      if (url.includes('/settings')) return json({});
      return json({ items, total: items.length, page: 1, limit: 3, totalPages: 3 });
    });

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/']}>
          <div data-scroll-container style={{ height: 800, overflow: 'auto' }}>
            <LocationProbe />
            <PagesPage />
          </div>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const next = await screen.findByLabelText('Next page');
    fireEvent.click(next);

    await waitFor(() => expect(probe()).toContain('page=2'));
  });

  // Holding an arrow key on a date segment fires change at OS key-repeat rate.
  // Each of those used to be a history write, which browsers throttle.
  describe('date filters', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('writes the settled date once, not once per adjustment', async () => {
      renderAt('/');
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      fireEvent.click(screen.getByTestId('advanced-filters-toggle'));

      const input = screen.getByTestId('filter-date-from');
      for (const value of ['2025-01-01', '2025-01-02', '2025-01-03']) {
        fireEvent.change(input, { target: { value } });
      }
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });

      // Mid-flight the control shows the newest value; the URL has not moved.
      expect((input as HTMLInputElement).value).toBe('2025-01-03');
      expect(probe()).not.toContain('from=');

      await act(async () => { await vi.advanceTimersByTimeAsync(300); });
      expect(probe()).toContain('from=2025-01-03');
    });

    it('seeds the date inputs from a deep link', async () => {
      renderAt('/?from=2025-01-01&to=2025-02-01');
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });

      expect((screen.getByTestId('filter-date-from') as HTMLInputElement).value).toBe('2025-01-01');
      expect((screen.getByTestId('filter-date-to') as HTMLInputElement).value).toBe('2025-02-01');
    });

    it('clears the date inputs when the filters are cleared', async () => {
      renderAt('/?from=2025-01-01');
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });

      fireEvent.click(screen.getByTestId('clear-all-pill-filters'));
      await act(async () => { await vi.advanceTimersByTimeAsync(300); });

      expect((screen.getByTestId('filter-date-from') as HTMLInputElement).value).toBe('');
      expect(probe()).toBe('/');
    });
  });

  describe('search term', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('writes only the settled term to the URL, not every keystroke', async () => {
      renderAt('/');
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });

      const input = screen.getByPlaceholderText('Search pages...');
      fireEvent.change(input, { target: { value: 'k' } });
      fireEvent.change(input, { target: { value: 'ku' } });
      fireEvent.change(input, { target: { value: 'kub' } });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });

      // Mid-flight the box shows the term but the URL has not caught up.
      expect((input as HTMLInputElement).value).toBe('kub');
      expect(probe()).not.toContain('search=kub');

      await act(async () => { await vi.advanceTimersByTimeAsync(300); });
      expect(probe()).toContain('search=kub');
    });

    it('seeds the box from a deep-linked search term', async () => {
      renderAt('/?search=runbook');
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });

      expect((screen.getByPlaceholderText('Search pages...') as HTMLInputElement).value).toBe('runbook');
    });

    it('removes the term from the URL when the search is cleared', async () => {
      renderAt('/?search=runbook');
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });

      fireEvent.click(screen.getByTestId('search-clear'));
      await act(async () => { await vi.advanceTimersByTimeAsync(300); });

      expect(probe()).not.toContain('search=');
    });
  });
});
