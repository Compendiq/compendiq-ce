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
});
