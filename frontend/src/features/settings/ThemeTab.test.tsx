import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ThemeTab } from './ThemeTab';
import { useThemeStore } from '../../stores/theme-store';

// ThemeTab is a pure, self-contained panel: it reads/writes the Zustand theme
// store and calls the `onSave` prop with `{ theme: id }` when a card is
// clicked. It needs no router, query client, or fetch — so we render it
// directly and pass an onSave spy.

describe('ThemeTab', () => {
  let onSave: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    useThemeStore.setState({ theme: 'graphite-honey' });
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

    expect(screen.getByTestId('theme-graphite-honey')).toBeInTheDocument();
    expect(screen.getByTestId('theme-honey-linen')).toBeInTheDocument();
  });

  it('displays theme labels and descriptions', () => {
    render(<ThemeTab onSave={onSave} />);

    expect(screen.getByText('Graphite Honey')).toBeInTheDocument();
    expect(screen.getByText('Honey Linen')).toBeInTheDocument();
    expect(
      screen.getByText('Graphite surfaces with honey accent — neumorphic dark'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Linen cream with honey accent — neumorphic light'),
    ).toBeInTheDocument();
  });

  it('marks the current theme active with a badge and aria-pressed', () => {
    render(<ThemeTab onSave={onSave} />);

    const activeBadge = screen.getByTestId('theme-active-badge');
    expect(activeBadge).toBeInTheDocument();
    expect(activeBadge).toHaveTextContent('Active');

    const activeCard = screen.getByTestId('theme-graphite-honey');
    expect(activeCard).toHaveAttribute('aria-pressed', 'true');
    expect(
      activeCard.querySelector('[data-testid="theme-active-badge"]'),
    ).toBeInTheDocument();
  });

  it('updates the theme store when a different theme card is clicked', () => {
    render(<ThemeTab onSave={onSave} />);

    fireEvent.click(screen.getByTestId('theme-honey-linen'));

    expect(useThemeStore.getState().theme).toBe('honey-linen');
  });

  it('calls onSave with the selected theme id', () => {
    render(<ThemeTab onSave={onSave} />);

    fireEvent.click(screen.getByTestId('theme-honey-linen'));

    expect(onSave).toHaveBeenCalledWith({ theme: 'honey-linen' });
  });

  it('moves the active badge to the newly selected theme', () => {
    render(<ThemeTab onSave={onSave} />);

    fireEvent.click(screen.getByTestId('theme-honey-linen'));

    const selectedCard = screen.getByTestId('theme-honey-linen');
    expect(selectedCard).toHaveAttribute('aria-pressed', 'true');
    expect(
      selectedCard.querySelector('[data-testid="theme-active-badge"]'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('theme-graphite-honey')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });
});
