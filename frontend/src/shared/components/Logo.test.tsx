import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Logo } from './Logo';

describe('Logo', () => {
  it('renders an accessible image with role and aria-label', () => {
    const { getByRole } = render(<Logo />);
    const svg = getByRole('img', { name: /compendiq/i });
    expect(svg.tagName.toLowerCase()).toBe('svg');
  });

  it('uses currentColor for the wordmark fill so it inherits text color in both themes', () => {
    const { container } = render(<Logo className="text-foreground" />);
    const svg = container.querySelector('svg')!;
    const wordmark = svg.querySelector('text');
    expect(wordmark).not.toBeNull();
    expect(wordmark!.getAttribute('fill')).toBe('currentColor');
  });

  it('keeps the amber magnifier stroke hard-coded (the AI signal must NOT inherit)', () => {
    const { container } = render(<Logo />);
    const ambers = container.querySelectorAll('[stroke="#f9c74f"], [stroke="#F9C74F"]');
    expect(ambers.length).toBe(2);
  });

  it('forwards className to the root svg', () => {
    const { container } = render(<Logo className="h-8 w-auto text-foreground" />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('class')).toContain('h-8');
    expect(svg.getAttribute('class')).toContain('text-foreground');
  });
});
