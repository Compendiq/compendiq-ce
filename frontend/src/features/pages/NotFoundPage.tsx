import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Compass, Search, FileText, Trash2 } from 'lucide-react';

/**
 * Real 404, replacing a silent `<Navigate to="/" replace />`.
 *
 * The redirect teleported anyone with a stale bookmark to the dashboard with
 * no explanation and destroyed the URL on the way, so the mistake was neither
 * visible nor correctable. Screen-reader users got no announcement at all,
 * since a route swap with no focus or live-region change is silent.
 *
 * This states the path that failed, offers a search scoped to pages, and links
 * to the two places a missing page is most likely to actually be.
 */
export function NotFoundPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = query.trim();
    // PagesPage reads `?search=` on mount, so this lands on real results
    // rather than just dumping the user on an unfiltered dashboard.
    navigate(trimmed ? `/?search=${encodeURIComponent(trimmed)}` : '/');
  };

  return (
    <div
      className="mx-auto flex max-w-xl flex-col items-center px-4 py-16 text-center"
      data-testid="not-found-page"
    >
      {/* The heading — not the icon — is the announcement target: role="alert"
          on a decorative glyph would read as noise. */}
      <div className="mb-5 rounded-2xl bg-foreground/5 p-4 text-muted-foreground">
        <Compass size={32} aria-hidden="true" />
      </div>

      <h1 className="text-lg font-semibold tracking-[-0.01em]" tabIndex={-1}>
        This page doesn&apos;t exist
      </h1>

      <p className="mt-3 text-sm text-muted-foreground">
        Nothing is routed at{' '}
        <code
          className="rounded bg-foreground/5 px-1.5 py-0.5 font-mono text-[13px] text-foreground"
          data-testid="not-found-path"
        >
          {location.pathname}
        </code>
        . It may have been moved, deleted, or mistyped.
      </p>

      <form onSubmit={handleSearch} className="mt-7 flex w-full max-w-sm gap-2">
        <label htmlFor="not-found-search" className="sr-only">
          Search pages
        </label>
        <div className="relative flex-1">
          <Search
            size={15}
            aria-hidden="true"
            className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <input
            id="not-found-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search for the page you wanted"
            className="nm-input pl-9"
            data-testid="not-found-search"
          />
        </div>
        <button type="submit" className="nm-button-primary shrink-0">
          Search
        </button>
      </form>

      <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
        <Link
          to="/"
          className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          data-testid="not-found-pages-link"
        >
          <FileText size={15} aria-hidden="true" />
          All pages
        </Link>
        <Link
          to="/trash"
          className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          data-testid="not-found-trash-link"
        >
          <Trash2 size={15} aria-hidden="true" />
          Trash
        </Link>
      </div>
    </div>
  );
}
