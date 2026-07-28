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

  it('keeps the steel magnifier stroke hard-coded (the AI signal must NOT inherit)', () => {
    const { container } = render(<Logo />);
    const steels = container.querySelectorAll('[stroke="#6ea8ff"], [stroke="#6EA8FF"]');
    expect(steels.length).toBe(2);
  });

  // The mark is mirrored in public/*.svg and the generated favicons, which
  // render with no CSS custom properties available — so the retired honey
  // values must not survive anywhere in the component either.
  it('carries no retired honey-palette values', () => {
    const { container } = render(<Logo />);
    const markup = container.innerHTML.toLowerCase();
    for (const retired of ['#f9c74f', '#fff8e9', '#1a1a1a']) {
      expect(markup).not.toContain(retired);
    }
  });

  it('forwards className to the root svg', () => {
    const { container } = render(<Logo className="h-8 w-auto text-foreground" />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('class')).toContain('h-8');
    expect(svg.getAttribute('class')).toContain('text-foreground');
  });
});
