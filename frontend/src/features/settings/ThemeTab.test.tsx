import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ThemeTab } from './ThemeTab';
import { useThemeStore } from '../../stores/theme-store';
import { useUiStore } from '../../stores/ui-store';

// ThemeTab is a pure, self-contained panel: it reads/writes the Zustand theme
// store and calls the `onSave` prop with `{ theme: id }` when a card is
// clicked. It needs no router, query client, or fetch — so we render it
// directly and pass an onSave spy.

describe('ThemeTab', () => {
  let onSave: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    useThemeStore.setState({ theme: 'graphite' });
    useUiStore.setState({ vimModeEnabled: false });
    onSave = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders a section for each theme category', () => {
    render(<ThemeTab onSave={onSave} />);

    expect(screen.getByTestId('theme-category-dark')).toBeInTheDocument();
    expect(screen.getByTestId('theme-category-light')).toBeInTheDocument();
  });

  it('renders the category header labels', () => {
    render(<ThemeTab onSave={onSave} />);

    expect(screen.getByText('Dark')).toBeInTheDocument();
    expect(screen.getByText('Light')).toBeInTheDocument();
  });

  it('renders every theme option across categories', () => {
    render(<ThemeTab onSave={onSave} />);

    expect(screen.getByTestId('theme-graphite')).toBeInTheDocument();
    expect(screen.getByTestId('theme-paper')).toBeInTheDocument();
  });

  it('displays theme labels and descriptions', () => {
    render(<ThemeTab onSave={onSave} />);

    expect(screen.getByText('Graphite')).toBeInTheDocument();
    expect(screen.getByText('Paper')).toBeInTheDocument();
    expect(
      screen.getByText('Neutral graphite surfaces with one teal accent'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Neutral paper surfaces with one teal accent'),
    ).toBeInTheDocument();
  });

  it('marks the current theme active with a badge and aria-pressed', () => {
    render(<ThemeTab onSave={onSave} />);

    const activeBadge = screen.getByTestId('theme-active-badge');
    expect(activeBadge).toBeInTheDocument();
    expect(activeBadge).toHaveTextContent('Active');

    const activeCard = screen.getByTestId('theme-graphite');
    expect(activeCard).toHaveAttribute('aria-pressed', 'true');
    expect(
      activeCard.querySelector('[data-testid="theme-active-badge"]'),
    ).toBeInTheDocument();
  });

  it('updates the theme store when a different theme card is clicked', () => {
    render(<ThemeTab onSave={onSave} />);

    fireEvent.click(screen.getByTestId('theme-paper'));

    expect(useThemeStore.getState().theme).toBe('paper');
  });

  it('calls onSave with the selected theme id', () => {
    render(<ThemeTab onSave={onSave} />);

    fireEvent.click(screen.getByTestId('theme-paper'));

    expect(onSave).toHaveBeenCalledWith({ theme: 'paper' });
  });

  it('moves the active badge to the newly selected theme', () => {
    render(<ThemeTab onSave={onSave} />);

    fireEvent.click(screen.getByTestId('theme-paper'));

    const selectedCard = screen.getByTestId('theme-paper');
    expect(selectedCard).toHaveAttribute('aria-pressed', 'true');
    expect(
      selectedCard.querySelector('[data-testid="theme-active-badge"]'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('theme-graphite')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  // Vim mode moved here from a permanent slot in the editor toolbar (#1270-ish
  // — see EditorToolbar.tsx, ui-store.ts's vimModeEnabled): a personal
  // preference, reached once, not a control every document loaded with.
  describe('vim mode toggle', () => {
    it('renders unchecked by default', () => {
      render(<ThemeTab onSave={onSave} />);
      expect(screen.getByTestId('vim-mode-toggle')).toHaveAttribute('data-state', 'unchecked');
    });

    it('reflects an already-enabled preference', () => {
      useUiStore.setState({ vimModeEnabled: true });
      render(<ThemeTab onSave={onSave} />);
      expect(screen.getByTestId('vim-mode-toggle')).toHaveAttribute('data-state', 'checked');
    });

    it('toggles the shared ui-store preference, not local component state', () => {
      render(<ThemeTab onSave={onSave} />);
      fireEvent.click(screen.getByTestId('vim-mode-toggle'));
      expect(useUiStore.getState().vimModeEnabled).toBe(true);
      fireEvent.click(screen.getByTestId('vim-mode-toggle'));
      expect(useUiStore.getState().vimModeEnabled).toBe(false);
    });

    it('does not call onSave — this is a live preference, not a form field pending a save action', () => {
      render(<ThemeTab onSave={onSave} />);
      fireEvent.click(screen.getByTestId('vim-mode-toggle'));
      expect(onSave).not.toHaveBeenCalled();
    });
  });
});
