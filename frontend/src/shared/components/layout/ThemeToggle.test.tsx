import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ThemeToggle } from './ThemeToggle';
import { useThemeStore } from '../../../stores/theme-store';

describe('ThemeToggle', () => {
  beforeEach(() => {
    useThemeStore.setState({ theme: 'slate-steel' });
  });

  it('renders a button with accessible label', () => {
    render(<ThemeToggle />);
    const btn = screen.getByRole('button');
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveAttribute('aria-label');
  });

  it('shows "Switch to light mode" label when in dark theme', () => {
    useThemeStore.setState({ theme: 'slate-steel' });
    render(<ThemeToggle />);
    expect(screen.getByRole('button')).toHaveAttribute('aria-label', 'Switch to light mode');
  });

  it('shows "Switch to dark mode" label when in light theme', () => {
    useThemeStore.setState({ theme: 'frost-steel' });
    render(<ThemeToggle />);
    expect(screen.getByRole('button')).toHaveAttribute('aria-label', 'Switch to dark mode');
  });

  it('switches from dark to light on click', () => {
    useThemeStore.setState({ theme: 'slate-steel' });
    render(<ThemeToggle />);
    fireEvent.click(screen.getByRole('button'));
    expect(useThemeStore.getState().theme).toBe('frost-steel');
  });

  it('switches from light to dark on click', () => {
    useThemeStore.setState({ theme: 'frost-steel' });
    render(<ThemeToggle />);
    fireEvent.click(screen.getByRole('button'));
    expect(useThemeStore.getState().theme).toBe('slate-steel');
  });
});
