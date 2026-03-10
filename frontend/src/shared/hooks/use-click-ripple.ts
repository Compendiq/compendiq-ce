import { useCallback } from 'react';
import { useCanHover } from './use-can-hover';

/**
 * Returns a click handler that creates a Material-style glassmorphic ripple effect
 * at the click position. The ripple element is cleaned up after the animation completes.
 *
 * Disabled on touch devices and when prefers-reduced-motion is set.
 *
 * Usage:
 * ```tsx
 * const ripple = useClickRipple();
 * <button className="ripple-container" onClick={ripple}>Click me</button>
 * ```
 *
 * Requires the `.ripple-container` class on the element and the ripple CSS in index.css.
 */
export function useClickRipple() {
  const canHover = useCanHover();

  return useCallback(
    (e: React.MouseEvent<HTMLElement>) => {
      if (!canHover) return;

      const target = e.currentTarget;
      const rect = target.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      const ripple = document.createElement('span');
      ripple.className = 'ripple-effect';
      ripple.style.left = `${x}px`;
      ripple.style.top = `${y}px`;
      target.appendChild(ripple);

      ripple.addEventListener('animationend', () => {
        ripple.remove();
      });
    },
    [canHover],
  );
}
