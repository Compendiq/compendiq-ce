import { useEffect, useRef } from 'react';

/**
 * Close a dropdown/popover when clicking outside or pressing Escape.
 *
 * Attach the returned ref to the container that should be considered "inside".
 * Uses `mousedown` (not `click`) so the dropdown closes before the click
 * event reaches other handlers — avoiding event-ordering issues.
 *
 * The callback is stored in a ref so that passing an inline function does not
 * cause the effect to re-register listeners on every render.
 *
 * LIMITATION: For Radix UI portals (Select, Popover), portal-rendered
 * content lives outside the ref's DOM subtree. Clicks on portal options
 * will trigger the outside-click handler. For portal-based components,
 * use Radix's built-in onOpenChange instead.
 */
export function useClickOutside<T extends HTMLElement>(
  callback: () => void,
  enabled = true,
) {
  const ref = useRef<T>(null);
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    if (!enabled) return;

    function handleMouseDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        callbackRef.current();
      }
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        callbackRef.current();
      }
    }

    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [enabled]);

  return ref;
}
