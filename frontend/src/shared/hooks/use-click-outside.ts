import { useEffect, useRef } from 'react';

/**
 * Hook that calls `callback` when a click lands outside the referenced element
 * or the Escape key is pressed. Attach the returned ref to the container that
 * should be considered "inside".
 *
 * Uses `mousedown` (not `click`) so the dropdown closes before the click
 * event reaches other handlers — avoiding event-ordering issues.
 */
export function useClickOutside<T extends HTMLElement>(
  callback: () => void,
  enabled = true,
) {
  const ref = useRef<T>(null);

  useEffect(() => {
    if (!enabled) return;

    function handleMouseDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        callback();
      }
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        callback();
      }
    }

    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [callback, enabled]);

  return ref;
}
