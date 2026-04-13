import { type ReactNode, useRef, useState, useMemo } from 'react';
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
  const direction = useMemo(() => {
    const currentDepth = routeDepth(location.pathname);
    const prevDepth = prevDepthRef.current;

    let dir: 'forward' | 'backward' | 'neutral';
    if (currentDepth > prevDepth) {
      dir = 'forward';
    } else if (currentDepth < prevDepth) {
      dir = 'backward';
    } else {
      dir = 'neutral';
    }

    prevDepthRef.current = currentDepth;
    return dir;
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
    <div style={{ position: 'relative' }}>
      <AnimatePresence mode="sync" initial={false}>
        <m.div
          key={location.pathname}
          initial={{ opacity: 0, x: slideX }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -slideX, position: 'absolute', top: 0, left: 0, right: 0 }}
          transition={{
            duration: reducedMotion ? 0.1 : DURATION,
            ease: [0.25, 0.1, 0.25, 1], // cubic-bezier for smooth deceleration
          }}
          className="w-full"
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
