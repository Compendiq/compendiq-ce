import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ThemeToggle } from './ThemeToggle';
import { useThemeStore } from '../../../stores/theme-store';

/**
 * The control cycles a three-way PREFERENCE (system → light → dark), not a
 * two-way palette toggle. The distinction is the point of these tests: with a
 * two-state toggle there is no way back to "follow my OS" once the user has
 * touched it, which would turn the shipped default into a one-way door on
 * first click.
 */
describe('ThemeToggle', () => {
  beforeEach(() => {
    useThemeStore.setState({ preference: 'system', theme: 'graphite' });
  });

  it('renders a button with an accessible label', () => {
    render(<ThemeToggle />);
    const btn = screen.getByRole('button');
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveAttribute('aria-label');
  });

  it('cycles system → light → dark → system', () => {
    render(<ThemeToggle />);
    const btn = screen.getByRole('button');

    fireEvent.click(btn);
    expect(useThemeStore.getState().preference).toBe('light');
    expect(useThemeStore.getState().theme).toBe('paper');

    fireEvent.click(btn);
    expect(useThemeStore.getState().preference).toBe('dark');
    expect(useThemeStore.getState().theme).toBe('graphite');

    // The rung that a two-state toggle cannot reach.
    fireEvent.click(btn);
    expect(useThemeStore.getState().preference).toBe('system');
  });

  // The icon and label report the PREFERENCE, so the control never claims the
  // user chose dark when the OS did.
  it('announces the current preference and the next one', () => {
    render(<ThemeToggle />);
    expect(screen.getByRole('button').getAttribute('aria-label')).toMatch(/match system/i);

    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('button').getAttribute('aria-label')).toMatch(/light/i);
  });

  it('resolves an explicit preference to its palette', () => {
    useThemeStore.setState({ preference: 'dark', theme: 'graphite' });
    render(<ThemeToggle />);

    fireEvent.click(screen.getByRole('button'));
    expect(useThemeStore.getState().preference).toBe('system');
  });
});
