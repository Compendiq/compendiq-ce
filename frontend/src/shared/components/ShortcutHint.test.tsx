import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ShortcutHint } from './ShortcutHint';

describe('ShortcutHint', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the formatted key for a known shortcut id', () => {
    // jsdom navigator.platform defaults to empty string (non-Mac)
    render(<ShortcutHint shortcutId="search" />);
    const kbd = screen.getByText('Ctrl+K');
    expect(kbd).toBeInTheDocument();
    expect(kbd.tagName).toBe('KBD');
  });

  it('returns null for an unknown shortcut id', () => {
    const { container } = render(<ShortcutHint shortcutId="nonexistent" />);
    expect(container.innerHTML).toBe('');
  });

  it('renders alt+n for the new-page shortcut on non-Mac', () => {
    render(<ShortcutHint shortcutId="new-page" />);
    expect(screen.getByText('Alt+N')).toBeInTheDocument();
  });

  it('renders Mac symbols when userAgent indicates Mac', () => {
    // Override navigator.userAgent (fallback path)
    const originalUA = navigator.userAgent;
    Object.defineProperty(navigator, 'userAgent', {
      value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      configurable: true,
    });

    render(<ShortcutHint shortcutId="search" />);
    // On Mac, ctrl+k becomes Command symbol + K
    expect(screen.getByText('\u2318K')).toBeInTheDocument();

    // Restore
    Object.defineProperty(navigator, 'userAgent', {
      value: originalUA,
      configurable: true,
    });
  });

  it('renders Mac symbols when userAgentData indicates macOS', () => {
    // Simulate the modern userAgentData API
    Object.defineProperty(navigator, 'userAgentData', {
      value: { platform: 'macOS' },
      configurable: true,
    });

    render(<ShortcutHint shortcutId="search" />);
    expect(screen.getByText('\u2318K')).toBeInTheDocument();

    // Restore
    Object.defineProperty(navigator, 'userAgentData', {
      value: undefined,
      configurable: true,
    });
  });

  it('applies additional className', () => {
    render(<ShortcutHint shortcutId="search" className="custom-class" />);
    const kbd = screen.getByText('Ctrl+K');
    expect(kbd.className).toContain('custom-class');
  });
});
