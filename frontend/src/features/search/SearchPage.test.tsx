import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SearchPage } from './SearchPage';
import { useAuthStore } from '../../stores/auth-store';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

// Mock the useSearch hook to isolate the component from network
const mockUseSearch = vi.fn();
vi.mock('../../shared/hooks/use-search', () => ({
  useSearch: (...args: unknown[]) => mockUseSearch(...args),
}));

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

const makeSearchResult = (id: number | string, title: string) => ({
  id,
  title,
  spaceKey: 'DEV',
  excerpt: `Excerpt for ${title}`,
  score: 0.8,
});

const defaultUseSearchReturn = {
  immediateResults: [],
  enhancedResults: undefined,
  isLoadingImmediate: false,
  isLoadingEnhanced: false,
  hasEmbeddings: true,
};

const mockSearchResults = {
  items: [
    {
      id: 'page-1',
      spaceKey: 'DEV',
      title: 'Getting Started with Redis',
      author: 'Alice',
      lastModifiedAt: '2026-01-15T00:00:00Z',
      labels: ['howto', 'redis'],
    },
    {
      id: 'page-2',
      spaceKey: 'OPS',
      title: 'Redis Cluster Setup',
      author: 'Bob',
      lastModifiedAt: '2026-02-01T00:00:00Z',
      labels: ['operations'],
    },
  ],
  total: 2,
  page: 1,
  limit: 10,
  totalPages: 1,
  mode: 'keyword',
  hasEmbeddings: true,
};

function mockFetch(response = mockSearchResults) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    if (url.includes('/pages/filters')) {
      return new Response(
        JSON.stringify({ authors: ['Alice', 'Bob'], labels: ['howto', 'redis'] }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (url.includes('/spaces')) {
      return new Response(
        JSON.stringify([{ key: 'DEV', name: 'Development' }]),
        { headers: { 'Content-Type': 'application/json' } },
      );
    }
    return new Response(JSON.stringify(response), {
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

describe('SearchPage', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    mockUseSearch.mockReturnValue(defaultUseSearchReturn);
    useAuthStore.getState().setAuth('test-token', {
      id: '1',
      username: 'admin',
      role: 'admin',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    useAuthStore.getState().clearAuth();
  });

  it('renders the search page with input and heading', () => {
    mockFetch();
    render(<SearchPage />, { wrapper: createWrapper() });
    expect(screen.getByText('Search')).toBeInTheDocument();
    expect(screen.getByTestId('search-input')).toBeInTheDocument();
  });

  it('shows start searching message when no query', () => {
    mockFetch();
    render(<SearchPage />, { wrapper: createWrapper() });
    expect(screen.getByText('Start searching')).toBeInTheDocument();
  });

  it('shows filters panel when toggle is clicked', () => {
    mockFetch();
    render(<SearchPage />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByTestId('search-filters-toggle'));
    expect(screen.getByTestId('search-filters-panel')).toBeInTheDocument();
    expect(screen.getByTestId('filter-source')).toBeInTheDocument();
    expect(screen.getByTestId('filter-space')).toBeInTheDocument();
  });

  it('renders sort select with options', () => {
    mockFetch();
    render(<SearchPage />, { wrapper: createWrapper() });
    const select = screen.getByTestId('search-sort') as HTMLSelectElement;
    expect(select.options.length).toBe(3);
  });

  // ── Mode toggle ────────────────────────────────────────────────────────────

  it('renders mode toggle pills: Keyword, Semantic, Hybrid', () => {
    mockFetch();
    render(<SearchPage />, { wrapper: createWrapper() });
    expect(screen.getByTestId('mode-toggle-keyword')).toBeInTheDocument();
    expect(screen.getByTestId('mode-toggle-semantic')).toBeInTheDocument();
    expect(screen.getByTestId('mode-toggle-hybrid')).toBeInTheDocument();
  });

  it('mode toggle is disabled when search input is empty', () => {
    mockFetch();
    render(<SearchPage />, { wrapper: createWrapper() });
    const keywordBtn = screen.getByTestId('mode-toggle-keyword') as HTMLButtonElement;
    const semanticBtn = screen.getByTestId('mode-toggle-semantic') as HTMLButtonElement;
    const hybridBtn = screen.getByTestId('mode-toggle-hybrid') as HTMLButtonElement;
    expect(keywordBtn.disabled).toBe(true);
    expect(semanticBtn.disabled).toBe(true);
    expect(hybridBtn.disabled).toBe(true);
  });

  it('mode toggle is enabled after typing in search input', () => {
    mockFetch();
    render(<SearchPage />, { wrapper: createWrapper() });
    const input = screen.getByTestId('search-input');
    fireEvent.change(input, { target: { value: 'redis' } });
    const keywordBtn = screen.getByTestId('mode-toggle-keyword') as HTMLButtonElement;
    expect(keywordBtn.disabled).toBe(false);
  });

  it('shows warning banner when hasEmbeddings=false and mode=semantic', () => {
    mockUseSearch.mockReturnValue({
      ...defaultUseSearchReturn,
      hasEmbeddings: false,
    });
    mockFetch();

    render(<SearchPage />, { wrapper: createWrapper() });
    const input = screen.getByTestId('search-input');
    fireEvent.change(input, { target: { value: 'redis' } });

    // Switch to semantic mode
    fireEvent.click(screen.getByTestId('mode-toggle-semantic'));

    expect(screen.getByTestId('no-embeddings-warning')).toBeInTheDocument();
    expect(screen.getByTestId('no-embeddings-warning').textContent).toContain('embeddings');
  });

  it('shows warning banner when hasEmbeddings=false and mode=hybrid', () => {
    mockUseSearch.mockReturnValue({
      ...defaultUseSearchReturn,
      hasEmbeddings: false,
    });
    mockFetch();

    render(<SearchPage />, { wrapper: createWrapper() });
    const input = screen.getByTestId('search-input');
    fireEvent.change(input, { target: { value: 'redis' } });

    fireEvent.click(screen.getByTestId('mode-toggle-hybrid'));

    expect(screen.getByTestId('no-embeddings-warning')).toBeInTheDocument();
  });

  it('does not show warning banner when mode=keyword', () => {
    mockUseSearch.mockReturnValue({
      ...defaultUseSearchReturn,
      hasEmbeddings: false,
    });
    mockFetch();

    render(<SearchPage />, { wrapper: createWrapper() });
    const input = screen.getByTestId('search-input');
    fireEvent.change(input, { target: { value: 'redis' } });

    // Default mode is keyword — no warning
    expect(screen.queryByTestId('no-embeddings-warning')).not.toBeInTheDocument();
  });

  it('does not show warning banner when hasEmbeddings=true', () => {
    mockUseSearch.mockReturnValue({
      ...defaultUseSearchReturn,
      hasEmbeddings: true,
    });
    mockFetch();

    render(<SearchPage />, { wrapper: createWrapper() });
    const input = screen.getByTestId('search-input');
    fireEvent.change(input, { target: { value: 'redis' } });

    fireEvent.click(screen.getByTestId('mode-toggle-semantic'));
    expect(screen.queryByTestId('no-embeddings-warning')).not.toBeInTheDocument();
  });

  // ── Progressive loading ────────────────────────────────────────────────────

  it('displays immediateResults while isLoadingEnhanced=true', () => {
    mockUseSearch.mockReturnValue({
      immediateResults: [makeSearchResult(1, 'Immediate Result')],
      enhancedResults: undefined,
      isLoadingImmediate: false,
      isLoadingEnhanced: true,  // enhanced still loading
      hasEmbeddings: true,
    });
    mockFetch();

    render(<SearchPage />, { wrapper: createWrapper() });
    const input = screen.getByTestId('search-input');
    fireEvent.change(input, { target: { value: 'redis' } });

    expect(screen.getByTestId('search-result-1')).toBeInTheDocument();
    expect(screen.getByText('Immediate Result')).toBeInTheDocument();
    // Enhanced loading indicator should be visible
    expect(screen.getByTestId('enhanced-loading-indicator')).toBeInTheDocument();
  });

  it('replaces with enhancedResults once they arrive', () => {
    mockUseSearch.mockReturnValue({
      immediateResults: [makeSearchResult(1, 'Keyword Result')],
      enhancedResults: [makeSearchResult(2, 'Semantic Result')],
      isLoadingImmediate: false,
      isLoadingEnhanced: false,
      hasEmbeddings: true,
    });
    mockFetch();

    render(<SearchPage />, { wrapper: createWrapper() });
    const input = screen.getByTestId('search-input');
    fireEvent.change(input, { target: { value: 'redis' } });

    fireEvent.click(screen.getByTestId('mode-toggle-semantic'));

    // Should show enhancedResults, not immediateResults
    expect(screen.getByTestId('search-result-2')).toBeInTheDocument();
    expect(screen.getByText('Semantic Result')).toBeInTheDocument();
    // The keyword result should NOT be shown (replaced by enhanced)
    expect(screen.queryByTestId('search-result-1')).not.toBeInTheDocument();
  });

  it('shows no results message when neither immediateResults nor enhancedResults', () => {
    mockUseSearch.mockReturnValue({
      immediateResults: [],
      enhancedResults: undefined,
      isLoadingImmediate: false,
      isLoadingEnhanced: false,
      hasEmbeddings: true,
    });
    mockFetch();

    render(<SearchPage />, { wrapper: createWrapper() });
    const input = screen.getByTestId('search-input');
    fireEvent.change(input, { target: { value: 'nonexistent topic' } });

    expect(screen.getByTestId('no-results-title')).toBeInTheDocument();
  });

  it('navigates to page when result is clicked', () => {
    mockUseSearch.mockReturnValue({
      immediateResults: [makeSearchResult('page-5', 'Click Me')],
      enhancedResults: undefined,
      isLoadingImmediate: false,
      isLoadingEnhanced: false,
      hasEmbeddings: true,
    });
    mockFetch();

    render(<SearchPage />, { wrapper: createWrapper() });
    const input = screen.getByTestId('search-input');
    fireEvent.change(input, { target: { value: 'redis' } });

    fireEvent.click(screen.getByTestId('search-result-page-5'));
    expect(mockNavigate).toHaveBeenCalledWith('/pages/page-5');
  });

  // ── Legacy: existing tests that should still pass ─────────────────────────

  it('shows search results (via useSearch) when query is entered', async () => {
    mockUseSearch.mockReturnValue({
      immediateResults: [
        makeSearchResult('page-1', 'Getting Started with Redis'),
        makeSearchResult('page-2', 'Redis Cluster Setup'),
      ],
      enhancedResults: undefined,
      isLoadingImmediate: false,
      isLoadingEnhanced: false,
      hasEmbeddings: true,
    });
    mockFetch();

    render(<SearchPage />, { wrapper: createWrapper() });
    const input = screen.getByTestId('search-input');
    fireEvent.change(input, { target: { value: 'Redis' } });

    await waitFor(() => {
      expect(screen.getByTestId('search-result-page-1')).toBeInTheDocument();
      expect(screen.getByTestId('search-result-page-2')).toBeInTheDocument();
    });
  });
});
