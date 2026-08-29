import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render as rtlRender, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { KeyboardShortcutsModal } from './KeyboardShortcutsModal';
import { useKeyboardShortcutsStore } from '../../../stores/keyboard-shortcuts-store';

// #1402: the modal now records the "Learn power shortcuts" milestone, which is
// a `PUT /settings`. Mocked at the network boundary; everything else is real.
const apiFetchMock = vi.fn();
vi.mock('../../lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

/**
 * The modal needs a query client because the milestone write is a mutation.
 * Every existing assertion below is unchanged; only the wrapper is new.
 */
function render(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return rtlRender(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

function settingsPuts() {
  return apiFetchMock.mock.calls.filter(
    ([path, init]) =>
      path === '/settings' && (init as { method?: string } | undefined)?.method === 'PUT',
  );
}

describe('KeyboardShortcutsModal', () => {
  beforeEach(() => {
    useKeyboardShortcutsStore.setState({ isOpen: false });
    apiFetchMock.mockResolvedValue({});
  });

  afterEach(() => {
    apiFetchMock.mockReset();
  });

  it('does not render content when closed', () => {
    render(<KeyboardShortcutsModal />);
    expect(screen.queryByText('Keyboard Shortcuts')).not.toBeInTheDocument();
  });

  // #1402, milestone 4. The modal is the one surface every discovery path
  // lands on — `?`, Ctrl+/, the User Menu item and the checklist's own CTA —
  // so seeing it is what "learned the shortcuts" means.
  it('records the shortcuts milestone when it is opened', async () => {
    render(<KeyboardShortcutsModal />);
    expect(settingsPuts()).toEqual([]);

    act(() => {
      useKeyboardShortcutsStore.setState({ isOpen: true });
    });

    await waitFor(() => expect(settingsPuts()).toHaveLength(1));
    expect(JSON.parse((settingsPuts()[0]![1] as { body: string }).body)).toEqual({
      onboardingState: { shortcutsModalViewed: true },
    });
  });

  it('records nothing while the modal stays closed', async () => {
    render(<KeyboardShortcutsModal />);
    await Promise.resolve();
    expect(settingsPuts()).toEqual([]);
  });

  it('renders modal content when opened via store', () => {
    useKeyboardShortcutsStore.setState({ isOpen: true });
    render(<KeyboardShortcutsModal />);
    // The title appears in the dialog header; registry also has "Keyboard Shortcuts" labels
    expect(screen.getAllByText('Keyboard Shortcuts').length).toBeGreaterThanOrEqual(1);
  });

  it('shows all shortcut categories from the registry', () => {
    useKeyboardShortcutsStore.setState({ isOpen: true });
    render(<KeyboardShortcutsModal />);
    expect(screen.getByText('Navigation')).toBeInTheDocument();
    expect(screen.getByText('Actions')).toBeInTheDocument();
    expect(screen.getByText('Panels')).toBeInTheDocument();
    expect(screen.getByText('Editor')).toBeInTheDocument();
  });

  it('shows shortcut labels from the registry', () => {
    useKeyboardShortcutsStore.setState({ isOpen: true });
    render(<KeyboardShortcutsModal />);
    // Navigation
    expect(screen.getByText('Find')).toBeInTheDocument();
    // Actions — uses correct Alt+N from registry, not Ctrl+N
    expect(screen.getByText('New Page')).toBeInTheDocument();
    // Panels
    expect(screen.getByText('Toggle Left Sidebar')).toBeInTheDocument();
    expect(screen.getByText('Toggle Page Inspector')).toBeInTheDocument();
    expect(screen.getByText('Zen Mode')).toBeInTheDocument();
    // Editor
    expect(screen.getByText('Save page')).toBeInTheDocument();
    expect(screen.getByText('Toggle Edit Mode')).toBeInTheDocument();
  });

  it('shows footer note about disabled shortcuts in editors', () => {
    useKeyboardShortcutsStore.setState({ isOpen: true });
    render(<KeyboardShortcutsModal />);
    expect(
      screen.getByText(/Shortcuts are disabled when typing in an input/),
    ).toBeInTheDocument();
  });

  it('closes when close button is clicked', () => {
    useKeyboardShortcutsStore.setState({ isOpen: true });
    render(<KeyboardShortcutsModal />);

    const closeButton = screen.getByLabelText('Close shortcuts');
    fireEvent.click(closeButton);

    expect(useKeyboardShortcutsStore.getState().isOpen).toBe(false);
  });

  it('has accessible dialog role and title', () => {
    useKeyboardShortcutsStore.setState({ isOpen: true });
    render(<KeyboardShortcutsModal />);

    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeInTheDocument();
    // Title is rendered as an h2 heading inside the dialog
    expect(screen.getByRole('heading', { name: /Keyboard Shortcuts/ })).toBeInTheDocument();
  });


  it('renders the TipTap formatting shortcuts section', () => {
    useKeyboardShortcutsStore.setState({ isOpen: true });
    render(<KeyboardShortcutsModal />);

    expect(screen.getByText('Formatting (Editor)')).toBeInTheDocument();
    expect(screen.getByText('Active when editing a page')).toBeInTheDocument();
  });

  it('shows TipTap formatting shortcut labels', () => {
    useKeyboardShortcutsStore.setState({ isOpen: true });
    render(<KeyboardShortcutsModal />);

    expect(screen.getByText('Bold')).toBeInTheDocument();
    expect(screen.getByText('Italic')).toBeInTheDocument();
    expect(screen.getByText('Underline')).toBeInTheDocument();
    expect(screen.getByText('Undo')).toBeInTheDocument();
    expect(screen.getByText('Redo')).toBeInTheDocument();
  });

  // --- Search / filter (#1402 phase 3) -------------------------------------
  //
  // The modal lists 22 registry shortcuts across four categories plus 11
  // TipTap formatting rows in a 60vh scroller, so "rapidly narrows" needed a
  // filter rather than a scroll. Matching is a case-insensitive substring of
  // `label` only — the registry entry shape is `{id, keys, label, category}`,
  // there is no description to also match, and matching `keys` would make
  // "s" hit every ctrl+shift row.
  describe('search', () => {
    function open() {
      useKeyboardShortcutsStore.setState({ isOpen: true });
      render(<KeyboardShortcutsModal />);
      return screen.getByTestId('shortcut-search-input') as HTMLInputElement;
    }

    function type(input: HTMLInputElement, value: string) {
      fireEvent.change(input, { target: { value } });
    }

    it('starts empty, so the untouched modal lists everything', () => {
      const input = open();
      expect(input.value).toBe('');
      // Both sources are whole and every category header is present — the
      // assertions above this describe cover the rest.
      expect(screen.getByText('Find')).toBeInTheDocument();
      expect(screen.getByText('Bold')).toBeInTheDocument();
      expect(screen.queryByTestId('shortcut-search-empty')).not.toBeInTheDocument();
    });

    it('takes focus when the modal opens', () => {
      const input = open();
      expect(input).toBe(document.activeElement);
    });

    it('narrows the registry list to matching labels', () => {
      const input = open();
      type(input, 'sidebar');

      expect(screen.getByText('Toggle Left Sidebar')).toBeInTheDocument();
      expect(screen.queryByText('Find')).not.toBeInTheDocument();
      expect(screen.queryByText('New Page')).not.toBeInTheDocument();
    });

    it('matches case-insensitively', () => {
      const input = open();
      type(input, 'ZEN');
      expect(screen.getByText('Zen Mode')).toBeInTheDocument();
    });

    it('filters the TipTap formatting block too', () => {
      const input = open();
      type(input, 'list');

      // Formatting rows that match survive…
      expect(screen.getByText('Indent list')).toBeInTheDocument();
      expect(screen.getByText('Ordered list')).toBeInTheDocument();
      // …and ones that do not are gone, along with every registry row.
      expect(screen.queryByText('Bold')).not.toBeInTheDocument();
      expect(screen.queryByText('Find')).not.toBeInTheDocument();
    });

    it('drops a category header entirely when nothing under it matches', () => {
      const input = open();
      type(input, 'sidebar');

      // 'Toggle Left Sidebar' is the only match, and it lives in Panels.
      expect(screen.getByText('Panels')).toBeInTheDocument();
      expect(screen.queryByText('Navigation')).not.toBeInTheDocument();
      expect(screen.queryByText('Actions')).not.toBeInTheDocument();
      expect(screen.queryByText('Editor')).not.toBeInTheDocument();
      // The formatting block carries a sub-note; both go when it is empty.
      expect(screen.queryByText('Formatting (Editor)')).not.toBeInTheDocument();
      expect(screen.queryByText('Active when editing a page')).not.toBeInTheDocument();
    });

    it('says so, inline, when nothing matches at all', () => {
      const input = open();
      type(input, 'zzznotashortcut');

      expect(screen.getByTestId('shortcut-search-empty')).toHaveTextContent(
        'No shortcuts match "zzznotashortcut"',
      );
      // An honest one-liner, not a second EmptyState component inside a dialog.
      expect(screen.queryByTestId('empty-state-title')).not.toBeInTheDocument();
      expect(screen.queryByText('Panels')).not.toBeInTheDocument();
    });

    it('restores the full list when the query is cleared', () => {
      const input = open();
      type(input, 'sidebar');
      expect(screen.queryByText('Find')).not.toBeInTheDocument();

      type(input, '');

      expect(screen.getByText('Find')).toBeInTheDocument();
      expect(screen.getByText('Bold')).toBeInTheDocument();
      expect(screen.getByText('Navigation')).toBeInTheDocument();
      expect(screen.queryByTestId('shortcut-search-empty')).not.toBeInTheDocument();
    });

    it('a whitespace-only query is not a filter', () => {
      const input = open();
      type(input, '   ');
      expect(screen.getByText('Find')).toBeInTheDocument();
      expect(screen.getByText('Bold')).toBeInTheDocument();
    });

    it('keeps the footer note visible while filtering', () => {
      const input = open();
      type(input, 'zzznotashortcut');
      expect(
        screen.getByText(/Shortcuts are disabled when typing in an input/),
      ).toBeInTheDocument();
    });

    it('forgets the previous query on reopen', () => {
      const input = open();
      type(input, 'sidebar');

      act(() => {
        useKeyboardShortcutsStore.setState({ isOpen: false });
      });
      act(() => {
        useKeyboardShortcutsStore.setState({ isOpen: true });
      });

      expect((screen.getByTestId('shortcut-search-input') as HTMLInputElement).value).toBe('');
      expect(screen.getByText('Find')).toBeInTheDocument();
    });
  });
});
