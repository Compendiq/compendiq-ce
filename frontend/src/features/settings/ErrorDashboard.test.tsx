import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ErrorDashboard } from './ErrorDashboard';

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

const mockSummary = {
  last24h: [{ errorType: 'Error', count: 5, lastOccurrence: '2026-03-05T10:00:00Z' }],
  last7d: [{ errorType: 'Error', count: 15, lastOccurrence: '2026-03-05T10:00:00Z' }],
  last30d: [{ errorType: 'Error', count: 30, lastOccurrence: '2026-03-05T10:00:00Z' }],
  unresolvedCount: 7,
};

const mockErrors = {
  items: [
    {
      id: 'err-1',
      errorType: 'TypeError',
      message: 'Cannot read property x of undefined',
      stack: 'TypeError: Cannot read property x of undefined\n    at Object.<anonymous> (test.js:1:1)',
      context: {},
      userId: null,
      requestPath: 'GET /api/pages',
      correlationId: 'corr-abc',
      resolved: false,
      createdAt: new Date(Date.now() - 5 * 60000).toISOString(), // 5 min ago
    },
    {
      id: 'err-2',
      errorType: 'Error',
      message: 'Database connection failed',
      stack: null,
      context: { retries: 3 },
      userId: 'user-1',
      requestPath: 'POST /api/sync',
      correlationId: null,
      resolved: true,
      createdAt: new Date(Date.now() - 2 * 3600000).toISOString(), // 2h ago
    },
  ],
  total: 2,
  page: 1,
  limit: 20,
};

describe('ErrorDashboard', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;

      if (url.includes('/admin/errors/summary')) {
        return new Response(JSON.stringify(mockSummary), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/resolve')) {
        return new Response(JSON.stringify({ message: 'Error marked as resolved' }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/admin/errors')) {
        return new Response(JSON.stringify(mockErrors), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      // fallback
      return new Response(JSON.stringify({}), {
        headers: { 'Content-Type': 'application/json' },
      });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the error dashboard', async () => {
    render(<ErrorDashboard />, { wrapper: createWrapper() });

    expect(screen.getByTestId('error-dashboard')).toBeInTheDocument();
    expect(screen.getByText('Error Monitor')).toBeInTheDocument();
  });

  it('shows summary stats', async () => {
    render(<ErrorDashboard />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('errors-today')).toHaveTextContent('5');
      expect(screen.getByTestId('errors-week')).toHaveTextContent('15');
      expect(screen.getByTestId('errors-unresolved')).toHaveTextContent('7');
    });
  });

  it('shows error entries', async () => {
    render(<ErrorDashboard />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText('Cannot read property x of undefined')).toBeInTheDocument();
      expect(screen.getByText('Database connection failed')).toBeInTheDocument();
    });
  });

  it('shows filter tabs', async () => {
    render(<ErrorDashboard />, { wrapper: createWrapper() });

    expect(screen.getByTestId('filter-unresolved')).toBeInTheDocument();
    expect(screen.getByTestId('filter-all')).toBeInTheDocument();
    expect(screen.getByTestId('filter-resolved')).toBeInTheDocument();
  });

  it('expands error details on click', async () => {
    render(<ErrorDashboard />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('error-row-err-1')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Cannot read property x of undefined'));

    expect(screen.getByTestId('error-detail-err-1')).toBeInTheDocument();
  });

  it('shows resolve button for unresolved errors', async () => {
    render(<ErrorDashboard />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('resolve-err-1')).toBeInTheDocument();
    });
  });

  it('shows Resolved badge for resolved errors', async () => {
    render(<ErrorDashboard />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText('Resolved')).toBeInTheDocument();
    });
  });

  it('shows empty state when no errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
      if (url.includes('summary')) {
        return new Response(JSON.stringify({ last24h: [], last7d: [], last30d: [], unresolvedCount: 0 }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ items: [], total: 0, page: 1, limit: 20 }), {
        headers: { 'Content-Type': 'application/json' },
      });
    });

    render(<ErrorDashboard />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText('No errors found')).toBeInTheDocument();
    });
  });
});
