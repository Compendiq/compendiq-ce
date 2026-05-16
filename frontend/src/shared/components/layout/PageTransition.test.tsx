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

  it('renders new content after navigation', () => {
    // Under mode="wait" the exiting layer must finish before the new one
    // mounts. In jsdom animations resolve synchronously, so a rerender
    // immediately yields the new content — this test guards against a
    // regression where the new content never appears at all (e.g. a stuck
    // exit, or AnimatePresence dropping the entering child).
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

  it('uses AnimatePresence mode="wait" so exiting and entering layers never overlap', async () => {
    // Regression test for the Pages-list click-stuck bug. With mode="sync"
    // the exiting page sat absolutely positioned over the new one for ~220 ms.
    // If the same key (location.pathname) reappeared mid-exit (rapid
    // back/forward), framer-motion could cancel the exit but leave the
    // inline exit styles (position: absolute; pointer-events: none) applied
    // to a child that then rendered the current route's content — making
    // every visible article unclickable.
    //
    // The fix is mode="wait": the previous layer must finish exiting before
    // the next mounts, so the two layers never overlap and the race is
    // impossible. Read the source directly so the test fails loudly if the
    // mode is reverted by a future refactor.
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const url = await import('node:url');
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const src = await fs.readFile(path.join(here, 'PageTransition.tsx'), 'utf-8');
    expect(src).toMatch(/<AnimatePresence[^>]*mode=["']wait["']/);
    // The old workaround must not creep back in: with mode="wait" there is
    // no overlap, so position:absolute / pointer-events:none on exit would
    // only mask the wrong fix.
    expect(src).not.toMatch(/exit=\{[^}]*pointerEvents:\s*['"]none['"]/);
    expect(src).not.toMatch(/exit=\{[^}]*position:\s*['"]absolute['"]/);
  });

  it('updates prevDepthRef via a commit-phase effect, not inside useMemo', async () => {
    // Mutating a ref inside useMemo is unsafe in React 19 + StrictMode:
    // memos may re-run with the same deps, double-mutating the ref and
    // corrupting the previous-depth tracking that drives slide direction.
    // The ref update must live in useEffect so it runs exactly once per
    // commit. Regression test in source form.
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const url = await import('node:url');
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const src = await fs.readFile(path.join(here, 'PageTransition.tsx'), 'utf-8');
    // prevDepthRef.current = ... must appear inside a useEffect, never inside useMemo.
    const memoBlock = src.match(/useMemo<[^>]*>\(\(\)\s*=>\s*\{[\s\S]*?\}\s*,\s*\[location\.pathname\]\)/);
    expect(memoBlock).toBeTruthy();
    expect(memoBlock![0]).not.toMatch(/prevDepthRef\.current\s*=/);
    expect(src).toMatch(/useEffect\(\(\)\s*=>\s*\{\s*prevDepthRef\.current\s*=/);
  });
});
