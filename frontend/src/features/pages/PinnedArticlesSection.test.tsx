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

  it('stretches every card to fill its grid row so uneven content does not leave ragged heights', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response(JSON.stringify(mockPinnedResponse), {
        headers: { 'Content-Type': 'application/json' },
      });
    });

    render(<PinnedArticlesSection />, { wrapper: createWrapper() });

    await screen.findByTestId('pinned-articles-section');

    // jsdom performs no layout, so this is a proxy for the real assertion:
    // grid items stretch to the row's height by default, and only a card
    // that also claims h-full actually fills that height instead of sizing
    // to its own (shorter) content and leaving empty space in its cell.
    expect(screen.getByTestId('pinned-card-page-1').className).toContain('h-full');
    expect(screen.getByTestId('pinned-card-page-2').className).toContain('h-full');
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

  it('renders every pin once expanded, however many there are', async () => {
    mockPins(100);

    render(<PinnedArticlesSection />, { wrapper: createWrapper() });
    await screen.findByTestId('pinned-articles-section');
    fireEvent.click(screen.getByTestId('pinned-expand-toggle'));

    await waitFor(() => {
      expect(screen.getByTestId('pinned-card-pin-100')).toBeInTheDocument();
    });
    expect(screen.getAllByTestId(/^pinned-card-pin-/)).toHaveLength(100);
  });

  // The boundary the toggle's render condition turns on. Tested at 8 (absent)
  // and 30 (present) before, which leaves an off-by-one free to hide the ninth
  // pin permanently.
  it('shows the toggle at exactly one pin past the collapsed count', async () => {
    mockPins(COLLAPSED_PIN_COUNT + 1);

    render(<PinnedArticlesSection />, { wrapper: createWrapper() });
    await screen.findByTestId('pinned-articles-section');

    const toggle = screen.getByTestId('pinned-expand-toggle');
    expect(toggle).toHaveTextContent('1 more');
    expect(screen.queryByTestId(`pinned-card-pin-${COLLAPSED_PIN_COUNT + 1}`)).not.toBeInTheDocument();

    fireEvent.click(toggle);
    await waitFor(() => {
      expect(screen.getByTestId(`pinned-card-pin-${COLLAPSED_PIN_COUNT + 1}`)).toBeInTheDocument();
    });
  });

  it('states the count for a screen reader, not just as a bare number', async () => {
    mockPins(30);

    render(<PinnedArticlesSection />, { wrapper: createWrapper() });
    await screen.findByTestId('pinned-articles-section');

    // The visual badge is decorative; the sentence beside it is what is read.
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

  // Unpinning unmounts the card that owns the focused button. Without a
  // handover, focus falls to <body> — which with the cap gone can be a very
  // long way back up the document.
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

  // Latched `expanded` used to survive the toggle unmounting, so re-crossing
  // the threshold silently re-expanded the section.
  it('does not stay expanded once the count falls back to the collapsed size', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>{children}</MemoryRouter>
      </QueryClientProvider>
    );
    queryClient.setQueryData(['pages', 'pinned'], manyPinsResponse(30));

    render(<PinnedArticlesSection />, { wrapper });
    await screen.findByTestId('pinned-articles-section');
    fireEvent.click(screen.getByTestId('pinned-expand-toggle'));
    await waitFor(() => expect(screen.getByTestId('pinned-card-pin-30')).toBeInTheDocument());

    // The list drops below the cut-off; the toggle goes with it, and the
    // section must not remain latched open behind it.
    await act(async () => {
      queryClient.setQueryData(['pages', 'pinned'], manyPinsResponse(COLLAPSED_PIN_COUNT));
    });

    await waitFor(() => {
      expect(screen.queryByTestId('pinned-expand-toggle')).not.toBeInTheDocument();
    });
    expect(screen.getAllByTestId(/^pinned-card-pin-/)).toHaveLength(COLLAPSED_PIN_COUNT);
  });

  it('states the total in the section heading', async () => {
    mockPins(30);

    render(<PinnedArticlesSection />, { wrapper: createWrapper() });
    await screen.findByTestId('pinned-articles-section');

    expect(screen.getByTestId('pinned-count')).toHaveTextContent('30');
  });

  it('renders every pin once expanded, however many there are', async () => {
    mockPins(100);

    render(<PinnedArticlesSection />, { wrapper: createWrapper() });
    await screen.findByTestId('pinned-articles-section');
    fireEvent.click(screen.getByTestId('pinned-expand-toggle'));

    await waitFor(() => {
      expect(screen.getByTestId('pinned-card-pin-100')).toBeInTheDocument();
    });
    expect(screen.getAllByTestId(/^pinned-card-pin-/)).toHaveLength(100);
  });

  // The boundary the toggle's render condition turns on. Tested at 8 (absent)
  // and 30 (present) before, which leaves an off-by-one free to hide the ninth
  // pin permanently.
  it('shows the toggle at exactly one pin past the collapsed count', async () => {
    mockPins(COLLAPSED_PIN_COUNT + 1);

    render(<PinnedArticlesSection />, { wrapper: createWrapper() });
    await screen.findByTestId('pinned-articles-section');

    const toggle = screen.getByTestId('pinned-expand-toggle');
    expect(toggle).toHaveTextContent('1 more');
    expect(screen.queryByTestId(`pinned-card-pin-${COLLAPSED_PIN_COUNT + 1}`)).not.toBeInTheDocument();

    fireEvent.click(toggle);
    await waitFor(() => {
      expect(screen.getByTestId(`pinned-card-pin-${COLLAPSED_PIN_COUNT + 1}`)).toBeInTheDocument();
    });
  });

  it('states the count for a screen reader, not just as a bare number', async () => {
    mockPins(30);

    render(<PinnedArticlesSection />, { wrapper: createWrapper() });
    await screen.findByTestId('pinned-articles-section');

    // The visual badge is decorative; the sentence beside it is what is read.
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

  // Unpinning unmounts the card that owns the focused button. Without a
  // handover, focus falls to <body> — which with the cap gone can be a very
  // long way back up the document.
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
