import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LazyMotion, domMax } from 'framer-motion';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { KnowledgeRequestsPage } from './KnowledgeRequestsPage';
import { useAuthStore } from '../../stores/auth-store';

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => vi.fn(),
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
          <LazyMotion features={domMax}>
            {children}
          </LazyMotion>
        </MemoryRouter>
      </QueryClientProvider>
    );
  };
}

const mockRequests = {
  items: [
    {
      id: 'req-1',
      title: 'Redis caching guide',
      description: 'We need a guide on Redis caching patterns',
      priority: 'high',
      status: 'open',
      requesterId: 'u1',
      requesterName: 'Alice',
      assigneeId: null,
      assigneeName: null,
      linkedPageId: null,
      createdAt: '2026-03-01T00:00:00Z',
      updatedAt: '2026-03-01T00:00:00Z',
    },
    {
      id: 'req-2',
      title: 'Docker best practices',
      description: '',
      priority: 'medium',
      status: 'completed',
      requesterId: 'u2',
      requesterName: 'Bob',
      assigneeId: 'u1',
      assigneeName: 'Alice',
      linkedPageId: 'p1',
      createdAt: '2026-02-15T00:00:00Z',
      updatedAt: '2026-03-05T00:00:00Z',
    },
  ],
  total: 2,
};

function mockFetch(data = mockRequests) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    if (url.includes('/knowledge-requests') && (!init || init.method !== 'POST')) {
      return new Response(JSON.stringify(data), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    // POST/mutations
    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

describe('KnowledgeRequestsPage', () => {
  beforeEach(() => {
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

  it('renders the page heading', () => {
    mockFetch();
    render(<KnowledgeRequestsPage />, { wrapper: createWrapper() });
    expect(screen.getByText('Knowledge Requests')).toBeInTheDocument();
  });

  it('shows create request button', () => {
    mockFetch();
    render(<KnowledgeRequestsPage />, { wrapper: createWrapper() });
    expect(screen.getByTestId('create-request-btn')).toBeInTheDocument();
  });

  it('shows request list items', async () => {
    mockFetch();
    render(<KnowledgeRequestsPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('request-req-1')).toBeInTheDocument();
    });
    expect(screen.getByText('Redis caching guide')).toBeInTheDocument();
    expect(screen.getByText('Docker best practices')).toBeInTheDocument();
  });

  it('shows tab navigation', () => {
    mockFetch();
    render(<KnowledgeRequestsPage />, { wrapper: createWrapper() });
    expect(screen.getByTestId('tab-all')).toBeInTheDocument();
    expect(screen.getByTestId('tab-mine')).toBeInTheDocument();
    expect(screen.getByTestId('tab-assigned')).toBeInTheDocument();
  });

  it('shows status filter', () => {
    mockFetch();
    render(<KnowledgeRequestsPage />, { wrapper: createWrapper() });
    expect(screen.getByTestId('status-filter')).toBeInTheDocument();
  });

  it('opens create request modal when button is clicked', () => {
    mockFetch();
    render(<KnowledgeRequestsPage />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByTestId('create-request-btn'));
    expect(screen.getByTestId('create-request-modal')).toBeInTheDocument();
    expect(screen.getByTestId('request-title-input')).toBeInTheDocument();
  });

  it('shows fulfill button on open requests', async () => {
    mockFetch();
    render(<KnowledgeRequestsPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('fulfill-req-1')).toBeInTheDocument();
    });
  });

  it('shows empty state when no requests', async () => {
    mockFetch({ items: [], total: 0 });
    render(<KnowledgeRequestsPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('empty-requests')).toHaveTextContent('No requests found');
    });
  });

  it('shows priority and status badges on request cards', async () => {
    mockFetch();
    render(<KnowledgeRequestsPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('request-req-1')).toBeInTheDocument();
    });
    expect(screen.getByText('High')).toBeInTheDocument();
    // "Open" appears in both the status filter dropdown and the badge;
    // verify the request card itself contains the badge text
    const reqCard = screen.getByTestId('request-req-1');
    expect(reqCard).toHaveTextContent('Open');
  });
});
