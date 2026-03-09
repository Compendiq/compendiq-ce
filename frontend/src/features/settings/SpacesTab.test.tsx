import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { SpacesTab } from './SpacesTab';

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

describe('SpacesTab', () => {
  const mockOnSave = vi.fn();

  beforeEach(() => {
    mockOnSave.mockClear();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify([]), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the spaces tab with description', () => {
    render(<SpacesTab onSave={mockOnSave} />, { wrapper: createWrapper() });
    expect(screen.getByText(/Select which Confluence spaces/)).toBeInTheDocument();
  });

  it('shows "Fetch Spaces" button', () => {
    render(<SpacesTab onSave={mockOnSave} />, { wrapper: createWrapper() });
    expect(screen.getByText('Fetch Spaces')).toBeInTheDocument();
  });

  it('shows empty state when no spaces are loaded', () => {
    render(<SpacesTab onSave={mockOnSave} />, { wrapper: createWrapper() });
    expect(screen.getByText(/Click "Fetch Spaces"/)).toBeInTheDocument();
  });

  it('shows space list when synced spaces are available', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify([
          { key: 'DEV', name: 'Development', lastSynced: '2026-03-01T00:00:00Z', pageCount: 42 },
          { key: 'DOCS', name: 'Documentation', lastSynced: '2026-03-02T00:00:00Z', pageCount: 15 },
        ]),
        { headers: { 'Content-Type': 'application/json' } },
      ),
    );

    render(<SpacesTab onSave={mockOnSave} />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText('Development')).toBeInTheDocument();
      expect(screen.getByText('Documentation')).toBeInTheDocument();
    });
  });

  it('toggles space selection on click', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify([
          { key: 'DEV', name: 'Development', lastSynced: '2026-03-01T00:00:00Z', pageCount: 42 },
        ]),
        { headers: { 'Content-Type': 'application/json' } },
      ),
    );

    render(<SpacesTab onSave={mockOnSave} />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText('Development')).toBeInTheDocument();
    });

    // Click to select
    fireEvent.click(screen.getByText('Development'));

    // Save button should show count
    expect(screen.getByText('Save Selection (1)')).toBeInTheDocument();
  });

  it('calls onSave with selected spaces', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify([
          { key: 'DEV', name: 'Development', lastSynced: '2026-03-01T00:00:00Z', pageCount: 42 },
        ]),
        { headers: { 'Content-Type': 'application/json' } },
      ),
    );

    render(<SpacesTab onSave={mockOnSave} />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText('Development')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Development'));
    fireEvent.click(screen.getByText('Save Selection (1)'));

    expect(mockOnSave).toHaveBeenCalledWith({ selectedSpaces: ['DEV'] });
  });

  it('shows save button with zero count when nothing selected', () => {
    render(<SpacesTab onSave={mockOnSave} />, { wrapper: createWrapper() });
    const saveBtn = screen.getByText('Save Selection (0)');
    expect(saveBtn).toBeInTheDocument();
    expect(saveBtn).toBeDisabled();
  });

  it('initializes with previously selected spaces', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify([
          { key: 'DEV', name: 'Development', lastSynced: '2026-03-01T00:00:00Z', pageCount: 42 },
        ]),
        { headers: { 'Content-Type': 'application/json' } },
      ),
    );

    render(
      <SpacesTab selectedSpaces={['DEV']} onSave={mockOnSave} />,
      { wrapper: createWrapper() },
    );

    await waitFor(() => {
      expect(screen.getByText('Save Selection (1)')).toBeInTheDocument();
    });
  });

  it('shows page count and sync date', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify([
          { key: 'DEV', name: 'Development', lastSynced: '2026-03-01T00:00:00Z', pageCount: 42 },
        ]),
        { headers: { 'Content-Type': 'application/json' } },
      ),
    );

    render(<SpacesTab onSave={mockOnSave} />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText('42 pages')).toBeInTheDocument();
    });
  });

  it('shows Sync Selected button', () => {
    render(<SpacesTab onSave={mockOnSave} />, { wrapper: createWrapper() });
    expect(screen.getByText('Sync Selected')).toBeInTheDocument();
  });

  describe('showSpaceHomeContent toggle', () => {
    it('renders the toggle', () => {
      render(
        <SpacesTab showSpaceHomeContent={true} onSave={mockOnSave} />,
        { wrapper: createWrapper() },
      );
      expect(screen.getByText('Show space home content')).toBeInTheDocument();
      expect(screen.getByTestId('toggle-space-home-content')).toBeInTheDocument();
    });

    it('toggle is checked when showSpaceHomeContent is true', () => {
      render(
        <SpacesTab showSpaceHomeContent={true} onSave={mockOnSave} />,
        { wrapper: createWrapper() },
      );
      expect(screen.getByTestId('toggle-space-home-content')).toHaveAttribute('aria-checked', 'true');
    });

    it('toggle is unchecked when showSpaceHomeContent is false', () => {
      render(
        <SpacesTab showSpaceHomeContent={false} onSave={mockOnSave} />,
        { wrapper: createWrapper() },
      );
      expect(screen.getByTestId('toggle-space-home-content')).toHaveAttribute('aria-checked', 'false');
    });

    it('calls onSave with toggled value when clicked', () => {
      render(
        <SpacesTab showSpaceHomeContent={true} onSave={mockOnSave} />,
        { wrapper: createWrapper() },
      );
      fireEvent.click(screen.getByTestId('toggle-space-home-content'));
      expect(mockOnSave).toHaveBeenCalledWith({ showSpaceHomeContent: false });
    });

    it('calls onSave with true when toggling from off to on', () => {
      render(
        <SpacesTab showSpaceHomeContent={false} onSave={mockOnSave} />,
        { wrapper: createWrapper() },
      );
      fireEvent.click(screen.getByTestId('toggle-space-home-content'));
      expect(mockOnSave).toHaveBeenCalledWith({ showSpaceHomeContent: true });
    });
  });
});
