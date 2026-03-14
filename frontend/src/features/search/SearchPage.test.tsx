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
  limit: 50,
  totalPages: 1,
};

function mockFetch(pagesResponse = mockSearchResults) {
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
    return new Response(JSON.stringify(pagesResponse), {
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

describe('SearchPage', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
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

  it('shows search results when query is entered', async () => {
    mockFetch();
    render(<SearchPage />, { wrapper: createWrapper() });
    const input = screen.getByTestId('search-input');
    fireEvent.change(input, { target: { value: 'Redis' } });

    await waitFor(() => {
      expect(screen.getByTestId('search-results-count')).toHaveTextContent('2 results');
    });

    expect(screen.getByTestId('search-result-page-1')).toBeInTheDocument();
    expect(screen.getByTestId('search-result-page-2')).toBeInTheDocument();
  });

  it('navigates to page when result is clicked', async () => {
    mockFetch();
    render(<SearchPage />, { wrapper: createWrapper() });
    const input = screen.getByTestId('search-input');
    fireEvent.change(input, { target: { value: 'Redis' } });

    await waitFor(() => {
      expect(screen.getByTestId('search-result-page-1')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('search-result-page-1'));
    expect(mockNavigate).toHaveBeenCalledWith('/pages/page-1');
  });

  it('shows no results message with request CTA when empty', async () => {
    mockFetch({
      items: [],
      total: 0,
      page: 1,
      limit: 50,
      totalPages: 0,
    });
    render(<SearchPage />, { wrapper: createWrapper() });
    const input = screen.getByTestId('search-input');
    fireEvent.change(input, { target: { value: 'nonexistent topic' } });

    await waitFor(() => {
      expect(screen.getByTestId('no-results-title')).toHaveTextContent('No results found');
    });
    expect(screen.getByTestId('request-content-cta')).toBeInTheDocument();
  });

  it('renders sort select with options', () => {
    mockFetch();
    render(<SearchPage />, { wrapper: createWrapper() });
    const select = screen.getByTestId('search-sort') as HTMLSelectElement;
    expect(select.options.length).toBe(3);
  });
});
