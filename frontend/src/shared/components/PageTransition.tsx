import { type ReactNode, useRef, useEffect } from 'react';
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
  const directionRef = useRef<'forward' | 'backward' | 'neutral'>('neutral');

  useEffect(() => {
    const currentDepth = routeDepth(location.pathname);
    const prevDepth = prevDepthRef.current;

    if (currentDepth > prevDepth) {
      directionRef.current = 'forward';
    } else if (currentDepth < prevDepth) {
      directionRef.current = 'backward';
    } else {
      directionRef.current = 'neutral';
    }

    prevDepthRef.current = currentDepth;
  }, [location.pathname]);

  // Slide offset based on direction (GPU-composited via translateX)
  const getSlideX = () => {
    if (reducedMotion) return 0;
    const direction = directionRef.current;
    if (direction === 'forward') return 40;
    if (direction === 'backward') return -40;
    return 0;
  };

  return (
    <AnimatePresence mode="wait" initial={false}>
      <m.div
        key={location.pathname}
        initial={{ opacity: 0, x: getSlideX() }}
        animate={{ opacity: 1, x: 0 }}
        exit={{ opacity: 0, x: -getSlideX() }}
        transition={{
          duration: reducedMotion ? 0.1 : DURATION,
          ease: [0.25, 0.1, 0.25, 1], // cubic-bezier for smooth deceleration
        }}
        className="min-h-0 flex-1"
        style={{ willChange: 'opacity, transform' }}
      >
        {children}
      </m.div>
    </AnimatePresence>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export { routeDepth };
