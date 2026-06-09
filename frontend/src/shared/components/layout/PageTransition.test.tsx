import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PageTransition, routeDepth } from './PageTransition';

function Wrapper({ children, initialPath = '/' }: { children: React.ReactNode; initialPath?: string }) {
  return (
    <MemoryRouter initialEntries={[initialPath]}>{children}</MemoryRouter>
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

  it('renders new content after navigation', () => {
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

  it('is a no-op pass-through — no AnimatePresence / motion machinery', async () => {
    // Regression guard for two consecutive black-article-area bugs caused
    // by framer-motion-based route transitions in this component:
    //   - mode="sync" left an exit layer at position:absolute that blocked
    //     clicks (#660).
    //   - mode="wait" left the exit layer stuck at opacity:0 indefinitely
    //     so the new layer never mounted (#669, this fix).
    // The animation isn't worth the bug surface. Re-introduce only with a
    // behavioral test that asserts the exit layer actually unmounts in jsdom.
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const url = await import('node:url');
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const src = await fs.readFile(path.join(here, 'PageTransition.tsx'), 'utf-8');
    // Strip block + line comments so explanatory text doesn't trip the
    // matchers (the JSDoc above PageTransition intentionally names the
    // banned symbols as a warning to future editors).
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/AnimatePresence/);
    expect(code).not.toMatch(/from\s+['"]framer-motion['"]/);
    expect(code).not.toMatch(/\bm\.div\b/);
    expect(code).not.toMatch(/useState\b/);
  });
});
