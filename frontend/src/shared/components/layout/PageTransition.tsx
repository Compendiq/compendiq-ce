import type { ReactNode } from 'react';

/**
 * Route-depth ordering preserved for tests + any future use. Not currently
 * consumed by this component because the AnimatePresence-based slide+fade
 * was removed (see below).
 *
 *   /          -> 0  (Pages list)
 *   /pages/new -> 1  (New page)
 *   /pages/:id -> 1  (Page view)
 *   /ai        -> 0  (AI assistant)
 *   /settings  -> 0  (Settings)
 */
function routeDepth(pathname: string): number {
  if (pathname === '/' || pathname === '/ai' || pathname === '/settings' || pathname === '/login') {
    return 0;
  }
  if (pathname.startsWith('/pages/')) {
    return 1;
  }
  return 0;
}

interface PageTransitionProps {
  children: ReactNode;
}

/**
 * Pass-through wrapper. Previously ran a slide+fade via AnimatePresence
 * (mode="sync" in #389, mode="wait" in #660). Both modes produced
 * reproducible black-page bugs under framer-motion 12 + React 19:
 *   - mode="sync": stuck exit layer with position:absolute blocked clicks
 *     on the live page (#660).
 *   - mode="wait": exit completed but the layer never unmounted, so the
 *     new layer never mounted — fully black article area on sidebar click.
 *     Multiple attempted fixes (#668, #669) didn't resolve it.
 * The route transition is a nice-to-have, not load-bearing. Removing the
 * machinery eliminates the bug surface. Re-introduce only with a fully
 * reproduced, behavioral test that asserts the exit layer unmounts.
 */
export function PageTransition({ children }: PageTransitionProps) {
  return <div className="flex flex-1 flex-col">{children}</div>;
}

// eslint-disable-next-line react-refresh/only-export-components
export { routeDepth };
