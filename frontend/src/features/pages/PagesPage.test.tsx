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
          {children}
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
  dirtyPages: 0,
  totalEmbeddings: 50,
  isProcessing: false,
};

const mockEmbeddingStatusProcessing = {
  totalPages: 50,
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

describe('PagesPage', () => {
  beforeEach(() => {
    mockFetchWithEmbeddingStatus(mockEmbeddingStatusIdle);
  });

  afterEach(() => {
    vi.restoreAllMocks();
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
    // Title container should have text-left alignment
    const container = title.parentElement!;
    expect(container.className).toContain('text-left');
  });

  it('shows embedding progress banner when embedding is processing', async () => {
    vi.restoreAllMocks();
    mockFetchWithEmbeddingStatus(mockEmbeddingStatusProcessing);
    render(<PagesPage />, { wrapper: createWrapper() });
    const banner = await screen.findByTestId('embedding-progress-banner');
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveTextContent('Embedding in progress');
    expect(banner).toHaveTextContent('12 pages remaining');
    expect(banner).toHaveTextContent('38/50');
  });

  it('does not show embedding progress banner when embedding is idle', async () => {
    render(<PagesPage />, { wrapper: createWrapper() });
    // Wait for pages to load to ensure all queries have resolved
    await screen.findByText('Test Page');
    expect(screen.queryByTestId('embedding-progress-banner')).not.toBeInTheDocument();
  });

  // --- Scroll behaviour tests ---

  it('never renders a nested scroll container — single page scroll for all list sizes', async () => {
    render(<PagesPage />, { wrapper: createWrapper() });
    await screen.findByText('Test Page');
    // No element with overflow-auto should exist for the page list
    expect(screen.queryByTestId('virtual-scroll-container')).not.toBeInTheDocument();
  });

  it('renders all items in a plain list for large page counts (>20)', async () => {
    vi.restoreAllMocks();
    mockFetchWithPages(makeManyPages(50));
    render(<PagesPage />, { wrapper: createWrapper() });

    // All 50 items should render in a simple div, no separate scroll container
    expect(screen.queryByTestId('virtual-scroll-container')).not.toBeInTheDocument();
    // Each item renders an article-hover wrapper with its id
    const items = await screen.findAllByTestId(/^article-hover-/);
    expect(items.length).toBeGreaterThanOrEqual(50);
  });
});
