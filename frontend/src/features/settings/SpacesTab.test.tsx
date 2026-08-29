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

  it('allows saving an empty selection — Save button not disabled at zero (#721)', () => {
    render(<SpacesTab onSave={mockOnSave} />, { wrapper: createWrapper() });
    const saveBtn = screen.getByText('Save Selection (0)');
    expect(saveBtn).toBeInTheDocument();
    // #721: Save must be enabled at zero — admin may intentionally clear all spaces.
    expect(saveBtn).not.toBeDisabled();
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

  // ---------- #721: Remove action ----------

  it('shows a Remove button for each synced space (#721)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify([
          { key: 'ENG', name: 'Engineering', lastSynced: '2026-03-01T00:00:00Z', pageCount: 10 },
        ]),
        { headers: { 'Content-Type': 'application/json' } },
      ),
    );

    render(<SpacesTab onSave={mockOnSave} />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText('Engineering')).toBeInTheDocument();
    });

    expect(screen.getByRole('button', { name: /remove engineering/i })).toBeInTheDocument();
  });

  it('calls DELETE /api/spaces/:key after confirming the remove dialog (#721)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            { key: 'ENG', name: 'Engineering', lastSynced: '2026-03-01T00:00:00Z', pageCount: 5 },
          ]),
          { headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ key: 'ENG', deleted: true, pagesDeleted: 5 }), {
          headers: { 'Content-Type': 'application/json' },
        }),
      );

    render(<SpacesTab onSave={mockOnSave} />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText('Engineering')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /remove engineering/i }));

    // ConfirmDialog replaces native confirm(). The copy must reflect the backend
    // reality (DELETE /spaces/:key → unsyncSpace): the local purge is permanent
    // (pages cascade to embeddings + version history), Confluence is untouched.
    expect(await screen.findByText('Remove "Engineering" from Compendiq?')).toBeInTheDocument();
    expect(screen.getByText(/permanently deletes its synced pages/i)).toBeInTheDocument();
    expect(screen.getByText(/nothing is deleted in confluence/i)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));

    await waitFor(() => {
      const deleteCalled = fetchSpy.mock.calls.some(
        ([url, opts]) =>
          typeof url === 'string' &&
          url.includes('/spaces/ENG') &&
          (opts as RequestInit | undefined)?.method === 'DELETE',
      );
      expect(deleteCalled).toBe(true);
    });
  });

  it('does not DELETE when the remove dialog is cancelled (#721)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify([
          { key: 'ENG', name: 'Engineering', lastSynced: '2026-03-01T00:00:00Z', pageCount: 5 },
        ]),
        { headers: { 'Content-Type': 'application/json' } },
      ),
    );

    render(<SpacesTab onSave={mockOnSave} />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText('Engineering')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /remove engineering/i }));
    await screen.findByTestId('confirm-dialog');
    fireEvent.click(screen.getByTestId('confirm-dialog-cancel'));

    await waitFor(() => {
      expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument();
    });
    const deleteCalled = fetchSpy.mock.calls.some(
      ([, opts]) => (opts as RequestInit | undefined)?.method === 'DELETE',
    );
    expect(deleteCalled).toBe(false);
  });

  // ---------- #721: empty-selection save confirmation ----------

  it('asks for confirmation before saving an empty selection, then saves on confirm', async () => {
    render(<SpacesTab onSave={mockOnSave} />, { wrapper: createWrapper() });

    fireEvent.click(screen.getByText('Save Selection (0)'));

    // Dialog instead of native confirm(); copy must not claim local pages are
    // deleted (the settings handler only clears the sync selection).
    expect(await screen.findByText('Remove all spaces from your selection?')).toBeInTheDocument();
    expect(screen.getByText(/stops syncing/i)).toBeInTheDocument();
    expect(mockOnSave).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));

    await waitFor(() => {
      expect(mockOnSave).toHaveBeenCalledWith({ selectedSpaces: [] });
    });
  });

  it('does not save when the empty-selection dialog is cancelled', async () => {
    render(<SpacesTab onSave={mockOnSave} />, { wrapper: createWrapper() });

    fireEvent.click(screen.getByText('Save Selection (0)'));
    await screen.findByTestId('confirm-dialog');
    fireEvent.click(screen.getByTestId('confirm-dialog-cancel'));

    await waitFor(() => {
      expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument();
    });
    expect(mockOnSave).not.toHaveBeenCalled();
  });

  it('saves a non-empty selection without any confirmation dialog', async () => {
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

    expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument();
    expect(mockOnSave).toHaveBeenCalledWith({ selectedSpaces: ['DEV'] });
  });

  // --- Local filter over the space list (#1402 phase 3) --------------------
  //
  // `GET /spaces/available` returns every space the PAT can read, which on a
  // real Data Center instance is routinely dozens to hundreds. The list was a
  // flat unfiltered `.map()`, so selecting three known spaces meant scrolling
  // the whole estate. Local-only: no request, no URL state — this is a lookup
  // inside one settings panel, not a shareable view.
  describe('space filter', () => {
    function serveSpaces(spaces: Array<Record<string, unknown>>) {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify(spaces), {
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }

    const threeSpaces = [
      { key: 'DEV', name: 'Development', lastSynced: '2026-03-01T00:00:00Z', pageCount: 42 },
      { key: 'DOCS', name: 'Documentation', lastSynced: '2026-03-02T00:00:00Z', pageCount: 15 },
      { key: 'OPS', name: 'Operations', lastSynced: '2026-03-03T00:00:00Z', pageCount: 7 },
    ];

    /**
     * By ROLE and accessible name, not by test id.
     *
     * `aria-label="Filter spaces"` is this input's only accessible name — it
     * has no visible label and the placeholder does not count — so a query
     * that reaches it by `data-testid` cannot notice the label going missing.
     */
    function filterInput() {
      return screen.getByRole('textbox', { name: 'Filter spaces' });
    }

    async function renderWithSpaces() {
      serveSpaces(threeSpaces);
      render(<SpacesTab onSave={mockOnSave} />, { wrapper: createWrapper() });
      await waitFor(() => expect(screen.getByText('Development')).toBeInTheDocument());
    }

    it('offers no filter until there is a list to filter', () => {
      render(<SpacesTab onSave={mockOnSave} />, { wrapper: createWrapper() });
      expect(screen.queryByTestId('space-filter-input')).not.toBeInTheDocument();
    });

    it('narrows the list by name', async () => {
      await renderWithSpaces();

      fireEvent.change(filterInput(), { target: { value: 'documentation' } });

      expect(screen.getByText('Documentation')).toBeInTheDocument();
      expect(screen.queryByText('Development')).not.toBeInTheDocument();
      expect(screen.queryByText('Operations')).not.toBeInTheDocument();
    });

    it('narrows the list by key, which is what people actually remember', async () => {
      await renderWithSpaces();

      fireEvent.change(filterInput(), { target: { value: 'ops' } });

      expect(screen.getByText('Operations')).toBeInTheDocument();
      expect(screen.queryByText('Development')).not.toBeInTheDocument();
    });

    // Space keys are uppercase by convention, so `DEV` is the realistic
    // keystroke and a case-sensitive fold would drop every row.
    it('matches case-insensitively, against the key and the name alike', async () => {
      await renderWithSpaces();

      fireEvent.change(filterInput(), { target: { value: 'DEV' } });
      expect(screen.getByText('Development')).toBeInTheDocument();
      expect(screen.queryByText('Operations')).not.toBeInTheDocument();

      fireEvent.change(filterInput(), { target: { value: 'oPeRaTiOnS' } });
      expect(screen.getByText('Operations')).toBeInTheDocument();
      expect(screen.queryByText('Development')).not.toBeInTheDocument();
    });

    // The modal's filter covers this; without it here the two halves of one
    // ruling had unequal guard strength and `.trim()` was free to delete.
    it('a whitespace-only query is not a filter', async () => {
      await renderWithSpaces();

      fireEvent.change(filterInput(), { target: { value: '   ' } });

      expect(screen.getByText('Development')).toBeInTheDocument();
      expect(screen.getByText('Documentation')).toBeInTheDocument();
      expect(screen.getByText('Operations')).toBeInTheDocument();
      expect(screen.queryByTestId('space-filter-count')).not.toBeInTheDocument();
    });

    it('says nothing matched rather than telling the user to fetch spaces again', async () => {
      await renderWithSpaces();

      fireEvent.change(filterInput(), { target: { value: 'zzznotaspace' } });

      expect(screen.getByTestId('space-filter-empty')).toHaveTextContent(
        'No spaces match "zzznotaspace"',
      );
      // The fetch prompt is for an unfetched list; here the list exists.
      expect(screen.queryByText(/Click "Fetch Spaces"/)).not.toBeInTheDocument();
    });

    // The only other reset is a 24px icon ~70px above and out of the eye line.
    it('offers the reset inside the zero-match block', async () => {
      await renderWithSpaces();
      fireEvent.change(filterInput(), { target: { value: 'zzznotaspace' } });

      fireEvent.click(screen.getByTestId('space-filter-empty-clear'));

      expect(screen.getByText('Development')).toBeInTheDocument();
      expect(screen.queryByTestId('space-filter-empty')).not.toBeInTheDocument();
    });

    it('leaves a selection made before filtering intact', async () => {
      await renderWithSpaces();

      fireEvent.click(screen.getByText('Development'));
      fireEvent.change(filterInput(), { target: { value: 'ops' } });
      fireEvent.click(screen.getByText('Operations'));

      // Filtering hides rows; it does not deselect them.
      expect(screen.getByText('Save Selection (2)')).toBeInTheDocument();
      fireEvent.click(screen.getByText('Save Selection (2)'));
      expect(mockOnSave).toHaveBeenCalledWith({ selectedSpaces: ['DEV', 'OPS'] });
    });

    // Cleared by CLICKING the button, not by a synthetic change event — the
    // whole control could be deleted and this test stayed green before.
    it('restores the full list when the filter is cleared', async () => {
      await renderWithSpaces();

      expect(screen.queryByTestId('space-filter-clear')).not.toBeInTheDocument();
      fireEvent.change(filterInput(), { target: { value: 'ops' } });
      expect(screen.queryByText('Development')).not.toBeInTheDocument();

      fireEvent.click(screen.getByTestId('space-filter-clear'));

      expect((filterInput() as HTMLInputElement).value).toBe('');
      expect(screen.getByText('Development')).toBeInTheDocument();
      expect(screen.getByText('Documentation')).toBeInTheDocument();
      expect(screen.getByText('Operations')).toBeInTheDocument();
      expect(screen.queryByTestId('space-filter-clear')).not.toBeInTheDocument();
    });

    /**
     * The filter hides rows without deselecting them, which is correct and was
     * silent: `Save Selection (2)` could sit under one visible row with
     * nothing accounting for the difference. Announced once, by an always-
     * mounted region — the same rule the Library's `filters-live-announcer`
     * follows, and the reason neither the visible strip nor the zero-match
     * block carries a role of its own.
     */
    describe('the count of what is hidden', () => {
      it('mounts the live region silent, before anything is typed', async () => {
        await renderWithSpaces();

        const announcer = screen.getByTestId('space-filter-announcer');
        expect(announcer).toHaveAttribute('role', 'status');
        expect(announcer).toHaveAttribute('aria-live', 'polite');
        expect(announcer).toHaveTextContent('');
        // Nothing is hidden, so there is nothing to report on screen either.
        expect(screen.queryByTestId('space-filter-count')).not.toBeInTheDocument();
      });

      it('shows and announces how many of the list survived the filter', async () => {
        await renderWithSpaces();

        fireEvent.change(filterInput(), { target: { value: 'ops' } });

        expect(screen.getByTestId('space-filter-count')).toHaveTextContent(
          'Showing 1 of 3 spaces',
        );
        expect(screen.getByTestId('space-filter-announcer')).toHaveTextContent(
          'Showing 1 of 3 spaces',
        );
      });

      it('counts zero rather than going quiet when nothing matches', async () => {
        await renderWithSpaces();

        fireEvent.change(filterInput(), { target: { value: 'zzznotaspace' } });

        expect(screen.getByTestId('space-filter-count')).toHaveTextContent(
          'Showing 0 of 3 spaces',
        );
        // Announced once: the zero-match block itself is decoration.
        expect(screen.getByTestId('space-filter-empty')).not.toHaveAttribute('role', 'status');
      });

      it('stops counting once the filter is cleared', async () => {
        await renderWithSpaces();
        fireEvent.change(filterInput(), { target: { value: 'ops' } });

        fireEvent.click(screen.getByTestId('space-filter-clear'));

        expect(screen.queryByTestId('space-filter-count')).not.toBeInTheDocument();
        expect(screen.getByTestId('space-filter-announcer')).toHaveTextContent('');
      });
    });
  });
});
