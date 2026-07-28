import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { NotFoundPage } from './NotFoundPage';

/** Renders the 404 at `path` and exposes wherever it navigates next. */
function renderAt(path: string) {
  function LocationProbe() {
    const location = useLocation();
    return <div data-testid="location">{location.pathname + location.search}</div>;
  }

  return render(
    <MemoryRouter initialEntries={[path]}>
      <LocationProbe />
      <Routes>
        <Route path="/" element={<div>dashboard</div>} />
        <Route path="/trash" element={<div>trash</div>} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('NotFoundPage', () => {
  it('names the path that failed instead of silently redirecting', () => {
    // The previous behaviour was `<Navigate to="/" replace />`, which threw
    // the URL away so the user could not see or correct the mistake.
    renderAt('/pages/does-not-exist');

    expect(screen.getByTestId('not-found-page')).toBeInTheDocument();
    expect(screen.getByTestId('not-found-path')).toHaveTextContent('/pages/does-not-exist');
    expect(screen.getByTestId('location')).toHaveTextContent('/pages/does-not-exist');
  });

  it('exposes a heading so the route change is announceable', () => {
    renderAt('/nope');

    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toHaveTextContent("This page doesn't exist");
  });

  it('hands the query to the pages list as a linkable search', () => {
    renderAt('/nope');

    fireEvent.change(screen.getByTestId('not-found-search'), {
      target: { value: 'deployment runbook' },
    });
    fireEvent.click(screen.getByRole('button', { name: /search/i }));

    expect(screen.getByTestId('location')).toHaveTextContent('/?search=deployment%20runbook');
  });

  it('goes to the unfiltered list when the query is blank', () => {
    renderAt('/nope');

    fireEvent.change(screen.getByTestId('not-found-search'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: /search/i }));

    expect(screen.getByTestId('location')).toHaveTextContent('/');
    expect(screen.getByTestId('location')).not.toHaveTextContent('search=');
  });

  it('offers recovery links to the two places a missing page might be', () => {
    renderAt('/nope');

    expect(screen.getByTestId('not-found-pages-link')).toHaveAttribute('href', '/');
    expect(screen.getByTestId('not-found-trash-link')).toHaveAttribute('href', '/trash');
  });

  it('labels the search field for assistive tech', () => {
    renderAt('/nope');
    expect(screen.getByLabelText('Search pages')).toBeInTheDocument();
  });
});
