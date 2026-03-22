import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { KeyboardShortcutsModal } from './KeyboardShortcutsModal';
import { useKeyboardShortcutsStore } from '../../../stores/keyboard-shortcuts-store';
import { useUiStore } from '../../../stores/ui-store';

describe('KeyboardShortcutsModal', () => {
  beforeEach(() => {
    useKeyboardShortcutsStore.setState({ isOpen: false });
    useUiStore.setState({ singleKeyShortcutsEnabled: true });
  });

  it('does not render content when closed', () => {
    render(<KeyboardShortcutsModal />);
    expect(screen.queryByText('Keyboard Shortcuts')).not.toBeInTheDocument();
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
    expect(screen.getByText('Search / Command Palette')).toBeInTheDocument();
    // Actions — uses correct Alt+N from registry, not Ctrl+N
    expect(screen.getByText('New Page')).toBeInTheDocument();
    // Panels
    expect(screen.getByText('Toggle Left Sidebar')).toBeInTheDocument();
    expect(screen.getByText('Toggle Right Panel')).toBeInTheDocument();
    expect(screen.getByText('Zen Mode')).toBeInTheDocument();
    // Editor
    expect(screen.getByText('Save article')).toBeInTheDocument();
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

  it('renders the single-key shortcuts toggle switch', () => {
    useKeyboardShortcutsStore.setState({ isOpen: true });
    render(<KeyboardShortcutsModal />);

    const toggle = screen.getByRole('switch', { name: /single-key shortcuts/i });
    expect(toggle).toBeInTheDocument();
    // Default is enabled
    expect(toggle).toHaveAttribute('data-state', 'checked');
  });

  it('toggles singleKeyShortcutsEnabled in ui-store when switch is clicked', () => {
    useKeyboardShortcutsStore.setState({ isOpen: true });
    render(<KeyboardShortcutsModal />);

    const toggle = screen.getByRole('switch', { name: /single-key shortcuts/i });
    fireEvent.click(toggle);
    expect(useUiStore.getState().singleKeyShortcutsEnabled).toBe(false);

    fireEvent.click(toggle);
    expect(useUiStore.getState().singleKeyShortcutsEnabled).toBe(true);
  });

  it('shows description text for the toggle', () => {
    useKeyboardShortcutsStore.setState({ isOpen: true });
    render(<KeyboardShortcutsModal />);

    expect(
      screen.getByText(/single key without Ctrl\/Alt/i),
    ).toBeInTheDocument();
  });

  it('renders the TipTap formatting shortcuts section', () => {
    useKeyboardShortcutsStore.setState({ isOpen: true });
    render(<KeyboardShortcutsModal />);

    expect(screen.getByText('Formatting (Editor)')).toBeInTheDocument();
    expect(screen.getByText('Active when editing an article')).toBeInTheDocument();
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
