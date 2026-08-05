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
  // min-h-0 is one link of a four-link chain (#1218). A flex item's automatic
  // minimum size (`min-height: auto`) refuses to shrink below its content, so
  // this wrapper alone kept the /ai column growing to its content and made
  // AppLayout's scroll container — not the message pane — the thing that
  // scrolls. The chain is:
  //   AppLayout scroll container -> PageTransition -> AppLayout's max-width
  //   wrapper -> AiAssistantPage's page root -> the pane's own scroller.
  // Every link is load-bearing; three of four fixes nothing. Guarded by name
  // in `src/ai-scroll-chain.test.ts`.
  //
  // Routes that don't cap their own height still scroll: their content
  // overflows this box with `overflow: visible`, which still contributes to
  // the scroll container's scrollable overflow. The one measured difference
  // there is the container's end padding, written up where that padding is
  // declared, in AppLayout.
  return <div className="flex min-h-0 flex-1 flex-col">{children}</div>;
}

// eslint-disable-next-line react-refresh/only-export-components
export { routeDepth };
