import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { PagesAliasRedirect } from '../../App';

/**
 * `/pages` is a legacy alias for the overview at `/`. Since #1124 the
 * overview's filter, search, sort and page state lives in the query string, so
 * a bare `<Navigate to="/">` would quietly turn a shared
 * `/pages?source=confluence` link into an unfiltered one.
 */
function Probe() {
  const location = useLocation();
  return <span data-testid="location">{location.pathname + location.search}</span>;
}

function renderAt(entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/" element={<Probe />} />
        <Route path="/pages" element={<PagesAliasRedirect />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('PagesAliasRedirect (#1124)', () => {
  it('redirects /pages to /', () => {
    renderAt('/pages');
    expect(screen.getByTestId('location')).toHaveTextContent('/');
  });

  it('carries the query string over', () => {
    renderAt('/pages?source=confluence&sort=quality&author=Alice');
    expect(screen.getByTestId('location').textContent)
      .toBe('/?source=confluence&sort=quality&author=Alice');
  });

  it('preserves params it does not own', () => {
    renderAt('/pages?search=runbook&focus=42');
    expect(screen.getByTestId('location').textContent).toBe('/?search=runbook&focus=42');
  });

  it('leaves a bare alias bare', () => {
    renderAt('/pages');
    expect(screen.getByTestId('location').textContent).toBe('/');
  });
});
