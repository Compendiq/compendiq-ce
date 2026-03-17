import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { KeyboardShortcutsModal } from './KeyboardShortcutsModal';
import { useKeyboardShortcutsStore } from '../../../stores/keyboard-shortcuts-store';

describe('KeyboardShortcutsModal', () => {
  beforeEach(() => {
    useKeyboardShortcutsStore.setState({ isOpen: false });
  });

  it('does not render content when closed', () => {
    render(<KeyboardShortcutsModal />);
    expect(screen.queryByText('Keyboard Shortcuts')).not.toBeInTheDocument();
  });

  it('renders modal content when opened via store', () => {
    useKeyboardShortcutsStore.setState({ isOpen: true });
    render(<KeyboardShortcutsModal />);
    expect(screen.getByText('Keyboard Shortcuts')).toBeInTheDocument();
  });

  it('shows all shortcut categories', () => {
    useKeyboardShortcutsStore.setState({ isOpen: true });
    render(<KeyboardShortcutsModal />);
    expect(screen.getByText('Panels')).toBeInTheDocument();
    expect(screen.getByText('Navigation')).toBeInTheDocument();
    expect(screen.getByText('Editor')).toBeInTheDocument();
  });

  it('shows key descriptions', () => {
    useKeyboardShortcutsStore.setState({ isOpen: true });
    render(<KeyboardShortcutsModal />);
    expect(screen.getByText('Toggle left sidebar')).toBeInTheDocument();
    expect(screen.getByText('Toggle right panel (article outline)')).toBeInTheDocument();
    expect(screen.getByText('Toggle both panels (zen mode)')).toBeInTheDocument();
    expect(screen.getByText('Open command palette / quick search')).toBeInTheDocument();
    expect(screen.getByText('Create new page')).toBeInTheDocument();
    expect(screen.getByText('Save current article')).toBeInTheDocument();
    expect(screen.getByText('Toggle edit / view mode')).toBeInTheDocument();
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
    expect(screen.getByText('Keyboard Shortcuts')).toBeInTheDocument();
  });
});
