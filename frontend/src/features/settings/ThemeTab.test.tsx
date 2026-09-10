import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ThemeTab } from './ThemeTab';
import { DEFAULT_FONT_FAMILY, DEFAULT_FONT_SCOPE, useThemeStore } from '../../stores/theme-store';
import { useUiStore } from '../../stores/ui-store';

// ThemeTab is a pure, self-contained panel: it reads/writes the Zustand theme
// store and calls the `onSave` prop with `{ theme: id }` when a card is
// clicked. It needs no router, query client, or fetch — so we render it
// directly and pass an onSave spy.

describe('ThemeTab', () => {
  let onSave: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    useThemeStore.setState({
      theme: 'graphite',
      fontFamily: DEFAULT_FONT_FAMILY,
      fontScope: DEFAULT_FONT_SCOPE,
      dyslexiaSpacing: false,
    });
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
      screen.getByText('Neutral graphite surfaces with one Steel accent'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Warm paper surfaces with one Steel accent'),
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

  describe('typography preferences', () => {
    it('renders all font choices with readable previews', () => {
      render(<ThemeTab onSave={onSave} />);

      expect(screen.getByTestId('font-inter')).toBeInTheDocument();
      expect(screen.getByTestId('font-opendyslexic-alta')).toBeInTheDocument();
      expect(screen.getByTestId('font-atkinson')).toBeInTheDocument();
      expect(screen.getByTestId('font-system')).toBeInTheDocument();
      expect(screen.getByTestId('font-serif')).toBeInTheDocument();
      expect(screen.getAllByText('Aa Gg 0 O 1 l I')).toHaveLength(5);
    });

    it('changes the font family without submitting a server settings update', () => {
      render(<ThemeTab onSave={onSave} />);

      fireEvent.click(screen.getByTestId('font-atkinson'));

      expect(useThemeStore.getState().fontFamily).toBe('atkinson');
      expect(document.documentElement.dataset.font).toBe('atkinson');
      expect(onSave).not.toHaveBeenCalled();
    });

    it('supports application and reading-pane scope', () => {
      render(<ThemeTab onSave={onSave} />);

      const application = screen.getByTestId('font-scope-application');
      const readingPane = screen.getByTestId('font-scope-reading-pane');
      expect(application).toHaveAttribute('aria-checked', 'true');

      fireEvent.click(readingPane);

      expect(useThemeStore.getState().fontScope).toBe('reading-pane');
      expect(readingPane).toHaveAttribute('aria-checked', 'true');
      expect(application).toHaveAttribute('aria-checked', 'false');
    });

    it('toggles enhanced reading spacing and wires its help text to the control', () => {
      render(<ThemeTab onSave={onSave} />);

      const toggle = screen.getByTestId('dyslexia-spacing-toggle');
      expect(toggle).toHaveAttribute('data-state', 'unchecked');
      expect(toggle).toHaveAttribute('aria-describedby', 'dyslexia-spacing-help');

      fireEvent.click(toggle);

      expect(useThemeStore.getState().dyslexiaSpacing).toBe(true);
      expect(toggle).toHaveAttribute('data-state', 'checked');
    });
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

});
