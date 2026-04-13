import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LazyMotion, domAnimation } from 'framer-motion';
import { PageTransition, routeDepth } from './PageTransition';

function Wrapper({ children, initialPath = '/' }: { children: React.ReactNode; initialPath?: string }) {
  return (
    <MemoryRouter initialEntries={[initialPath]}>
      <LazyMotion features={domAnimation}>
        {children}
      </LazyMotion>
    </MemoryRouter>
  );
}

describe('routeDepth', () => {
  it('returns 0 for root path', () => {
    expect(routeDepth('/')).toBe(0);
  });

  it('returns 0 for /ai', () => {
    expect(routeDepth('/ai')).toBe(0);
  });

  it('returns 0 for /settings', () => {
    expect(routeDepth('/settings')).toBe(0);
  });

  it('returns 0 for /login', () => {
    expect(routeDepth('/login')).toBe(0);
  });

  it('returns 1 for /pages/:id', () => {
    expect(routeDepth('/pages/abc-123')).toBe(1);
  });

  it('returns 1 for /pages/new', () => {
    expect(routeDepth('/pages/new')).toBe(1);
  });

  it('returns 0 for unknown paths', () => {
    expect(routeDepth('/unknown')).toBe(0);
  });
});

describe('PageTransition', () => {
  it('renders children', () => {
    render(
      <Wrapper>
        <PageTransition>
          <div data-testid="child-content">Hello</div>
        </PageTransition>
      </Wrapper>,
    );
    expect(screen.getByTestId('child-content')).toBeInTheDocument();
    expect(screen.getByText('Hello')).toBeInTheDocument();
  });

  it('wraps children in a motion div', () => {
    render(
      <Wrapper>
        <PageTransition>
          <span>Test content</span>
        </PageTransition>
      </Wrapper>,
    );
    const content = screen.getByText('Test content');
    // The content should be wrapped in a div (the m.div from PageTransition)
    expect(content.parentElement).toBeInstanceOf(HTMLDivElement);
  });

  it('sets will-change style for GPU compositing', () => {
    render(
      <Wrapper>
        <PageTransition>
          <span>GPU test</span>
        </PageTransition>
      </Wrapper>,
    );
    const content = screen.getByText('GPU test');
    const motionDiv = content.closest('div[style]');
    expect(motionDiv).not.toBeNull();
  });

  it('mounts new content immediately on navigation (mode=sync)', () => {
    // mode="sync" ensures the entering page mounts right away instead of
    // waiting 220ms for the exiting page to finish its animation.
    const { rerender } = render(
      <Wrapper initialPath="/">
        <PageTransition>
          <div data-testid="page-a">Page A</div>
        </PageTransition>
      </Wrapper>,
    );
    expect(screen.getByTestId('page-a')).toBeInTheDocument();

    rerender(
      <Wrapper initialPath="/pages/123">
        <PageTransition>
          <div data-testid="page-b">Page B</div>
        </PageTransition>
      </Wrapper>,
    );
    // New content must be in the DOM immediately, without waiting for exit animation
    expect(screen.getByTestId('page-b')).toBeInTheDocument();
  });

  it('renders at different initial paths without error', () => {
    render(
      <Wrapper initialPath="/pages/123">
        <PageTransition>
          <div>Page view</div>
        </PageTransition>
      </Wrapper>,
    );
    expect(screen.getByText('Page view')).toBeInTheDocument();
  });
});
