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

  // Not "the AI signal" —
  // the magnifier stroke is the brand accent. Violet is the AI signal, and the
  // mark identifies the product rather than labelling an AI affordance. The
  // distinction matters because it is the reason the stroke must NOT inherit:
  // an identity is fixed, a control's colour follows its meaning.
  it('keeps the Steel magnifier stroke hard-coded rather than inheriting', () => {
    const { container } = render(<Logo />);
    const accents = container.querySelectorAll('[stroke="#86aec8"], [stroke="#86AEC8"]');
    expect(accents.length).toBe(2);
  });

  // The mark is mirrored in public/*.svg and the generated favicons, which
  // render with no CSS custom properties available — so no retired palette
  // value may survive anywhere in the component either. Steel joined honey on
  // that list once the accent moved away from the legacy Steel pair; both generations shipped a mark
  // that lagged the palette, which is why this list only ever grows.
  // `src/logo-color-parity.test.ts` checks the four mirrors on disk.
  it('carries no retired palette values', () => {
    const { container } = render(<Logo />);
    const markup = container.innerHTML.toLowerCase();
    for (const retired of [
      '#f9c74f', '#fff8e9', '#1a1a1a', // honey
      '#6ea8ff', '#e8ecf5', '#151b2c', // steel
    ]) {
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
