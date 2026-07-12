import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { PagesPage } from './PagesPage';

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
  // Mock element dimensions so @tanstack/react-virtual can compute visible items in jsdom
  const originalGetBCR = Element.prototype.getBoundingClientRect;

  beforeEach(() => {
    mockFetchWithEmbeddingStatus(mockEmbeddingStatusIdle);

    // Give the scroll container a usable height for the virtualizer
    Element.prototype.getBoundingClientRect = function () {
      if (this.hasAttribute?.('data-scroll-container')) {
        return { top: 0, left: 0, bottom: 800, right: 1024, width: 1024, height: 800, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
      }
      // For virtual list items measured by the virtualizer
      if (this.hasAttribute?.('data-index')) {
        return { top: 0, left: 0, bottom: 80, right: 1024, width: 1024, height: 80, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
      }
      return originalGetBCR.call(this);
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Element.prototype.getBoundingClientRect = originalGetBCR;
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

  it('renders the page title, search input, and filter controls', () => {
    render(<PagesPage />, { wrapper: createWrapper() });
    expect(screen.getByText('Pages')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Search pages...')).toBeInTheDocument();
    expect(screen.getByTestId('advanced-filters-toggle')).toBeInTheDocument();
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

  it('shows clear filters button when filters are active', () => {
    render(<PagesPage />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByTestId('advanced-filters-toggle'));
    fireEvent.change(screen.getByTestId('filter-freshness'), { target: { value: 'stale' } });
    expect(screen.getByTestId('clear-filters')).toBeInTheDocument();
  });

  it('clears all advanced filters when clear button is clicked', () => {
    render(<PagesPage />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByTestId('advanced-filters-toggle'));

    // Set some filters
    fireEvent.change(screen.getByTestId('filter-freshness'), { target: { value: 'stale' } });
    fireEvent.change(screen.getByTestId('filter-embedding'), { target: { value: 'pending' } });

    // Click clear
    fireEvent.click(screen.getByTestId('clear-filters'));

    // Verify filters are reset
    expect((screen.getByTestId('filter-freshness') as HTMLSelectElement).value).toBe('');
    expect((screen.getByTestId('filter-embedding') as HTMLSelectElement).value).toBe('');
    expect(screen.queryByTestId('clear-filters')).not.toBeInTheDocument();
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

  it('renders pinned articles section before the filters section', async () => {
    vi.restoreAllMocks();
    mockFetchWithPinnedPages(mockPinnedResponse);
    render(<PagesPage />, { wrapper: createWrapper() });

    const section = await screen.findByTestId('pinned-articles-section');
    const filtersToggle = screen.getByTestId('advanced-filters-toggle');

    // Pinned section should appear before the filters in the DOM
    const comparison = section.compareDocumentPosition(filtersToggle);
    // Node.DOCUMENT_POSITION_FOLLOWING = 4 means filtersToggle follows section
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
      fireEvent.click(screen.getByTestId('search-mode-semantic'));
      fireEvent.change(screen.getByPlaceholderText('Search pages...'), {
        target: { value: 'nonexistent topic' },
      });
      return fetchSpy;
    }

    it('zero embeddings + zero results: empty state acknowledges the keyword fallback and the missing embeddings', async () => {
      renderSemanticSearchWithNoResults(false);

      // The fallback banner and the empty state show together, so their copy
      // must not contradict: the banner already says keyword search ran, so
      // the empty state must not imply embedding alone would find a match.
      expect(await screen.findByText('No matching pages', undefined, { timeout: 2000 })).toBeInTheDocument();
      expect(
        screen.getByText('Keyword search found no matches. Semantic search is unavailable until pages are embedded — configure an embedding provider in Settings → LLM and run an embedding pass.'),
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
    expect(screen.getByTestId('filter-pill-freshness')).toHaveTextContent('Freshness: stale');
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

    expect(screen.getByTestId('filter-pill-freshness')).toHaveTextContent('Freshness: fresh');
    expect(screen.getByTestId('filter-pill-embeddingStatus')).toHaveTextContent('Embedding: pending');
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
    expect(screen.getByTestId('filter-pill-embeddingStatus')).toBeInTheDocument();

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
    expect(screen.queryByTestId('filter-pill-embeddingStatus')).not.toBeInTheDocument();
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
      fireEvent.click(screen.getByTestId('search-mode-semantic'));
      fireEvent.change(screen.getByPlaceholderText('Search pages...'), {
        target: { value: 'kubernetes' },
      });

      const notice = await screen.findByTestId('filters-ignored-notice');
      expect(notice).toBeInTheDocument();
      expect(screen.getByTestId('active-filter-pills')).toHaveAttribute('data-inactive', 'true');
    });

    it('does not show the notice in semantic mode when no advanced filters are active', () => {
      render(<PagesPage />, { wrapper: createWrapper() });
      fireEvent.click(screen.getByTestId('search-mode-semantic'));
      fireEvent.change(screen.getByPlaceholderText('Search pages...'), {
        target: { value: 'kubernetes' },
      });
      expect(screen.queryByTestId('filters-ignored-notice')).not.toBeInTheDocument();
    });
  });

  // --- Visual divider test ---

  it('renders a visual divider between sort and filters toggle', () => {
    render(<PagesPage />, { wrapper: createWrapper() });
    expect(screen.getByTestId('sort-filter-divider')).toBeInTheDocument();
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
    expect(pill).toHaveAttribute('aria-label', 'Remove Freshness: stale filter');
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
    it('renders three search mode buttons (keyword, semantic, hybrid)', () => {
      render(<PagesPage />, { wrapper: createWrapper() });
      expect(screen.getByTestId('search-mode-keyword')).toBeInTheDocument();
      expect(screen.getByTestId('search-mode-semantic')).toBeInTheDocument();
      expect(screen.getByTestId('search-mode-hybrid')).toBeInTheDocument();
    });

    it('defaults to keyword mode as active', () => {
      render(<PagesPage />, { wrapper: createWrapper() });
      const keyword = screen.getByTestId('search-mode-keyword');
      expect(keyword).toHaveAttribute('aria-pressed', 'true');
      // Active mode uses ink-action fill (Task 5 — amber reserved for AI affordances; search-mode toggle is non-AI selection).
      expect(keyword.className).toContain('bg-action');
      expect(keyword.className).toContain('shadow-md');
      expect(keyword.className).toContain('ring-1');
    });

    it('marks inactive buttons with aria-pressed=false', () => {
      render(<PagesPage />, { wrapper: createWrapper() });
      const semantic = screen.getByTestId('search-mode-semantic');
      const hybrid = screen.getByTestId('search-mode-hybrid');
      expect(semantic).toHaveAttribute('aria-pressed', 'false');
      expect(hybrid).toHaveAttribute('aria-pressed', 'false');
    });

    it('switches active mode on click', () => {
      render(<PagesPage />, { wrapper: createWrapper() });
      const semantic = screen.getByTestId('search-mode-semantic');
      fireEvent.click(semantic);

      expect(semantic).toHaveAttribute('aria-pressed', 'true');
      // Active mode uses ink-action fill (Task 5).
      expect(semantic.className).toContain('bg-action');
      expect(semantic.className).toContain('shadow-md');

      const keyword = screen.getByTestId('search-mode-keyword');
      expect(keyword).toHaveAttribute('aria-pressed', 'false');
      expect(keyword.className).not.toContain('shadow-md');
    });

    it('active button has stronger visual weight (shadow + ring) vs inactive', () => {
      render(<PagesPage />, { wrapper: createWrapper() });
      const active = screen.getByTestId('search-mode-keyword');
      const inactive = screen.getByTestId('search-mode-semantic');

      expect(active.className).toContain('shadow-md');
      expect(active.className).toContain('ring-1');
      expect(inactive.className).not.toContain('shadow-md');
      expect(inactive.className).not.toContain('ring-1');
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

      const pill = screen.getByTestId('filter-pill-sourceFilter');
      expect(pill).toHaveTextContent('Source: Local');
      expect(pill).not.toHaveTextContent('standalone');
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

    it('Local badge uses sage tint (AA-pass), not emerald-500', async () => {
      mockPagesWithStandalone('private');
      render(<PagesPage />, { wrapper: createWrapper() });
      const badge = await screen.findByTestId('badge-local');
      expect(badge).toHaveTextContent('Local');
      expect(badge.className).toMatch(/bg-\[#e7f2e8\]/);
      expect(badge.className).toMatch(/text-\[#1f5a2a\]/);
      expect(badge.className).not.toMatch(/emerald-500|amber|warning|yellow/);
    });

    it('Private badge uses neutral gray tint, not amber/primary/warning', async () => {
      mockPagesWithStandalone('private');
      render(<PagesPage />, { wrapper: createWrapper() });
      const badge = await screen.findByTestId('badge-private');
      expect(badge).toHaveTextContent('Private');
      expect(badge.className).not.toMatch(/amber|warning|yellow|primary/);
      expect(badge.className).toMatch(/bg-\[#ececea\]/);
      expect(badge.className).toMatch(/text-\[#4a4a48\]/);
    });

    it('Shared badge uses cool-blue tinted pill (AA-pass), not sky-500', async () => {
      mockPagesWithStandalone('shared');
      render(<PagesPage />, { wrapper: createWrapper() });
      const badge = await screen.findByTestId('badge-shared');
      expect(badge).toHaveTextContent('Shared');
      expect(badge.className).toMatch(/bg-\[#e6effb\]/);
      expect(badge.className).toMatch(/text-\[#1c3e72\]/);
      expect(badge.className).not.toMatch(/sky-500|amber|warning|yellow/);
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
    function pagesSearchValues(fetchSpy: ReturnType<typeof vi.spyOn>): string[] {
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

      fireEvent.click(screen.getByTestId('search-mode-semantic'));
      fireEvent.change(screen.getByPlaceholderText('Search pages...'), {
        target: { value: 'kubernetes' },
      });

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
      function pagesListRequests(fetchSpy: ReturnType<typeof vi.spyOn>) {
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
        expect(newRequests[0].search).toBe('k');
        expect(newRequests[0].sort).toBe('relevance');
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
});
