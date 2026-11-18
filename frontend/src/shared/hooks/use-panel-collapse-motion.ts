import { useState } from 'react';

export const PANEL_COLLAPSE_TRANSITION = {
  type: 'tween' as const,
  duration: 0.38,
  ease: [0.22, 1, 0.36, 1] as const,
};

/**
 * Returns Framer Motion `initial` targets for a collapsible sidebar/inspector
 * panel so route mounts render open or closed immediately (no opening wipe
 * when switching main pages), while user-driven collapse/expand toggles
 * animate smoothly between `collapsedWidth` and `expandedWidth`.
 */
export function usePanelCollapseInitial(
  collapsed: boolean,
  expandedWidth: number,
  collapsedWidth: number,
  reduceEffects: boolean | null,
): {
  collapsedInitial: false | { width: number; opacity: number };
  expandedInitial: false | { width: number; opacity: number };
} {
  const [prevCollapsed, setPrevCollapsed] = useState(collapsed);
  const [animatingDirection, setAnimatingDirection] = useState<'open' | 'close' | null>(null);

  if (prevCollapsed !== collapsed) {
    setPrevCollapsed(collapsed);
    setAnimatingDirection(collapsed ? 'close' : 'open');
  }

  if (reduceEffects || animatingDirection === null) {
    return { collapsedInitial: false, expandedInitial: false };
  }

  return {
    collapsedInitial:
      animatingDirection === 'close' ? { width: expandedWidth, opacity: 1 } : false,
    expandedInitial:
      animatingDirection === 'open' ? { width: collapsedWidth, opacity: 1 } : false,
  };
}
