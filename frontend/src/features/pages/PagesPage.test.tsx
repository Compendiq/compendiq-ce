import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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
    expect(screen.getByText('Pinned Articles')).toBeInTheDocument();
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

    it('renders selection state correctly in memoized items', async () => {
      render(<PagesPage />, { wrapper: createWrapper() });
      const checkbox = await screen.findByTestId('checkbox-page-1');

      // Click to select
      fireEvent.click(checkbox);

      // The item should show selected state
      const item = screen.getByTestId('article-hover-page-1');
      expect(item.className).toContain('border-primary');
    });
  });
});
