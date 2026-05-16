import { type ReactNode, useRef, useState, useMemo, useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { AnimatePresence, m } from 'framer-motion';
import { useReducedMotion } from 'framer-motion';

/**
 * Route-depth ordering used to infer navigation direction:
 *   /          -> 0  (Pages list)
 *   /pages/new -> 1  (New page)
 *   /pages/:id -> 1  (Page view)
 *   /ai        -> 0  (AI assistant)
 *   /settings  -> 0  (Settings)
 *
 * Forward = depth increases (list -> detail).
 * Backward = depth decreases (detail -> list).
 * Same depth = fade only (no slide).
 */
function routeDepth(pathname: string): number {
  if (pathname === '/' || pathname === '/ai' || pathname === '/settings' || pathname === '/login') {
    return 0;
  }
  // /pages/new or /pages/:id
  if (pathname.startsWith('/pages/')) {
    return 1;
  }
  return 0;
}

const DURATION = 0.22; // 220ms - fast but perceivable

interface PageTransitionProps {
  children: ReactNode;
}

/**
 * Wraps route content with AnimatePresence to provide smooth enter/exit
 * transitions when navigating between pages.
 *
 * - Forward navigation (e.g. list -> detail): slides left
 * - Backward navigation (e.g. detail -> list): slides right
 * - Same-level navigation: fade only
 * - Respects prefers-reduced-motion: falls back to simple opacity fade
 */
export function PageTransition({ children }: PageTransitionProps) {
  const location = useLocation();
  const reducedMotion = useReducedMotion();
  const prevDepthRef = useRef(routeDepth(location.pathname));
  const [animating, setAnimating] = useState(false);

  // Compute direction synchronously during render so animation reads
  // the correct value on the same frame the location changes.
  // Note: prevDepthRef is updated in a commit-phase effect below to avoid
  // mutating a ref inside useMemo (which can re-run in React 19 + StrictMode
  // and corrupt the direction calculation).
  const direction = useMemo<'forward' | 'backward' | 'neutral'>(() => {
    const currentDepth = routeDepth(location.pathname);
    const prevDepth = prevDepthRef.current;

    if (currentDepth > prevDepth) return 'forward';
    if (currentDepth < prevDepth) return 'backward';
    return 'neutral';
  }, [location.pathname]);

  useEffect(() => {
    prevDepthRef.current = routeDepth(location.pathname);
  }, [location.pathname]);

  // Slide offset based on direction (GPU-composited via translateX)
  const slideX = reducedMotion
    ? 0
    : direction === 'forward'
      ? 40
      : direction === 'backward'
        ? -40
        : 0;

  return (
    <div className="flex flex-1 flex-col" style={{ position: 'relative' }}>
      <AnimatePresence mode="wait" initial={false}>
        <m.div
          key={location.pathname}
          initial={{ opacity: 0, x: slideX }}
          animate={{ opacity: 1, x: 0 }}
          // mode="wait" + simple opacity/x exit: the previous layer must finish
          // exiting before the new one mounts, so the two layers never overlap.
          // This prevents the back/forward race where an interrupted exit could
          // leave a layer stuck in the DOM with pointer-events:none, blocking
          // all clicks on the visually-current page.
          exit={{ opacity: 0, x: -slideX }}
          transition={{
            duration: reducedMotion ? 0.1 : DURATION,
            ease: [0.25, 0.1, 0.25, 1], // cubic-bezier for smooth deceleration
          }}
          className="flex w-full flex-1 flex-col"
          style={animating ? { willChange: 'opacity, transform' } : undefined}
          onAnimationStart={() => setAnimating(true)}
          onAnimationComplete={() => setAnimating(false)}
        >
          {children}
        </m.div>
      </AnimatePresence>
    </div>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export { routeDepth };
