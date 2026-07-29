import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { PinnedArticlesSection } from './PinnedArticlesSection';
import { COLLAPSED_PIN_COUNT, entranceDelay } from './pinned-articles-layout';

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

  // ── Unbounded pins (#1130) ───────────────────────────────────────────────
  // The server-side cap is gone, so the section has to stay a dashboard strip
  // rather than a wall of cards. It collapses to COLLAPSED_PIN_COUNT and hands
  // the rest over on request.

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

  it('collapses to COLLAPSED_PIN_COUNT cards when the user has more', async () => {
    mockPins(30);

    render(<PinnedArticlesSection />, { wrapper: createWrapper() });
    await screen.findByTestId('pinned-articles-section');

    for (let i = 1; i <= COLLAPSED_PIN_COUNT; i++) {
      expect(screen.getByTestId(`pinned-card-pin-${i}`)).toBeInTheDocument();
    }
    // The rest are out of the DOM, not merely hidden — they must not be tab
    // stops or reachable by a screen reader while collapsed.
    for (let i = COLLAPSED_PIN_COUNT + 1; i <= 30; i++) {
      expect(screen.queryByTestId(`pinned-card-pin-${i}`)).not.toBeInTheDocument();
    }
  });

  it('expands to every pin when the toggle is used, and collapses again', async () => {
    mockPins(30);

    render(<PinnedArticlesSection />, { wrapper: createWrapper() });
    await screen.findByTestId('pinned-articles-section');

    const toggle = screen.getByTestId('pinned-expand-toggle');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    // The label names how many are hidden, so the count is never a guess.
    expect(toggle).toHaveTextContent('22 more');

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(screen.getByTestId('pinned-card-pin-30')).toBeInTheDocument();
    });
    expect(screen.getByTestId('pinned-expand-toggle')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('pinned-expand-toggle')).toHaveTextContent('Show fewer');

    fireEvent.click(screen.getByTestId('pinned-expand-toggle'));

    await waitFor(() => {
      expect(screen.queryByTestId('pinned-card-pin-30')).not.toBeInTheDocument();
    });
  });

  it('renders every pin and no toggle when at or below the collapsed count', async () => {
    mockPins(COLLAPSED_PIN_COUNT);

    render(<PinnedArticlesSection />, { wrapper: createWrapper() });
    await screen.findByTestId('pinned-articles-section');

    for (let i = 1; i <= COLLAPSED_PIN_COUNT; i++) {
      expect(screen.getByTestId(`pinned-card-pin-${i}`)).toBeInTheDocument();
    }
    expect(screen.queryByTestId('pinned-expand-toggle')).not.toBeInTheDocument();
  });

  it('states the total in the section heading', async () => {
    mockPins(30);

    render(<PinnedArticlesSection />, { wrapper: createWrapper() });
    await screen.findByTestId('pinned-articles-section');

    expect(screen.getByTestId('pinned-count')).toHaveTextContent('30');
  });

  it('caps the entrance stagger so a long list does not trickle in', async () => {
    // 100 pins × 0.05s would put the last card 5 seconds out. The delay has to
    // plateau, or "Show all" looks broken on a large list.
    mockPins(100);

    render(<PinnedArticlesSection />, { wrapper: createWrapper() });
    await screen.findByTestId('pinned-articles-section');
    fireEvent.click(screen.getByTestId('pinned-expand-toggle'));

    await waitFor(() => {
      expect(screen.getByTestId('pinned-card-pin-100')).toBeInTheDocument();
    });
    expect(entranceDelay(99)).toBeLessThanOrEqual(0.5);
    expect(entranceDelay(0)).toBeLessThan(entranceDelay(3));
  });
});
