import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LazyMotion, domMax } from 'framer-motion';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CommandPalette } from './CommandPalette';
import { useCommandPaletteStore } from '../../stores/command-palette-store';

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

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

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
      new Response(
        JSON.stringify({
          items: [
            { id: '1', title: 'Test Page', spaceKey: 'TST' },
          ],
        }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
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
