import { useState, useEffect } from 'react';

/**
 * Returns true when the device has a fine pointer that supports hover.
 * Touch-only devices return false, preventing cursor-dependent effects.
 *
 * Also returns false when prefers-reduced-motion is set to "reduce".
 */
export function useCanHover(): boolean {
  const [canHover, setCanHover] = useState(() => {
    if (typeof window === 'undefined') return false;
    const hoverQuery = window.matchMedia('(hover: hover)');
    const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    return hoverQuery.matches && !motionQuery.matches;
  });

  useEffect(() => {
    const hoverQuery = window.matchMedia('(hover: hover)');
    const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

    const update = () => {
      setCanHover(hoverQuery.matches && !motionQuery.matches);
    };

    hoverQuery.addEventListener('change', update);
    motionQuery.addEventListener('change', update);
    return () => {
      hoverQuery.removeEventListener('change', update);
      motionQuery.removeEventListener('change', update);
    };
  }, []);

  return canHover;
}
