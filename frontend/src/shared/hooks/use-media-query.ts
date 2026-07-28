import { useState, useEffect } from 'react';

/**
 * Subscribe to a CSS media query from JS.
 *
 * Every other responsive decision in this app is a Tailwind class, and that is
 * still the right default — reach for this only when the *component tree* has
 * to change, not just its styling. The docked assistant (#1126) is the first
 * such case: below the wide breakpoint the article rail is not restyled, it is
 * not rendered, because a 40px rail plus a 420px dock starves the editor.
 *
 * Cleanup mirrors `use-can-hover.ts`, which is the existing template here.
 *
 * In jsdom, `test-setup.ts` answers `min-width` / `max-width` queries from
 * `window.innerWidth` (default 1024), so a suite that needs the wide layout
 * sets `window.innerWidth` before rendering.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mql = window.matchMedia(query);
    const update = () => setMatches(mql.matches);
    // Re-read on subscribe: the query may have changed between the initial
    // render and this effect (a resize during hydration, or a changed `query`).
    update();
    mql.addEventListener('change', update);
    return () => mql.removeEventListener('change', update);
  }, [query]);

  return matches;
}

/**
 * Width at which the article column can still carry the 40px rail *and* the
 * docked assistant without the reading measure collapsing. Below it the dock
 * takes the whole right pane and the rail steps aside (#1126).
 */
export const DOCK_WIDE_QUERY = '(min-width: 1100px)';

/** True when there is room for the rail and the dock side by side. */
export function useIsDockWideLayout(): boolean {
  return useMediaQuery(DOCK_WIDE_QUERY);
}

/**
 * Tailwind's `md` breakpoint, as a query. Kept as the *positive* min-width form
 * rather than a `max-width: 767.98px` negation so it matches `@media (width >=
 * 48rem)` exactly at the boundary — 768px is desktop in both.
 */
export const MD_QUERY = '(min-width: 768px)';

/**
 * True below `md`, where the shell has no right pane to dock into and the
 * assistant becomes a bottom sheet over the article instead (#1126).
 */
export function useIsMobileLayout(): boolean {
  return !useMediaQuery(MD_QUERY);
}
