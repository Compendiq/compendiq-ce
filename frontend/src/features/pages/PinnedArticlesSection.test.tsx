import { describe, it, expect, vi, afterEach, type MockInstance } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { PinnedArticlesSection } from './PinnedArticlesSection';
import { COLLAPSED_PIN_COUNT } from './pinned-articles-layout';

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
  let fetchSpy: MockInstance<typeof fetch>;

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
    expect(screen.getByText('Pinned Pages')).toBeInTheDocument();
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

  it('shows space key and author on pinned cards without excerpt', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response(JSON.stringify(mockPinnedResponse), {
        headers: { 'Content-Type': 'application/json' },
      });
    });

    render(<PinnedArticlesSection />, { wrapper: createWrapper() });

    await screen.findByTestId('pinned-articles-section');

    expect(screen.getByText('DEV')).toBeInTheDocument();
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.queryByText('This is a getting started guide for new developers.')).not.toBeInTheDocument();
  });

  it('renders title with line-clamp-2 allowing multiline title up to 2 lines', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response(JSON.stringify(mockPinnedResponse), {
        headers: { 'Content-Type': 'application/json' },
      });
    });

    render(<PinnedArticlesSection />, { wrapper: createWrapper() });

    await screen.findByTestId('pinned-articles-section');

    const titleElement = screen.getByText('Getting Started Guide');
    expect(titleElement.className).toContain('line-clamp-2');
    expect(titleElement.className).not.toContain('truncate');
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

  // ── Unbounded pins ───────────────────────────────────────────────────────

  function manyPinsResponse(count: number) {
    return {
      items: Array.from({ length: count }, (_, i) => ({
        id: `pin-${i + 1}`,
        spaceKey: 'DEV',
        title: `Pinned Article ${i + 1}`,
        author: 'Alice',
        lastModifiedAt: '2025-05-20T00:00:00Z',
        excerpt: `Excerpt for article ${i + 1}`,
        pinnedAt: new Date(Date.UTC(2025, 5, 1) - i * 60_000).toISOString(),
        pinOrder: i,
      })),
      total: count,
    };
  }

  function mockPins(count: number) {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response(JSON.stringify(manyPinsResponse(count)), {
        headers: { 'Content-Type': 'application/json' },
      });
    });
  }

  it('renders all pinned cards without collapsing at 8', async () => {
    mockPins(30);

    render(<PinnedArticlesSection />, { wrapper: createWrapper() });
    await screen.findByTestId('pinned-articles-section');

    for (let i = 1; i <= 30; i++) {
      expect(screen.getByTestId(`pinned-card-pin-${i}`)).toBeInTheDocument();
    }
    expect(screen.queryByTestId('pinned-expand-toggle')).not.toBeInTheDocument();
  });

  it('states the total in the section heading for large pin counts', async () => {
    mockPins(30);

    render(<PinnedArticlesSection />, { wrapper: createWrapper() });
    await screen.findByTestId('pinned-articles-section');

    expect(screen.getByTestId('pinned-count')).toHaveTextContent('30');
  });

  it('renders every pin, even 100 pins, directly without a toggle', async () => {
    mockPins(100);

    render(<PinnedArticlesSection />, { wrapper: createWrapper() });
    await screen.findByTestId('pinned-articles-section');

    expect(screen.getByTestId('pinned-card-pin-100')).toBeInTheDocument();
    expect(screen.getAllByTestId(/^pinned-card-pin-/)).toHaveLength(100);
    expect(screen.queryByTestId('pinned-expand-toggle')).not.toBeInTheDocument();
  });

  it('states the count for a screen reader, not just as a bare number', async () => {
    mockPins(30);

    render(<PinnedArticlesSection />, { wrapper: createWrapper() });
    await screen.findByTestId('pinned-articles-section');

    expect(screen.getByTestId('pinned-count')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByText('30 pinned')).toBeInTheDocument();
  });

  it('names the section by its heading', async () => {
    mockPins(2);

    render(<PinnedArticlesSection />, { wrapper: createWrapper() });

    const section = await screen.findByTestId('pinned-articles-section');
    expect(section.tagName).toBe('SECTION');
    expect(section).toHaveAttribute('aria-labelledby', 'pinned-pages-heading');
    expect(document.getElementById('pinned-pages-heading')).toHaveTextContent('Pinned Pages');
  });

  it('moves focus to the next unpin button after unpinning', async () => {
    let items = 3;
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if ((init?.method ?? 'GET') === 'DELETE' && url.includes('/pin')) {
        items = 2;
        return new Response(JSON.stringify({ message: 'Page unpinned' }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify(manyPinsResponse(items)), {
        headers: { 'Content-Type': 'application/json' },
      });
    });

    render(<PinnedArticlesSection />, { wrapper: createWrapper() });
    await screen.findByTestId('pinned-articles-section');

    const first = screen.getByTestId('unpin-btn-pin-1');
    first.focus();
    fireEvent.click(first);

    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByTestId('unpin-btn-pin-2'));
    });
  });
});

