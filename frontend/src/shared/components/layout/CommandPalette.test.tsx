import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LazyMotion, domAnimation } from 'framer-motion';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CommandPalette } from './CommandPalette';
import { useCommandPaletteStore } from '../../../stores/command-palette-store';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <LazyMotion features={domAnimation}>
            {children}
          </LazyMotion>
        </MemoryRouter>
      </QueryClientProvider>
    );
  };
}

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('CommandPalette', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    localStorage.clear();
    // Mock fetch for search
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ items: [] }), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Reset store
    useCommandPaletteStore.getState().close();
  });

  it('does not render when closed', () => {
    const { unmount } = render(<CommandPalette />, { wrapper: createWrapper() });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    unmount();
  });

  it('renders when opened', async () => {
    useCommandPaletteStore.getState().open();
    const { unmount } = render(<CommandPalette />, { wrapper: createWrapper() });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    unmount();
  });

  it('shows quick actions', async () => {
    useCommandPaletteStore.getState().open();
    const { unmount } = render(<CommandPalette />, { wrapper: createWrapper() });
    expect(screen.getByText('New Page')).toBeInTheDocument();
    expect(screen.getByText('Settings')).toBeInTheDocument();
    expect(screen.getByText('AI Assistant')).toBeInTheDocument();
    expect(screen.getByText('Sync Pages')).toBeInTheDocument();
    unmount();
  });

  it('closes on Escape key', async () => {
    useCommandPaletteStore.getState().open();
    const { unmount } = render(<CommandPalette />, { wrapper: createWrapper() });

    const input = screen.getByLabelText('Search');
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(useCommandPaletteStore.getState().isOpen).toBe(false);
    unmount();
  });

  it('closes on backdrop click', async () => {
    useCommandPaletteStore.getState().open();
    const { unmount } = render(<CommandPalette />, { wrapper: createWrapper() });

    const backdrop = screen.getByTestId('command-palette-backdrop');
    fireEvent.click(backdrop);

    expect(useCommandPaletteStore.getState().isOpen).toBe(false);
    unmount();
  });

  it('has a search input', async () => {
    useCommandPaletteStore.getState().open();
    const { unmount } = render(<CommandPalette />, { wrapper: createWrapper() });
    expect(screen.getByLabelText('Search')).toBeInTheDocument();
    unmount();
  });

  it('searches pages on input with debounce', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        items: [
          { id: '1', title: 'Test Page', spaceKey: 'TST' },
        ],
      }),
    );

    useCommandPaletteStore.getState().open();
    const { unmount } = render(<CommandPalette />, { wrapper: createWrapper() });

    const input = screen.getByLabelText('Search');
    fireEvent.change(input, { target: { value: 'test' } });

    // Wait for debounce + fetch
    await waitFor(
      () => {
        expect(screen.getByText('Test Page')).toBeInTheDocument();
      },
      { timeout: 2000 },
    );
    unmount();
  });

  it('ignores stale search responses that resolve after the latest query', async () => {
    const oldSearch = deferred<Response>();
    const newSearch = deferred<Response>();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url.includes('search=old')) return oldSearch.promise;
      if (url.includes('search=new')) return newSearch.promise;
      return Promise.resolve(jsonResponse({ items: [] }));
    });

    useCommandPaletteStore.getState().open();
    const { unmount } = render(<CommandPalette />, { wrapper: createWrapper() });

    const input = screen.getByLabelText('Search');
    fireEvent.change(input, { target: { value: 'old' } });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/api/pages?search=old&limit=8'),
        expect.any(Object),
      );
    });

    fireEvent.change(input, { target: { value: 'new' } });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/api/pages?search=new&limit=8'),
        expect.any(Object),
      );
    });

    await act(async () => {
      newSearch.resolve(jsonResponse({
        items: [{ id: 'new-page', title: 'Latest Result', spaceKey: 'NEW' }],
      }));
      await newSearch.promise;
    });

    expect(await screen.findByText('Latest Result')).toBeInTheDocument();

    await act(async () => {
      oldSearch.resolve(jsonResponse({
        items: [{ id: 'old-page', title: 'Stale Result', spaceKey: 'OLD' }],
      }));
      await oldSearch.promise;
    });

    await waitFor(() => {
      expect(screen.getByText('Latest Result')).toBeInTheDocument();
      expect(screen.queryByText('Stale Result')).not.toBeInTheDocument();
    });

    unmount();
  });

  it('shows "No pages found" when search returns empty', async () => {
    useCommandPaletteStore.getState().open();
    const { unmount } = render(<CommandPalette />, { wrapper: createWrapper() });

    const input = screen.getByLabelText('Search');
    fireEvent.change(input, { target: { value: 'nonexistent' } });

    await waitFor(
      () => {
        expect(screen.getByText('No pages found')).toBeInTheDocument();
      },
      { timeout: 2000 },
    );
    unmount();
  });

  it('navigates to quick action on click', async () => {
    useCommandPaletteStore.getState().open();
    const { unmount } = render(<CommandPalette />, { wrapper: createWrapper() });

    fireEvent.click(screen.getByText('Settings'));
    expect(mockNavigate).toHaveBeenCalledWith('/settings');
    unmount();
  });

  it('supports keyboard navigation with arrow keys', async () => {
    useCommandPaletteStore.getState().open();
    const { unmount } = render(<CommandPalette />, { wrapper: createWrapper() });

    const input = screen.getByLabelText('Search');

    // Arrow down should highlight next item
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });

    // Arrow up should go back
    fireEvent.keyDown(input, { key: 'ArrowUp' });

    // Enter should select current item
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(mockNavigate).toHaveBeenCalled();
    unmount();
  });

  it('exposes the active option to assistive tech via combobox + aria-activedescendant', async () => {
    useCommandPaletteStore.getState().open();
    const { unmount } = render(<CommandPalette />, { wrapper: createWrapper() });

    // The search input must be an ARIA combobox that owns the results listbox.
    const input = screen.getByRole('combobox');
    expect(input).toHaveAttribute('aria-controls', 'cmdk-listbox');
    expect(screen.getByRole('listbox')).toBeInTheDocument();

    // Move the highlight down twice; the input must point at the highlighted option.
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });

    const activeId = input.getAttribute('aria-activedescendant');
    expect(activeId).toBeTruthy();
    const activeOption = document.getElementById(activeId!);
    expect(activeOption).not.toBeNull();
    expect(activeOption).toHaveAttribute('role', 'option');
    expect(activeOption).toHaveAttribute('aria-selected', 'true');

    // Exactly one option is selected, and it is the active descendant.
    const selected = screen
      .getAllByRole('option')
      .filter((o) => o.getAttribute('aria-selected') === 'true');
    expect(selected).toHaveLength(1);
    expect(selected[0]).toBe(activeOption);
    unmount();
  });

  it('closes on Escape when focus is on a result option, not just the input', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ items: [{ id: '1', title: 'Test Page', spaceKey: 'TST' }] }),
    );

    useCommandPaletteStore.getState().open();
    const { unmount } = render(<CommandPalette />, { wrapper: createWrapper() });

    const input = screen.getByLabelText('Search');
    fireEvent.change(input, { target: { value: 'test' } });

    const resultLabel = await screen.findByText('Test Page');
    const resultButton = resultLabel.closest('button');
    expect(resultButton).not.toBeNull();

    // Escape while a result option holds focus must still dismiss the palette.
    fireEvent.keyDown(resultButton!, { key: 'Escape' });

    expect(useCommandPaletteStore.getState().isOpen).toBe(false);
    unmount();
  });

  it('restores focus to the previously focused element after closing', async () => {
    const { unmount } = render(
      <div>
        <button data-testid="palette-opener">Open</button>
        <CommandPalette />
      </div>,
      { wrapper: createWrapper() },
    );

    const opener = screen.getByTestId('palette-opener');
    opener.focus();
    expect(document.activeElement).toBe(opener);

    act(() => {
      useCommandPaletteStore.getState().open();
    });
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    // Focus moves into the palette while it is open.
    const input = screen.getByLabelText('Search');
    input.focus();
    expect(document.activeElement).toBe(input);

    // Closing must return focus to whatever was focused before it opened.
    act(() => {
      useCommandPaletteStore.getState().close();
    });

    await waitFor(() => {
      expect(document.activeElement).toBe(opener);
    });
    unmount();
  });

  it('shows recent searches from localStorage', async () => {
    localStorage.setItem('kb-recent-searches', JSON.stringify(['previous search']));

    useCommandPaletteStore.getState().open();
    const { unmount } = render(<CommandPalette />, { wrapper: createWrapper() });

    expect(screen.getByText('previous search')).toBeInTheDocument();
    expect(screen.getByText('Recent Searches')).toBeInTheDocument();
    unmount();
  });

  it('shows keyboard hints in footer', async () => {
    useCommandPaletteStore.getState().open();
    const { unmount } = render(<CommandPalette />, { wrapper: createWrapper() });

    expect(screen.getByText('Navigate')).toBeInTheDocument();
    expect(screen.getByText('Select')).toBeInTheDocument();
    expect(screen.getByText('Close')).toBeInTheDocument();
    unmount();
  });

  it('shows /ai hint in footer when not in AI mode', () => {
    useCommandPaletteStore.getState().open();
    const { unmount } = render(<CommandPalette />, { wrapper: createWrapper() });

    expect(screen.getByText('AI mode')).toBeInTheDocument();
    unmount();
  });

  describe('AI mode', () => {
    it('activates AI mode when query starts with /ai', () => {
      useCommandPaletteStore.getState().open();
      const { unmount } = render(<CommandPalette />, { wrapper: createWrapper() });

      const input = screen.getByLabelText('Search');
      fireEvent.change(input, { target: { value: '/ai' } });

      // The AI mode section header should be present
      expect(screen.getByTestId('ai-mode-ask-button')).toBeInTheDocument();
      unmount();
    });

    it('shows "Ask AI" as prominent result in AI mode', () => {
      useCommandPaletteStore.getState().open();
      const { unmount } = render(<CommandPalette />, { wrapper: createWrapper() });

      const input = screen.getByLabelText('Search');
      fireEvent.change(input, { target: { value: '/ai' } });

      expect(screen.getByText('Ask AI')).toBeInTheDocument();
      unmount();
    });

    it('shows query text in AI result when provided', () => {
      useCommandPaletteStore.getState().open();
      const { unmount } = render(<CommandPalette />, { wrapper: createWrapper() });

      const input = screen.getByLabelText('Search');
      fireEvent.change(input, { target: { value: '/ai how to configure auth' } });

      expect(screen.getByText('Ask AI: how to configure auth')).toBeInTheDocument();
      unmount();
    });

    it('hides quick actions in AI mode', () => {
      useCommandPaletteStore.getState().open();
      const { unmount } = render(<CommandPalette />, { wrapper: createWrapper() });

      const input = screen.getByLabelText('Search');
      fireEvent.change(input, { target: { value: '/ai test' } });

      expect(screen.queryByText('Quick Actions')).not.toBeInTheDocument();
      expect(screen.queryByText('New Page')).not.toBeInTheDocument();
      unmount();
    });

    it('navigates to /ai when Ask AI is selected', () => {
      useCommandPaletteStore.getState().open();
      const { unmount } = render(<CommandPalette />, { wrapper: createWrapper() });

      const input = screen.getByLabelText('Search');
      fireEvent.change(input, { target: { value: '/ai' } });

      // Press Enter to select
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(mockNavigate).toHaveBeenCalledWith('/ai');
      unmount();
    });

    it('carries the typed question through as a q param (#957)', () => {
      useCommandPaletteStore.getState().open();
      const { unmount } = render(<CommandPalette />, { wrapper: createWrapper() });

      const input = screen.getByLabelText('Search');
      fireEvent.change(input, { target: { value: '/ai how do I configure sync intervals' } });

      // Press Enter to select — the typed question must not be dropped.
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(mockNavigate).toHaveBeenCalledWith(
        `/ai?q=${encodeURIComponent('how do I configure sync intervals')}`,
      );
      unmount();
    });

    it('hides /ai hint in footer when in AI mode', () => {
      useCommandPaletteStore.getState().open();
      const { unmount } = render(<CommandPalette />, { wrapper: createWrapper() });

      const input = screen.getByLabelText('Search');
      fireEvent.change(input, { target: { value: '/ai' } });

      expect(screen.queryByText('AI mode')).not.toBeInTheDocument();
      unmount();
    });

    it('does not show "No pages found" in AI mode', async () => {
      useCommandPaletteStore.getState().open();
      const { unmount } = render(<CommandPalette />, { wrapper: createWrapper() });

      const input = screen.getByLabelText('Search');
      fireEvent.change(input, { target: { value: '/ai some query' } });

      // Wait a bit for any async operations
      await waitFor(() => {
        expect(screen.queryByText('No pages found')).not.toBeInTheDocument();
      });
      unmount();
    });

    it('changes placeholder text in AI mode', () => {
      useCommandPaletteStore.getState().open();
      const { unmount } = render(<CommandPalette />, { wrapper: createWrapper() });

      const input = screen.getByLabelText('Search');

      // Before AI mode
      expect(input).toHaveAttribute('placeholder', 'Search pages or type a command...');

      // Enter AI mode
      fireEvent.change(input, { target: { value: '/ai' } });
      expect(input).toHaveAttribute('placeholder', 'Ask AI anything...');

      unmount();
    });
  });
});
