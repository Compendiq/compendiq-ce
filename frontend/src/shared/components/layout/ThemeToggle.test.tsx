import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ThemeToggle } from './ThemeToggle';
import { useThemeStore } from '../../../stores/theme-store';

/**
 * The control is a named three-way *preference* menu (System / Light / Dark),
 * not a two-way palette toggle and not a cycle. `system` must stay reachable
 * after the user has picked a palette, or the shipped default becomes a
 * one-way door on first click.
 */
async function openMenu() {
  const trigger = screen.getByTestId('theme-toggle');
  fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' });
  await vi.waitFor(() => {
    expect(screen.getByTestId('theme-option-system')).toBeInTheDocument();
  });
}

describe('ThemeToggle', () => {
  beforeEach(() => {
    useThemeStore.setState({ preference: 'system', theme: 'graphite' });
  });

  it('renders a button named for the current preference', () => {
    render(<ThemeToggle />);
    const btn = screen.getByRole('button', { name: 'Theme: System' });
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveAttribute('data-testid', 'theme-toggle');
  });

  it('offers System, Light, and Dark as named choices', async () => {
    render(<ThemeToggle />);
    await openMenu();
    expect(screen.getByTestId('theme-option-system')).toHaveTextContent('System');
    expect(screen.getByTestId('theme-option-light')).toHaveTextContent('Light');
    expect(screen.getByTestId('theme-option-dark')).toHaveTextContent('Dark');
  });

  it('sets an explicit preference from the menu', async () => {
    render(<ThemeToggle />);
    await openMenu();
    fireEvent.click(screen.getByTestId('theme-option-light'));
    expect(useThemeStore.getState().preference).toBe('light');
    expect(useThemeStore.getState().theme).toBe('paper');
  });

  it('can return to system after an explicit choice', async () => {
    useThemeStore.setState({ preference: 'dark', theme: 'graphite' });
    render(<ThemeToggle />);
    expect(screen.getByRole('button', { name: 'Theme: Dark' })).toBeInTheDocument();
    await openMenu();
    fireEvent.click(screen.getByTestId('theme-option-system'));
    expect(useThemeStore.getState().preference).toBe('system');
  });
});
