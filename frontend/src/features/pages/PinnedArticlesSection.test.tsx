import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { PinnedArticlesSection, MAX_VISIBLE_PINS } from './PinnedArticlesSection';

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

const mockPinnedResponse = {
  items: [
    {
      id: 'page-1',
      spaceKey: 'DEV',
      title: 'Getting Started Guide',
      author: 'Alice',
      lastModifiedAt: '2025-05-20T00:00:00Z',
      excerpt: 'This is a getting started guide for new developers.',
      pinnedAt: '2025-06-01T00:00:00Z',
      pinOrder: 0,
    },
    {
      id: 'page-2',
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

const emptyPinnedResponse = {
  items: [],
  total: 0,
};

describe('PinnedArticlesSection', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders pinned cards when pins exist', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response(JSON.stringify(mockPinnedResponse), {
        headers: { 'Content-Type': 'application/json' },
      });
    });

    render(<PinnedArticlesSection />, { wrapper: createWrapper() });

    const section = await screen.findByTestId('pinned-articles-section');
    expect(section).toBeInTheDocument();
    expect(screen.getByText('Pinned Articles')).toBeInTheDocument();
    expect(screen.getByText('Getting Started Guide')).toBeInTheDocument();
    expect(screen.getByText('Deployment Runbook')).toBeInTheDocument();
  });

  it('renders nothing when no pins exist', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response(JSON.stringify(emptyPinnedResponse), {
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const { container } = render(<PinnedArticlesSection />, { wrapper: createWrapper() });

    // Wait for query to settle
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalled();
    });

    // Should render nothing
    expect(screen.queryByTestId('pinned-articles-section')).not.toBeInTheDocument();
    expect(container.innerHTML).toBe('');
  });

  it('shows space key, author, and excerpt on pinned cards', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response(JSON.stringify(mockPinnedResponse), {
        headers: { 'Content-Type': 'application/json' },
      });
    });

    render(<PinnedArticlesSection />, { wrapper: createWrapper() });

    await screen.findByTestId('pinned-articles-section');

    expect(screen.getByText('DEV')).toBeInTheDocument();
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('This is a getting started guide for new developers.')).toBeInTheDocument();
  });

  it('shows unpin button on each card', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response(JSON.stringify(mockPinnedResponse), {
        headers: { 'Content-Type': 'application/json' },
      });
    });

    render(<PinnedArticlesSection />, { wrapper: createWrapper() });

    await screen.findByTestId('pinned-articles-section');

    expect(screen.getByTestId('unpin-btn-page-1')).toBeInTheDocument();
    expect(screen.getByTestId('unpin-btn-page-2')).toBeInTheDocument();
  });

  it('calls unpin API when unpin button is clicked', async () => {
    let callCount = 0;
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      const method = init?.method ?? 'GET';

      if (method === 'DELETE' && url.includes('/pages/page-1/pin')) {
        return new Response(JSON.stringify({ message: 'Page unpinned', pageId: 'page-1' }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Return pinned data, then empty after unpin
      callCount++;
      if (callCount <= 1) {
        return new Response(JSON.stringify(mockPinnedResponse), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify(emptyPinnedResponse), {
        headers: { 'Content-Type': 'application/json' },
      });
    });

    render(<PinnedArticlesSection />, { wrapper: createWrapper() });

    const unpinBtn = await screen.findByTestId('unpin-btn-page-1');
    fireEvent.click(unpinBtn);

    await waitFor(() => {
      const deleteCall = fetchSpy.mock.calls.find(
        (call: [input: string | URL | Request, init?: RequestInit | undefined]) => {
          const url = typeof call[0] === 'string' ? call[0] : (call[0] as Request).url;
          return url.includes('/pages/page-1/pin') && call[1]?.method === 'DELETE';
        },
      );
      expect(deleteCall).toBeDefined();
    });
  });

  it('renders at most MAX_VISIBLE_PINS (8) cards when API returns more', async () => {
    const manyPins = {
      items: Array.from({ length: 12 }, (_, i) => ({
        id: `pin-${i + 1}`,
        spaceKey: 'DEV',
        title: `Pinned Article ${i + 1}`,
        author: 'Alice',
        lastModifiedAt: '2025-05-20T00:00:00Z',
        excerpt: `Excerpt for article ${i + 1}`,
        pinnedAt: new Date(Date.now() - i * 60_000).toISOString(),
        pinOrder: i,
      })),
      total: 12,
    };

    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response(JSON.stringify(manyPins), {
        headers: { 'Content-Type': 'application/json' },
      });
    });

    render(<PinnedArticlesSection />, { wrapper: createWrapper() });

    await screen.findByTestId('pinned-articles-section');

    // Only the first 8 should be rendered
    for (let i = 1; i <= MAX_VISIBLE_PINS; i++) {
      expect(screen.getByTestId(`pinned-card-pin-${i}`)).toBeInTheDocument();
    }

    // Items beyond MAX_VISIBLE_PINS should NOT be rendered
    for (let i = MAX_VISIBLE_PINS + 1; i <= 12; i++) {
      expect(screen.queryByTestId(`pinned-card-pin-${i}`)).not.toBeInTheDocument();
    }
  });
});
